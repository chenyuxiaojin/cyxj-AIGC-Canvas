import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import equal from "fast-deep-equal";
import { canvasPersistenceStorage as localForageStorage } from "@/lib/localforage-storage";
import { listCanvasProjects, saveCanvasProject, syncCanvasProjects } from "@/services/api/canvas-tasks";
import { fetchUserConfig } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";
import { isDesktopRuntime, loadDesktopCanvasProjects, loadDesktopCanvasDeletedIds, saveDesktopCanvasProject, restoreDesktopCanvasVersion, loadDesktopCanvasProject, canvasPersistenceError, CanvasPersistenceError } from "@/services/desktop-runtime";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { validateCanvasGraph } from "../utils/canvas-graph";
import type { CanvasAgentConfig, CanvasAssistantSession, CanvasConnection, CanvasNodeData, CanvasPendingAgentRequest, ViewportTransform } from "../types";
import {
    CANVAS_OPERATION_PROTOCOL_VERSION,
    applyCanvasOperationBatch,
    buildCanvasStructureOperations,
    createCanvasOperationState,
    migrateCanvasProject,
    rebindCanvasProjectIdentity,
    type CanvasOperationBatch,
    type CanvasOperationOutcome,
    type CanvasOperationState,
} from "../protocol/canvas-operation-protocol";

export type CanvasSidePanelState = {
    open: boolean;
    width: number;
};

export const DEFAULT_CANVAS_SIDE_PANEL: CanvasSidePanelState = { open: true, width: 320 };
export const DEFAULT_CANVAS_AGENT_PANEL: CanvasSidePanelState = { open: false, width: 390 };

export type CanvasProject = {
    __desktopRevision?: string;
    recoveryCopyOf?: string;
    quarantinedConnections?: Array<{ connection: CanvasConnection; reason: string }>;
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    agentConfig: CanvasAgentConfig | null;
    autoTitlePending: boolean;
    pendingAgentRequest?: CanvasPendingAgentRequest;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    sidePanel: CanvasSidePanelState;
    agentPanel: CanvasSidePanelState;
    operationState: CanvasOperationState;
};

export type CanvasSaveStatus = { state: "pending" | "saving" | "saved" | "error" | "conflict" | "resolving"; error?: string; code?: string };
export type CanvasSaveComparison = {
    draftToken: string; latestRevision: string | null; localTime: string; latestTime: string | null;
    localNodes: number; latestNodes: number; localConnections: number; latestConnections: number;
    nodes: { added: string[]; removed: string[]; changed: string[] };
    connections: { added: string[]; removed: string[]; changed: string[] };
    otherFields: string[];
};

type CanvasStore = {
    hydrated: boolean;
    desktopPersistenceStatus: "not_applicable" | "checking" | "database" | "error";
    desktopPersistenceError: string | null;
    projects: CanvasProject[];
    restoredRevisions: Record<string, string>;
    saveStatus: Record<string, CanvasSaveStatus>;
    inspectSaveConflict: (id: string) => Promise<CanvasSaveComparison>;
    resolveSaveConflict: (id: string, choice: "latest" | "copy", draftToken?: string, requestId?: string) => Promise<{ projectId: string; archiveKey: string }>;

    retrySave: (id: string) => Promise<void>;
    restoreVersion: (id: string, sequence: number, expectedRevision?: string) => Promise<void>;
    createProject: (title?: string, options?: { agentConfig?: CanvasAgentConfig; pendingAgentRequest?: CanvasPendingAgentRequest }) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "agentConfig" | "autoTitlePending" | "backgroundMode" | "showImageInfo" | "viewport" | "sidePanel" | "agentPanel" | "pendingAgentRequest">>) => void;
    applyOperationBatch: (batch: CanvasOperationBatch) => CanvasOperationOutcome<CanvasProject> | null;
    refreshFromDesktop: (projectId?: string) => Promise<void>;
    syncWithRemote: (token: string, syncEnabled: boolean) => Promise<void>;
    setSyncEnabled: (enabled: boolean) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
const CANVAS_STORE_INDEX_KEY = "infinite-canvas:canvas_store:index";
const CANVAS_PROJECT_PREFIX = "infinite-canvas:canvas_project:";
const UI_ONLY_PROJECT_KEYS = new Set(["viewport", "sidePanel", "agentPanel"]);
type PersistedCanvasState = Pick<CanvasStore, "projects">;
type CanvasStoreIndex = { version: 1; ids: string[] };
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let accountCanvasSyncEnabled = false;
const projectSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastWrittenProjects = new Map<string, CanvasProject>();
let canvasShardsReady = false;

const pendingProjects = new Map<string, CanvasProject>();
const saveChains = new Map<string, Promise<void>>();
const RECOVERY_INDEX = "infinite-canvas:recovery:index";
const RECOVERY_PREFIX = "infinite-canvas:recovery:project:";
const JOURNAL_PREFIX = "infinite-canvas:save-journal:";
const ARCHIVE_PREFIX = "infinite-canvas:save-archive:";
const journalChains = new Map<string, Promise<void>>();
const epochs = new Map<string, number>();
const draftVersions = new Map<string, number>();
const sessionId = nanoid();
const recoveredAdoptions = new Map<string, CanvasProject>();
const recoveredStatus = new Map<string, CanvasSaveStatus>();
let localPersistChain: Promise<void> = Promise.resolve();
const deletedDesktopIds = new Set<string>();
const restoringProjects = new Set<string>();

