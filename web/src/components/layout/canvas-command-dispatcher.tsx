"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { App } from "antd";
import { isDesktopRuntime, canvasPersistenceError } from "@/services/desktop-runtime";
import { claimCanvasCommand, currentCanvasExecutor, finishCanvasCommand, listCanvasCommands, getCanvasCommand, readCanvasDocument, type CanvasCommand } from "@/services/canvas-commands";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";

export function CanvasCommandDispatcher() {
    const router = useRouter();
    const { message } = App.useApp();
    const running = useRef(false);
    const opening = useRef<CanvasCommand | null>(null);

    useEffect(() => {
        if (!isDesktopRuntime()) return;
        let stopped = false;
        let polling = false;
        let lastReportedError = "";
        const poll = async () => {
            if (stopped || polling || !useCanvasStore.getState().hydrated) return;
            polling = true;
            try {
                const tasks = await listCanvasCommands();
                if (stopped) return;
                // Recovery commands must remain reachable while ordinary flush is blocked.
                const recovery = tasks.find((task) => task.status === "queued" && ["save_inspect", "save_use_latest", "save_copy"].includes(task.request.action));
                if (recovery && !running.current) {
                    running.current = true;
                    try {
                        await claimCanvasCommand(recovery);
                        const store = useCanvasStore.getState();
                        const result = recovery.request.action === "save_inspect"
                            ? await store.inspectSaveConflict(recovery.project_id)
                            : await store.resolveSaveConflict(recovery.project_id, recovery.request.action === "save_copy" ? "copy" : "latest", String(recovery.request.arguments.draftToken || ""), recovery.task_id);
                        await finishCanvasCommand(recovery, { ok: true, ...result });
                    } catch (error) {
                        const parsed = canvasPersistenceError(error);
                        await finishCanvasCommand(recovery, { ok: false, code: parsed.code, message: parsed.message });
                    } finally { running.current = false; }
                    return;
                }
                const active = currentCanvasExecutor();
                if (opening.current && active?.projectId === opening.current.project_id) {
                    if (!["conflict", "error", "resolving"].includes(useCanvasStore.getState().saveStatus[active.projectId]?.state)) await active.flush();
                    await finishCanvasCommand(opening.current, { ok: true, projectId: active.projectId });
                    opening.current = null;
                }
                const openRequest = tasks.find((task) => task.status === "queued" && task.request.action === "open_project");
                if (openRequest && !running.current && !opening.current) {
                    // Leaving one conflicted canvas must not block unrelated projects.
                    if (active) await active.flush().catch(() => undefined);
                    await claimCanvasCommand(openRequest);
                    opening.current = openRequest;
                    router.push(`/canvas/${encodeURIComponent(openRequest.project_id)}`);
                    return;
                }
                const saveState = active && useCanvasStore.getState().saveStatus[active.projectId]?.state;
                if (saveState === "conflict" || saveState === "resolving") return;
                if (running.current || opening.current || active?.busy()) return;
                // Only accept a remote document when the current editor has no unsaved work.
                if (active && useCanvasStore.getState().saveStatus[active.projectId]?.state === "saved") {
                    const document = await readCanvasDocument(active.projectId);
                    const local = useCanvasStore.getState().projects.find((project) => project.id === active.projectId);
                    if (currentCanvasExecutor() !== active || active.busy()) return;
                    if (document.revision !== local?.__desktopRevision) await active.sync(document);
                }
                const next = tasks.find((task) => task.status === "queued" && task.project_id === active?.projectId);
                if (!next) return;
                if (active) await active.flush();
                await claimCanvasCommand(next);
                if (!active) return;
                running.current = true;
                void (async () => {
                    try {
                        await active.flush();
                        const document = await readCanvasDocument(next.project_id);
                        if (document.revision !== next.request.base_revision) {
                            await finishCanvasCommand(next, { ok: false, code: "REVISION_CONFLICT", message: "画布已有修改，尚未执行此任务。请读取最新内容后重新提交。", revision: document.revision });
                            return;
                        }
                        const latest = await getCanvasCommand(next.project_id, next.task_id);
                        if (latest.status !== "running") {
                            await finishCanvasCommand(next, { ok: false, code: "CANCELLED_BEFORE_EXECUTION", message: "任务已停止，尚未调用生成服务" });
                            return;
                        }
                        const result = await active.execute(next);
                        await active.flush();
                        await finishCanvasCommand(next, result);
                    } catch (error) {
                        await finishCanvasCommand(next, { ok: false, code: "EXECUTION_FAILED", message: String(error) });
                    } finally {
                        running.current = false;
                    }
                })().catch((error) => {
                    void message.error(`任务回执保存失败，请核对任务记录：${String(error)}`);
                });
            } catch (error) {
                if (lastReportedError !== String(error)) {
                    lastReportedError = String(error);
                    void message.error(`画布任务连接失败：${String(error)}`);
                }
                // A failed claim or disconnected App never triggers a second execution.
                if (opening.current) {
                    const task = opening.current;
                    opening.current = null;
                    await finishCanvasCommand(task, { ok: false, code: "OPEN_FAILED", message: String(error) }).catch(() => undefined);
                }
            } finally {
                polling = false;
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), 1000);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [message, router]);

    return null;
}
