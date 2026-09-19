import { invoke } from "@tauri-apps/api/core";
import type { CanvasProject } from "@/app/(user)/canvas/stores/use-canvas-store";

export type CanvasCommand = {
    task_id: string;
    project_id: string;
    status: string;
    request: { project_id: string; request_id: string; base_revision: string; action: string; arguments: Record<string, unknown> };
    result?: Record<string, unknown>;
};
export type CanvasDocument = { project: CanvasProject; revision: string };
export type CanvasExecutor = {
    projectId: string;
    busy: () => boolean;
    preview: (command: CanvasCommand) => { model: string; quantity: string; size: string; seconds: string; prompt: string };
    flush: () => Promise<void>;
    sync: (document: CanvasDocument) => Promise<void>;
    execute: (command: CanvasCommand) => Promise<Record<string, unknown>>;
};
let executor: CanvasExecutor | undefined;
export const currentCanvasExecutor = () => executor;
export function registerCanvasExecutor(next: CanvasExecutor) {
    executor = next;
    return () => {
        if (executor === next) executor = undefined;
    };
}
export const listCanvasCommandHistory = (projectId: string, offset = 0) => invoke<{ tasks: CanvasCommand[]; next_offset: number | null }>("desktop_canvas_commands", { projectId, history: true, offset });
export const listCanvasCommands = () => invoke<CanvasCommand[]>("desktop_canvas_commands", { projectId: null });
export const claimCanvasCommand = (task: CanvasCommand) => invoke<CanvasCommand>("desktop_claim_canvas_command", { projectId: task.project_id, requestId: task.task_id });
export const finishCanvasCommand = (task: CanvasCommand, result: Record<string, unknown>) => invoke<CanvasCommand>("desktop_finish_canvas_command", { projectId: task.project_id, requestId: task.task_id, result });
export const readCanvasDocument = (projectId: string) => invoke<CanvasDocument>("desktop_canvas_document", { projectId });
export const submitCanvasCommand = (request: CanvasCommand["request"]) => invoke<CanvasCommand>("desktop_submit_canvas_command", { request });
export const getCanvasCommand = (projectId: string, requestId: string, cancel = false) => invoke<CanvasCommand>("desktop_get_canvas_command", { projectId, requestId, cancel });
export const applyDesktopCanvasOperations = (request: { project_id: string; request_id: string; base_revision: string; actor: "agent"; operations: Record<string, unknown>[] }, dryRun = false) =>
    invoke<CanvasDocument>("desktop_canvas_operations", { request, dryRun });
export const readCanvasTransfer = (projectId: string, artifactId: string) => invoke<ArrayBuffer>("desktop_read_canvas_transfer", { projectId, artifactId });
export const writeCanvasTransfer = async (projectId: string, blob: Blob) => invoke<{ artifact_id: string; sha256: string; bytes: number }>("desktop_write_canvas_transfer", await blob.arrayBuffer(), { headers: { "x-canvas-project": projectId } });