function saveStatus(id: string, state: CanvasSaveStatus["state"], error?: string, code?: string) {
    useCanvasStore.setState((store) => ({ saveStatus: { ...store.saveStatus, [id]: { state, error, code } } }));
}
function statusForError(id: string, error: unknown) {
    const parsed = canvasPersistenceError(error);
    const previous = useCanvasStore.getState().saveStatus[id]?.state;
    const conflict = ["REVISION_CONFLICT", "PROJECT_DELETED", "PROJECT_MISSING", "NOT_FOUND", "DRAFT_CHANGED"].includes(parsed.code) || previous === "conflict" || (previous === "resolving" && pendingProjects.has(id));
    saveStatus(id, conflict ? "conflict" : "error", parsed.message, parsed.code);
}
function sameContent(left: CanvasProject, right: CanvasProject) {
    const { __desktopRevision: _left, ...a } = left;
    const { __desktopRevision: _right, ...b } = right;
    return equal(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}
function draftToken(id: string) { return `${sessionId}:${draftVersions.get(id) || 0}`; }
function journalTask(id: string, action: () => Promise<void>) {
    const next = (journalChains.get(id) || Promise.resolve()).catch(() => undefined).then(action);
    journalChains.set(id, next);
    return next;
}
function checkpointPending(id: string) {
    return journalTask(id, async () => {
        const project = pendingProjects.get(id);
        if (project) {
            await localForageStorage.setItem(JOURNAL_PREFIX + id, JSON.stringify({ project, status: useCanvasStore.getState().saveStatus[id] }));
        } else {
            // Cache has already been persisted before acknowledging/removing a draft.
            await localForageStorage.removeItem(JOURNAL_PREFIX + id);
        }
        await localForageStorage.removeItem(RECOVERY_PREFIX + id);
    });
}
async function loadRecoveryProjects() {
    const raw = await localForageStorage.getItem(RECOVERY_INDEX);
    for (const id of (raw ? JSON.parse(raw) : []) as string[]) {
        const value = await localForageStorage.getItem(RECOVERY_PREFIX + id);
        if (value) pendingProjects.set(id, JSON.parse(value));
    }
    for (const key of (await localForageStorage.keys()).filter((key) => key.startsWith(JOURNAL_PREFIX))) {
        const value = await localForageStorage.getItem(key);
        if (!value) continue;
        const record = JSON.parse(value);
        const id = key.slice(JOURNAL_PREFIX.length);
        if (record.adopted) { pendingProjects.delete(id); recoveredAdoptions.set(id, record.project); continue; }
        pendingProjects.set(id, record.project);
        recoveredStatus.set(id, record.status?.state === "conflict" ? record.status : { state: "pending" });
    }
}
function conflictError(id: string) {
    const status = useCanvasStore.getState().saveStatus[id];
    return new CanvasPersistenceError(status?.code || "REVISION_CONFLICT", status?.error || "画布存在保存冲突，请选择最新版本或另存当前编辑。");
}
function flushProject(id: string): Promise<void> {
    const epoch = epochs.get(id) || 0;
    const task = (saveChains.get(id) || Promise.resolve()).catch(() => undefined).then(async () => {
        if (restoringProjects.has(id) || epoch !== (epochs.get(id) || 0)) return;
        if (useCanvasStore.getState().saveStatus[id]?.state === "conflict") throw conflictError(id);
        while (pendingProjects.has(id)) {
            const project = pendingProjects.get(id)!;
            try {
                await checkpointPending(id);
                validateCanvasGraph(project);
                if (deletedDesktopIds.has(id)) throw new CanvasPersistenceError("PROJECT_DELETED", "画布已删除，未保存内容可另存为副本。");
                saveStatus(id, "saving");
                let saved: CanvasProject;
                if (isDesktopRuntime()) saved = await saveDesktopCanvasProject(project);
                else {
                    const token = useUserStore.getState().token;
                    if (!token || !accountCanvasSyncEnabled) return;
                    saved = await saveCanvasProject(token, project);
                }
                if (epoch !== (epochs.get(id) || 0)) return; // Resolution owns this project now.
                if (!sameContent(saved, project)) throw new CanvasPersistenceError("REVISION_CONFLICT", "保存回执与提交内容不同，当前编辑已保留，请比较版本。");
                const revision = saved.__desktopRevision;
                const pending = pendingProjects.get(id);
                const next = pending === project ? saved : { ...pending!, __desktopRevision: revision };
                // Keep a recoverable acknowledged draft until cache and journal succeed.
                pendingProjects.set(id, next);
                useCanvasStore.setState((state) => ({ projects: state.projects.map((current) => current.id === id ? { ...current, __desktopRevision: revision } : current) }));
                await persistLocalProject(id);
                if (epoch !== (epochs.get(id) || 0)) return;
                if (pendingProjects.get(id) === next && pending === project) pendingProjects.delete(id);
                await checkpointPending(id);
                if (!pendingProjects.has(id)) saveStatus(id, "saved");
            } catch (error) {
                if (epoch !== (epochs.get(id) || 0)) return;
                statusForError(id, error);
                await checkpointPending(id).catch(() => undefined);
                throw error;
            }
        }
    });
    saveChains.set(id, task);
    return task;
}
function queueProjectSave(project: CanvasProject) {
    draftVersions.set(project.id, (draftVersions.get(project.id) || 0) + 1);
    const blocked = ["conflict", "resolving"].includes(useCanvasStore.getState().saveStatus[project.id]?.state);
    if (!blocked) saveStatus(project.id, "pending");
    if (!isDesktopRuntime() && (!useUserStore.getState().token || !accountCanvasSyncEnabled)) return;
    pendingProjects.set(project.id, project);
    void checkpointPending(project.id).catch((error) => { if (!blocked) statusForError(project.id, error); });
    cancelProjectSaves([project.id]);
    if (blocked || restoringProjects.has(project.id)) return;
    projectSaveTimers.set(project.id, setTimeout(() => {
        projectSaveTimers.delete(project.id);
        void flushProject(project.id).catch(() => undefined);
    }, 400));
}
async function readDesktopProjects(_localProjects: CanvasProject[]) {
    const [loaded, deletedIds] = await Promise.all([loadDesktopCanvasProjects<CanvasProject>(), loadDesktopCanvasDeletedIds()]);
    const desktopProjects = loaded.projects;
    deletedDesktopIds.clear();
    deletedIds.forEach((id) => deletedDesktopIds.add(id));
    const localProjects = useCanvasStore.getState().hydrated ? useCanvasStore.getState().projects : _localProjects;
    const desktopIds = new Set(desktopProjects.map((project) => project.id));
    const failedIds = new Set(loaded.failures.map((failure) => failure.id));
    for (const failure of loaded.failures) statusForError(failure.id, failure.error);
    for (const project of localProjects) {
        const id = project.id;
        if (restoringProjects.has(id)) continue;
        if (deletedDesktopIds.has(id)) {
            await localForageStorage.setItem("infinite-canvas:recovery:deleted:" + id, JSON.stringify(pendingProjects.get(id) || project));
            cancelProjectSaves([id]);
            if (pendingProjects.has(id)) statusForError(id, new CanvasPersistenceError("PROJECT_DELETED", "画布已删除，编辑已保留，可另存副本。"));
        } else if (!desktopIds.has(id) && !failedIds.has(id) && !pendingProjects.has(id)) {
            pendingProjects.set(id, project);
            statusForError(id, new CanvasPersistenceError("PROJECT_MISSING", "已保存的画布现已不存在，当前缓存可另存副本。"));
            await checkpointPending(id);
        }
    }
    for (const desktopProject of desktopProjects) {
        const id = desktopProject.id;
        if (restoringProjects.has(id) || saveChains.has(id) && useCanvasStore.getState().saveStatus[id]?.state === "saving") continue;
        const pending = pendingProjects.get(id);
        if (!pending) continue;
        if (sameContent(pending, desktopProject)) {
            // An exact committed write with a lost reply is safe to acknowledge.
            await localForageStorage.setItem(CANVAS_PROJECT_PREFIX + id, JSON.stringify(desktopProject));
            if (pendingProjects.get(id) !== pending) continue;
            pendingProjects.delete(id);
            await checkpointPending(id);
            saveStatus(id, "saved");
        } else if (pending.__desktopRevision !== desktopProject.__desktopRevision) {
            cancelProjectSaves([id]);
            statusForError(id, new CanvasPersistenceError("REVISION_CONFLICT", "画布已有其他修改，当前编辑已保留。"));
            await checkpointPending(id);
        }
    }
    useCanvasStore.setState({ desktopPersistenceStatus: "database", desktopPersistenceError: null });
    return mergeDesktopCanvasProjects(desktopProjects, localProjects.filter((project) => !deletedDesktopIds.has(project.id) || pendingProjects.has(project.id)));
}

function cancelProjectSaves(ids: string[]) {
    ids.forEach((id) => {
        const timer = projectSaveTimers.get(id);
        if (!timer) return;
        clearTimeout(timer);
        projectSaveTimers.delete(id);
    });
}

async function reconcileCanvasProjects(token: string, remoteProjects: CanvasProject[], localProjects: CanvasProject[]) {
    const remoteById = new Map(remoteProjects.map((project) => [project.id, project]));
    const missingProjects = localProjects.filter((project) => !remoteById.has(project.id));
    const existingLocalProjects = localProjects.filter((project) => remoteById.has(project.id));
    const projects = missingProjects.length
        ? await syncCanvasProjects(token, missingProjects)
              .then((syncedProjects) => mergeCanvasProjects(syncedProjects, existingLocalProjects))
              .catch(() => mergeCanvasProjects(remoteProjects, localProjects))
        : mergeCanvasProjects(remoteProjects, existingLocalProjects);

    localProjects.forEach((project) => {
        const remote = remoteById.get(project.id);
        if (remote && Date.parse(project.updatedAt || "") > Date.parse(remote.updatedAt || "")) {
            queueProjectSave(project);
        }
    });

    return projects;
}

function isUiOnlyProjectPatch(patch: object) {
    const keys = Object.keys(patch);
    return keys.length > 0 && keys.every((key) => UI_ONLY_PROJECT_KEYS.has(key));
}

function rememberWrittenProjects(projects: CanvasProject[]) {
    lastWrittenProjects.clear();
    projects.forEach((project) => lastWrittenProjects.set(project.id, project));
}

function projectNeedsWrite(project: CanvasProject) {
    const previous = lastWrittenProjects.get(project.id);
    if (!previous) return true;
    return (
        previous !== project &&
        (previous.__desktopRevision !== project.__desktopRevision ||
            previous.operationState !== project.operationState ||
            previous.updatedAt !== project.updatedAt ||
            previous.title !== project.title ||
            previous.nodes !== project.nodes ||
            previous.connections !== project.connections ||
            previous.chatSessions !== project.chatSessions ||
            previous.activeChatId !== project.activeChatId ||
            previous.agentConfig !== project.agentConfig ||
            previous.autoTitlePending !== project.autoTitlePending ||
            previous.backgroundMode !== project.backgroundMode ||
            previous.showImageInfo !== project.showImageInfo ||
            previous.pendingAgentRequest !== project.pendingAgentRequest ||
            previous.viewport !== project.viewport || previous.sidePanel !== project.sidePanel || previous.agentPanel !== project.agentPanel)
    );
}

async function loadLocalProjects(): Promise<CanvasProject[]> {
    const indexValue = await localForageStorage.getItem(CANVAS_STORE_INDEX_KEY);
    if (indexValue) {
        const index = JSON.parse(indexValue) as CanvasStoreIndex;
        if (index?.version === 1 && Array.isArray(index.ids)) {
            const projects = (
                await Promise.all(
                    index.ids.map(async (id) => {
                        const raw = await localForageStorage.getItem(CANVAS_PROJECT_PREFIX + id);
                        return raw ? (JSON.parse(raw) as CanvasProject) : null;
                    }),
                )
            ).filter((project): project is CanvasProject => Boolean(project));
            canvasShardsReady = true;
            return projects;
        }
    }
    canvasShardsReady = false;
    const legacy = await localForageStorage.getItem(CANVAS_STORE_KEY);
    if (!legacy) return [];
    const parsed = JSON.parse(legacy) as StorageValue<CanvasStore>;
    return (parsed.state as PersistedCanvasState)?.projects || [];
}

function persistLocalProjects(projects: CanvasProject[]) {
    localPersistChain = localPersistChain.catch(() => undefined).then(() => writeLocalProjects(projects));
    return localPersistChain;
}

async function writeLocalProjects(projects: CanvasProject[]) {
    const dirty = canvasShardsReady ? projects.filter(projectNeedsWrite) : projects;
    const nextIds = new Set(projects.map((project) => project.id));
    const removedIds = Array.from(lastWrittenProjects.keys()).filter((id) => !nextIds.has(id));
    const results = await Promise.allSettled(dirty.map(async (project) => {
        validateCanvasGraph(project);
        await localForageStorage.setItem(CANVAS_PROJECT_PREFIX + project.id, JSON.stringify(project));
        lastWrittenProjects.set(project.id, project);
    }));
    results.forEach((result, index) => {
        if (result.status === "rejected") statusForError(dirty[index].id, result.reason);
    });
    try {
        await localForageStorage.setItem(CANVAS_STORE_INDEX_KEY, JSON.stringify({ version: 1, ids: projects.map((project) => project.id) } satisfies CanvasStoreIndex));
    } catch (error) {
        for (const project of dirty) if (useCanvasStore.getState().saveStatus[project.id]?.state !== "conflict") statusForError(project.id, error);
        throw error;
    }
    await Promise.all(removedIds.map((id) => localForageStorage.removeItem(CANVAS_PROJECT_PREFIX + id)));
    const failedIds = results.flatMap((result, index) => result.status === "rejected" ? [dirty[index].id] : []);
    if (failedIds.length) throw new CanvasPersistenceError("LOCAL_CACHE_FAILED", "本机缓存写入失败，编辑仍保留。", { projectIds: failedIds });
    rememberWrittenProjects(projects);
    canvasShardsReady = true;
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        await loadRecoveryProjects();
        const cached = await loadLocalProjects();
        const localProjects = [...new Map([...cached, ...recoveredAdoptions.values(), ...pendingProjects.values()].map((project) => [project.id, project])).values()];
        const token = useUserStore.getState().token;
        const localParsed = {
            state: { projects: localProjects },
            version: 0,
        } as StorageValue<CanvasStore>;
        const localHasData = localProjects.length > 0;

        if (isDesktopRuntime()) {
            try {
                const projects = await readDesktopProjects(localProjects);
                if (projects.length > 0 || localParsed) {
                    const nextState = { projects };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await persistLocalProjects(projects).catch(() => undefined);
                    for (const project of projects) if (!pendingProjects.has(project.id) && !useCanvasStore.getState().saveStatus[project.id]) saveStatus(project.id, "saved");
                    return parsed;
                }
            } catch (error) {
                console.error("Failed to hydrate desktop canvas projects", error);
            }
        }

        if (token) {
            try {
                const [userConfig, remoteProjects] = await Promise.all([fetchUserConfig(token), listCanvasProjects(token)]);
                accountCanvasSyncEnabled = userConfig.syncCapabilities?.userData === true;

                if (accountCanvasSyncEnabled && localHasData) {
                    const projects = await reconcileCanvasProjects(
                        token,
                        remoteProjects.map((project) => migrateCanvasProject(project)),
                        localProjects,
                    );

                    const nextState = { projects };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await persistLocalProjects(remoteProjects);
                    return parsed;
                }
            } catch (error) {
                console.error("Failed to hydrate canvas projects from remote", error);
            }
        }

        if (!localProjects.length) return null;
        queuedPersistState = localParsed.state as PersistedCanvasState;
        rememberWrittenProjects(localProjects);
        return localParsed;
    },

    setItem: (_name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) {
            return;
        }
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void persistLocalProjects(nextState.projects || []).then(() => {
                for (const project of nextState.projects || []) {
                    if (!pendingProjects.has(project.id) && useCanvasStore.getState().saveStatus[project.id]?.state !== "resolving" && useCanvasStore.getState().projects.find((p) => p.id === project.id) === project) saveStatus(project.id, "saved");
                }
            }).catch((error) => {
                const ids = (canvasPersistenceError(error).details as { projectIds?: string[] } | undefined)?.projectIds;
                for (const project of nextState.projects || []) if (!ids || ids.includes(project.id)) {
                    if (useCanvasStore.getState().saveStatus[project.id]?.state !== "conflict") statusForError(project.id, error);
                }
            });
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

function compareItems<T extends { id: string; title?: string }>(local: T[], latest: T[]) {
    const a = new Map(local.map((item) => [item.id, item]));
    const b = new Map(latest.map((item) => [item.id, item]));
    const label = (item: T) => item.title ? `${item.title} (${item.id})` : item.id;
    return {
        added: local.filter((item) => !b.has(item.id)).map(label),
        removed: latest.filter((item) => !a.has(item.id)).map(label),
        changed: local.filter((item) => b.has(item.id) && !equal(item, b.get(item.id))).map(label),
    };
}
async function inspectSaveConflict(id: string): Promise<CanvasSaveComparison> {
    const latest = isDesktopRuntime() ? await loadDesktopCanvasProject<CanvasProject>(id).catch((error) => {
        if (["NOT_FOUND", "PROJECT_DELETED"].includes(canvasPersistenceError(error).code)) return null;
        throw error;
    }) : null;
    const local = useCanvasStore.getState().openProject(id);
    if (!local) throw new Error("画布不存在");
    const excluded = new Set(["nodes", "connections", "__desktopRevision", "operationState", "updatedAt"]);
    return {
        draftToken: draftToken(id), latestRevision: latest?.__desktopRevision || null,
        localTime: local.updatedAt, latestTime: latest?.updatedAt || null,
        localNodes: local.nodes.length, latestNodes: latest?.nodes.length || 0,
        localConnections: local.connections.length, latestConnections: latest?.connections.length || 0,
        nodes: compareItems(local.nodes, latest?.nodes || []), connections: compareItems(local.connections, latest?.connections || []),
        otherFields: [...new Set([...Object.keys(local), ...Object.keys(latest || {})])].filter((key) => !excluded.has(key) && !equal(local[key as keyof CanvasProject], latest?.[key as keyof CanvasProject])),
    };
}
async function resolveSaveConflict(id: string, choice: "latest" | "copy", expectedToken?: string, requestId = nanoid()): Promise<{ projectId: string; archiveKey: string }> {
    if (restoringProjects.has(id)) throw new CanvasPersistenceError("RESOLUTION_BUSY", "正在处理这个画布，请稍后再试。");
    if (expectedToken && expectedToken !== draftToken(id)) throw new CanvasPersistenceError("DRAFT_CHANGED", "当前编辑已变化，请重新比较后选择。");
    const version = draftToken(id);
    restoringProjects.add(id);
    epochs.set(id, (epochs.get(id) || 0) + 1);
    cancelProjectSaves([id]);
    const previousStatus = useCanvasStore.getState().saveStatus[id];
    saveStatus(id, "resolving");
    const archiveKey = ARCHIVE_PREFIX + id + ":" + requestId;
    try {
        await saveChains.get(id)?.catch(() => undefined);
        await journalChains.get(id)?.catch(() => undefined);
        const draft = useCanvasStore.getState().openProject(id);
        if (!draft) throw new Error("画布不存在");
        const unchanged = () => {
            if (version !== draftToken(id) || useCanvasStore.getState().openProject(id) !== draft) throw new CanvasPersistenceError("DRAFT_CHANGED", "处理期间又有新编辑，已保留；请重新比较后选择。");
        };
        unchanged();
        const archived = await localForageStorage.getItem(archiveKey);
        const record = archived ? JSON.parse(archived) as { project: CanvasProject; copyId: string } : { project: draft, copyId: nanoid() };
        if (!sameContent(record.project, draft)) throw new CanvasPersistenceError("DRAFT_CHANGED", "这个处理请求的编辑已变化，请使用新的请求编号。");
        // An immutable, discoverable full preimage comes before cache/queue changes.
        await localForageStorage.setItem(archiveKey, JSON.stringify(record));
        if (await localForageStorage.getItem(archiveKey) !== JSON.stringify(record)) throw new Error("恢复备份读回失败，当前编辑未切换。");
        unchanged();
        if (choice === "copy") {
            const copy = rebindCanvasProjectIdentity(migrateCanvasProject({
                ...draft, id: record.copyId, __desktopRevision: undefined, recoveryCopyOf: id,
                title: `${draft.title} · 恢复副本`, autoTitlePending: false, pendingAgentRequest: undefined,
                // Keep task IDs and provenance, but a copy is not a new instruction.
                nodes: draft.nodes.map((node) => node.metadata?.status === "loading" ? { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: "恢复副本保留原任务编号；请在原画布查询结果。" } } : node),
            }), record.copyId);
            let saved: CanvasProject = copy;
            if (isDesktopRuntime()) {
                try { saved = await saveDesktopCanvasProject(copy); }
                catch (error) {
                    if (canvasPersistenceError(error).code !== "REVISION_CONFLICT") throw error;
                    const existing = await loadDesktopCanvasProject<CanvasProject>(copy.id);
                    if (!sameContent(existing, copy)) throw error;
                    saved = existing;
                }
            }
            useCanvasStore.setState((state) => ({ projects: [saved, ...state.projects.filter((project) => project.id !== saved.id)] }));
            await persistLocalProject(saved.id);
            saveStatus(saved.id, "saved");
            // The source stays unresolved and keeps all original task identities.
            saveStatus(id, previousStatus?.state === "error" ? "error" : "conflict", previousStatus?.error, previousStatus?.code);
            await checkpointPending(id);
            return { projectId: saved.id, archiveKey };
        }
        if (!isDesktopRuntime()) throw new Error("使用最新版本需要桌面版");
        let latest = await loadDesktopCanvasProject<CanvasProject>(id);
        unchanged();
        latest = { ...migrateCanvasProject(latest), viewport: draft.viewport, sidePanel: draft.sidePanel, agentPanel: draft.agentPanel };
        // Serialize with draft checkpoints. The adopted marker is the commit point
        // across SQLite and IndexedDB; restarting never treats the archive as a task.
        await journalTask(id, async () => {
            unchanged();
            await localPersistChain.catch(() => undefined);
            await localForageStorage.setItem(CANVAS_PROJECT_PREFIX + id, JSON.stringify(latest));
            const check = await loadDesktopCanvasProject<CanvasProject>(id);
            if (check.__desktopRevision !== latest.__desktopRevision) throw new CanvasPersistenceError("REVISION_CONFLICT", "处理期间画布又被修改，请重新比较最新版本。");
            unchanged();
            await localForageStorage.setItem(JOURNAL_PREFIX + id, JSON.stringify({ adopted: true, project: latest, archiveKey }));
        });
        unchanged();
        pendingProjects.delete(id);
        useCanvasStore.setState((state) => ({
            projects: state.projects.map((project) => project.id === id ? latest : project),
            restoredRevisions: { ...state.restoredRevisions, [id]: `${latest.__desktopRevision}:${requestId}` },
        }));
        await persistLocalProject(id);
        saveStatus(id, pendingProjects.has(id) ? "pending" : "saved");
        return { projectId: id, archiveKey };
    } catch (error) {
        statusForError(id, error);
        // On failure a newer edit wins over the candidate/backup snapshot.
        if (pendingProjects.has(id)) await checkpointPending(id).catch(() => undefined);
        throw error;
    } finally {
        restoringProjects.delete(id);
        if (pendingProjects.has(id) && useCanvasStore.getState().saveStatus[id]?.state === "pending") await flushProject(id);
    }
}

