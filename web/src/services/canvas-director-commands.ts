type DirectorResult = { ok: boolean; message?: string; project?: unknown; captures?: { dataUrl: string; label: string }[]; video?: { blob: Blob; fileName: string } };
type DirectorExecutor = { nodeId: string; execute: (requestId: string, action: string, args: Record<string, unknown>) => Promise<DirectorResult> };
let current: DirectorExecutor | undefined;
export function registerDirectorExecutor(executor: DirectorExecutor) {
    current = executor;
    return () => { if (current === executor) current = undefined; };
}
export async function executeDirectorCommand(nodeId: string, requestId: string, action: string, args: Record<string, unknown>) {
    const started = Date.now();
    while (current?.nodeId !== nodeId) {
        if (Date.now() - started > 30000) throw new Error("导演台未能完成加载");
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return current.execute(requestId, action, args);
}
