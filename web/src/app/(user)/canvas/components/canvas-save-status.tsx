import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Modal, theme as antdTheme } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasStore, type CanvasSaveComparison } from "../stores/use-canvas-store";

/** 顶栏常驻的保存状态文字：已载入 / 已保存 / 正在保存… / 保存未完成 */
export function CanvasSaveIndicator({ projectId }: { projectId: string }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const status = useCanvasStore((state) => state.saveStatus[projectId]);
    const { token } = antdTheme.useToken();
    const label = !status ? "已载入" : status.state === "saved" ? "已保存" : status.state === "conflict" ? "版本待处理" : status.state === "resolving" ? "正在处理…" : ["pending", "saving"].includes(status.state) ? "正在保存…" : "保存未完成";
    return (
        <span role="status" className="text-xs" style={{ color: ["error", "conflict"].includes(status?.state || "") ? token.colorError : theme.node.muted }} title={status?.state === "error" ? status.error : undefined}>
            {label}
        </span>
    );
}

/** 只在保存失败或有待核对的历史关系时出现的条件横幅 */
export function CanvasSaveIssues({ projectId }: { projectId: string }) {
    const { message } = App.useApp();
    const router = useRouter();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const status = useCanvasStore((state) => state.saveStatus[projectId]);
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const [showRelations, setShowRelations] = useState(false);
    const [comparison, setComparison] = useState<CanvasSaveComparison | null>(null);
    const [compareError, setCompareError] = useState("");
    const { token } = antdTheme.useToken();
    const conflict = status?.state === "conflict" || status?.state === "resolving";
    useEffect(() => {
        if (!conflict || status?.state === "resolving") return;
        let active = true;
        setComparison(null);
        void useCanvasStore.getState().inspectSaveConflict(projectId).then((result) => {
            if (active) { setComparison(result); setCompareError(""); }
        }).catch((error) => { if (active) setCompareError(String(error)); });
        return () => { active = false; };
    }, [conflict, status?.state, projectId, project]);
    const resolve = async (choice: "latest" | "copy") => {
        try {
            const result = await useCanvasStore.getState().resolveSaveConflict(projectId, choice, comparison?.draftToken);
            if (choice === "copy") router.push(`/canvas/${result.projectId}`);
            else void message.success("已使用最新版本，原编辑已留存恢复备份");
        } catch (error) { void message.error(String(error)); }
    };
    const quarantined = project?.quarantinedConnections || [];
    const hasError = status?.state === "error" || conflict;
    if (!project || (!hasError && !quarantined.length)) return null;
    return <>
        <div role="alert" className="absolute left-4 top-16 z-30 flex max-w-[85%] flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg" style={{ color: theme.node.text, background: theme.toolbar.panel, borderColor: hasError ? token.colorError : theme.toolbar.border }}>
            {hasError && <>
                <span>保存未完成：{status.error}</span>
                {conflict ? <>
                    {comparison && <div className="basis-full" style={{ color: theme.node.muted }}>
                        <p>当前编辑：{new Date(comparison.localTime).toLocaleString()} · {comparison.localNodes} 节点 / {comparison.localConnections} 连线；最新：{comparison.latestTime ? new Date(comparison.latestTime).toLocaleString() : "项目已不存在"} · {comparison.latestNodes} 节点 / {comparison.latestConnections} 连线</p>
                        <p>相对最新，当前编辑的节点多 {comparison.nodes.added.length}、少 {comparison.nodes.removed.length}、不同 {comparison.nodes.changed.length}；连线多 {comparison.connections.added.length}、少 {comparison.connections.removed.length}、不同 {comparison.connections.changed.length}。</p>
                        <p className="max-w-3xl break-words">涉及节点：{[...comparison.nodes.added, ...comparison.nodes.removed, ...comparison.nodes.changed].join("、") || "无"}{comparison.otherFields.length ? "；对话、设置或扩展内容也有差异" : ""}</p>
                    </div>}
                    {compareError && <span>{compareError}</span>}
                    <Button size="small" disabled={!comparison?.latestRevision || status.state === "resolving"} onClick={() => void resolve("latest")}>使用最新版本</Button>
                </> : <Button size="small" onClick={() => void useCanvasStore.getState().retrySave(projectId).catch((error) => message.error(String(error)))}>重试保存</Button>}
                <Button size="small" loading={status?.state === "resolving"} onClick={() => void resolve("copy")}>另存当前编辑</Button>
            </>}
            {quarantined.length > 0 && <Button type="text" size="small" onClick={() => setShowRelations(true)}>{quarantined.length} 条历史关系待核对</Button>}
        </div>
        <Modal title="保留的历史关系" open={showRelations} onCancel={() => setShowRelations(false)} footer={null}>
            <p>这些关系的节点已不在当前画布中，原记录已保留。确认原节点后可以重新连接。</p>
            {quarantined.map((item) => <p key={item.connection.id} className="break-all text-xs">{item.connection.fromNodeId} → {item.connection.toNodeId}（{item.reason}）</p>)}
        </Modal>
    </>;
}