function persistLocalProject(id: string): Promise<void> {
    localPersistChain = localPersistChain.catch(() => undefined).then(async () => {
        const project = useCanvasStore.getState().openProject(id);
        if (!project) return;
        validateCanvasGraph(project);
        await localForageStorage.setItem(CANVAS_PROJECT_PREFIX + id, JSON.stringify(project));
        await localForageStorage.setItem(CANVAS_STORE_INDEX_KEY, JSON.stringify({ version: 1, ids: useCanvasStore.getState().projects.map((item) => item.id) }));
        lastWrittenProjects.set(id, project);
    });
    return localPersistChain;
}

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            desktopPersistenceStatus: isDesktopRuntime() ? "checking" : "not_applicable",
            desktopPersistenceError: null,
            projects: [],
            saveStatus: {},
            restoredRevisions: {},
            inspectSaveConflict: inspectSaveConflict,
            resolveSaveConflict: resolveSaveConflict,
            retrySave: async (id) => {
                if (get().saveStatus[id]?.state === "conflict") throw conflictError(id);
                if (restoringProjects.has(id)) throw new CanvasPersistenceError("RESOLUTION_BUSY", "正在处理保存，请稍后再试。");
                cancelProjectSaves([id]);
                saveStatus(id, "pending");
                try {
                    await persistLocalProject(id);
                    await flushProject(id);
                    if (!pendingProjects.has(id)) saveStatus(id, "saved");
                } catch (error) {
                    statusForError(id, error);
                    throw error;
                }
            },
            restoreVersion: async (id, sequence, expectedRevision) => {
                if (!isDesktopRuntime()) throw new Error("版本恢复需要桌面版");
                if (restoringProjects.has(id)) throw new Error("这个画布正在恢复版本");
                await get().retrySave(id);
                const before = get().projects.find((project) => project.id === id);
                if (!before?.__desktopRevision || (expectedRevision && expectedRevision !== before.__desktopRevision)) throw new Error("画布已变化，请重新预览差异后恢复");
                if (before.pendingAgentRequest || before.nodes.some((node) => node.metadata?.status === "loading") || before.chatSessions.some((session) => session.messages.some((message) => message.status === "thinking" || message.status === "running" || (message.status === "waiting" && message.activity)))) throw new Error("请先停止当前画布正在运行的任务或对话，再恢复历史版本");
                restoringProjects.add(id);
                saveStatus(id, "pending");
                try {
                    const restored = await restoreDesktopCanvasVersion<CanvasProject>(id, sequence, before.__desktopRevision, crypto.randomUUID());
                    if (pendingProjects.has(id) || get().projects.find((project) => project.id === id) !== before) {
                        await checkpointPending(id);
                        throw new Error("历史版本已恢复，但恢复期间又有新编辑；新编辑已保留，请另存当前编辑后重新打开画布核对");
                    }
                    set((state) => ({ projects: state.projects.map((project) => project.id === id ? restored : project), restoredRevisions: { ...state.restoredRevisions, [id]: restored.__desktopRevision! } }));
                    await persistLocalProjects(get().projects);
                    if (!pendingProjects.has(id)) saveStatus(id, "saved");
                } catch (error) {
                    statusForError(id, error);
                    throw error;
                } finally {
                    restoringProjects.delete(id);
                }
            },
            createProject: (title = "未命名画布", options) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    agentConfig: options?.agentConfig || null,
                    autoTitlePending: true,
                    pendingAgentRequest: options?.pendingAgentRequest,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                    sidePanel: DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: options?.pendingAgentRequest ? { ...DEFAULT_CANVAS_AGENT_PANEL, open: true } : DEFAULT_CANVAS_AGENT_PANEL,
                    operationState: createCanvasOperationState({ nodes: [] }),
                };
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return id;
            },
            importProject: (source) => {
                validateCanvasGraph({ nodes: source.nodes || [], connections: source.connections || [] });
                const now = new Date().toISOString();
                const id = nanoid();
                const project = rebindCanvasProjectIdentity(migrateCanvasProject<CanvasProject>({
                    ...source,
                    __desktopRevision: undefined,
                    id,
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    agentConfig: source.agentConfig || null,
                    autoTitlePending: false,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                    sidePanel: source.sidePanel || DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: source.agentPanel || DEFAULT_CANVAS_AGENT_PANEL,
                    operationState: source.operationState || createCanvasOperationState({ nodes: source.nodes || [] }),
                }), id);
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return project.id;
            },
            openProject: (id) => get().projects.find((item) => item.id === id) || null,
            renameProject: (id, title) => {
                const sourceProject = get().projects.find((item) => item.id === id);
                if (!sourceProject) return;
                const project = migrateCanvasProject(sourceProject);
                const nextTitle = title.trim() || project.title;
                if (nextTitle === project.title && !project.autoTitlePending) return;
                const timestamp = new Date().toISOString();
                const outcome = applyCanvasOperationBatch(project, {
                    protocolVersion: CANVAS_OPERATION_PROTOCOL_VERSION,
                    actor: "human",
                    requestId: `ui-title-${nanoid()}`,
                    projectId: id,
                    baseRevision: project.operationState.revision,
                    timestamp,
                    operations: [{ type: "project.update", title: nextTitle }],
                }, { now: () => timestamp });
                if (!outcome.result.ok) return;
                const nextProject = {
                    ...outcome.project,
                    autoTitlePending: false,
                };
                set((state) => ({
                    projects: state.projects.map((item) => (item.id === id ? nextProject : item)),
                }));
                queueProjectSave(nextProject);
            },
            deleteProjects: (ids) => {
                cancelProjectSaves(ids);
                set((state) => ({
                    projects: state.projects.filter((project) => !ids.includes(project.id)),
                }));
            },
            updateProject: (id, patch) => {
                const sourceProject = get().projects.find(
                    (item) => item.id === id,
                );
                if (!sourceProject) return;
                const project = migrateCanvasProject(sourceProject);
                const uiOnly = isUiOnlyProjectPatch(patch);
                const targetNodes = patch.nodes || project.nodes;
                const targetConnections = patch.connections || project.connections;
                const operations = buildCanvasStructureOperations(project, targetNodes, targetConnections);
                let nextProject: CanvasProject = project;
                if (operations.length) {
                    const timestamp = new Date().toISOString();
                    const outcome = applyCanvasOperationBatch(project, {
                        protocolVersion: CANVAS_OPERATION_PROTOCOL_VERSION,
                        actor: "human",
                        requestId: `ui-${nanoid()}`,
                        projectId: id,
                        baseRevision: project.operationState.revision,
                        timestamp,
                        operations,
                    }, { now: () => timestamp });
                    if (!outcome.result.ok) {
                        const draft = { ...project, ...patch, updatedAt: timestamp };
                        set((state) => ({ projects: state.projects.map((item) => item.id === id ? draft : item) }));
                        queueProjectSave(draft);
                        saveStatus(id, "error", outcome.result.error?.message || "画布修改未通过校验，草稿已保留");
                        return;
                    }
                    nextProject = outcome.project;
                }
                const { nodes: _nodes, connections: _connections, ...projectPatch } = patch;
                const projectPatchChanged = Object.entries(projectPatch).some(
                    ([key, value]) => JSON.stringify(project[key as keyof CanvasProject]) !== JSON.stringify(value),
                );
                if (!operations.length && !projectPatchChanged) return;
                nextProject = {
                    ...nextProject,
                    ...projectPatch,
                    updatedAt: operations.length ? nextProject.updatedAt : uiOnly ? project.updatedAt : new Date().toISOString(),
                };
                set((state) => ({
                    projects: state.projects.map((item) => (item.id === id ? nextProject : item)),
                }));
                if (!uiOnly || pendingProjects.has(id)) queueProjectSave(nextProject);
                else saveStatus(id, "pending");
            },
            applyOperationBatch: (batch) => {
                const sourceProject = get().projects.find((project) => project.id === batch.projectId);
                if (!sourceProject) return null;
                const outcome = applyCanvasOperationBatch(migrateCanvasProject(sourceProject), batch);
                set((state) => ({
                    projects: state.projects.map((project) => project.id === batch.projectId ? outcome.project : project),
                }));
                queueProjectSave(outcome.project);
                return outcome;
            },
            syncWithRemote: async (token, syncEnabled) => {
                if (!useUserStore.getState().token) return;
                accountCanvasSyncEnabled = syncEnabled;
                if (!syncEnabled) return;
                const localProjects = get().projects.map((project) => migrateCanvasProject(project));
                const remoteProjects = await listCanvasProjects(token).catch(
                    () => null,
                );
                if (!remoteProjects) return;
                const projects = await reconcileCanvasProjects(
                    token,
                    remoteProjects.map((project) => migrateCanvasProject(project)),
                    localProjects,
                );
                if (saveTimer) {
                    clearTimeout(saveTimer);
                    saveTimer = null;
                }
                const nextState = { projects };
                queuedPersistState = nextState;
                set(nextState);
                await persistLocalProjects(projects);
            },
            setSyncEnabled: (enabled) => {
                accountCanvasSyncEnabled = enabled;
            },
            refreshFromDesktop: async () => {
                if (!isDesktopRuntime()) return;
                const projects = await readDesktopProjects(get().projects);
                queuedPersistState = { projects };
                set({ projects });
                await persistLocalProjects(projects).catch(() => undefined);
                for (const project of projects) if (!pendingProjects.has(project.id) && !restoringProjects.has(project.id) && !["error", "conflict"].includes(get().saveStatus[project.id]?.state)) saveStatus(project.id, "saved");
                // Per-project failures remain visible without poisoning every canvas refresh.
                await Promise.allSettled([...pendingProjects.keys()].filter((id) => !deletedDesktopIds.has(id) && !["error", "conflict", "resolving"].includes(get().saveStatus[id]?.state)).map(flushProject));
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState((state) => ({ hydrated: true, saveStatus: { ...Object.fromEntries(recoveredStatus), ...state.saveStatus } }));
            },
        },
    ),
);

export function mergeCanvasProjects(remoteProjects: CanvasProject[], localProjects: CanvasProject[]): CanvasProject[] {
    const projects = new Map<string, CanvasProject>();
    [...localProjects, ...remoteProjects].map((project) => migrateCanvasProject(project)).forEach((project) => {
        const previous = projects.get(project.id);
        const projectTime = Date.parse(project.updatedAt || "") || 0;
        const previousTime = Date.parse(previous?.updatedAt || "") || 0;
        const projectRevision = project.operationState.revision;
        const previousRevision = previous?.operationState.revision ?? -1;
        if (
            !previous ||
            projectRevision > previousRevision ||
            (projectRevision === previousRevision && projectTime >= previousTime)
        ) {
            projects.set(project.id, project);
        }
    });
    return Array.from(projects.values()).sort(
        (a, b) =>
            Date.parse(b.updatedAt || "") -
            Date.parse(a.updatedAt || ""),
    );
}

export function acceptDesktopCanvasDocument(project: CanvasProject, revision: string) {
    if (pendingProjects.has(project.id) || restoringProjects.has(project.id)) throw new Error("当前编辑尚未保存，已保留本机内容。");
    const next = { ...project, __desktopRevision: revision };
    useCanvasStore.setState((state) => ({ projects: state.projects.map((current) => current.id === next.id ? next : current) }));
    return persistLocalProject(project.id).then(() => {
        if (!pendingProjects.has(project.id)) saveStatus(project.id, "saved");
    }).catch((error) => { statusForError(project.id, error); throw error; });
}

function mergeDesktopCanvasProjects(
    desktopProjects: CanvasProject[],
    localProjects: CanvasProject[],
): CanvasProject[] {
    const localById = new Map(localProjects.map((project) => [project.id, project]));
    const projects = new Map(localProjects.map((project) => [project.id, project]));

    desktopProjects.forEach((desktopProject) => {
        const localProject = localById.get(desktopProject.id);
        if (deletedDesktopIds.has(desktopProject.id)) return;
        if (restoringProjects.has(desktopProject.id)) return;
        projects.set(desktopProject.id, {
            ...migrateCanvasProject(pendingProjects.get(desktopProject.id) || desktopProject),
            viewport: localProject?.viewport || desktopProject.viewport,
            sidePanel: localProject?.sidePanel || desktopProject.sidePanel,
            agentPanel: localProject?.agentPanel || desktopProject.agentPanel,
        });
    });

    return Array.from(projects.values()).sort(
        (a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""),
    );
}
