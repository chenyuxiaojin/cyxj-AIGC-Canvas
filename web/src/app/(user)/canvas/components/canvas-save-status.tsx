import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Modal } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasStore } from "../stores/use-canvas-store";

/** 顶栏常驻的保存状态文字：已载入 / 已保存 / 正在保存… / 保存未完成 */
export function CanvasSaveIndicator({ projectId }: { projectId: string }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const status = useCanvasStore((state) => state.saveStatus[projectId]);
    const label = !status ? "已载入" : status.state === "saved" ? "已保存" : status.state === "pending" ? "正在保存…" : "保存未完成";
    return (
        <span role="status" className="text-xs" style={{ color: status?.state === "error" ? "#f87171" : theme.node.muted }} title={status?.state === "error" ? status.error : undefined}>
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
    const quarantined = project?.quarantinedConnections || [];
    const hasError = status?.state === "error";
    if (!project || (!hasError && !quarantined.length)) return null;
    return <>
        <div role="alert" className="absolute left-4 top-16 z-30 flex max-w-[85%] flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg" style={{ color: theme.node.text, background: theme.toolbar.panel, borderColor: hasError ? "#f87171" : theme.toolbar.border }}>
            {hasError && <>
                <span>保存未完成：{status.error}</span>
                <Button size="small" onClick={() => void useCanvasStore.getState().retrySave(projectId).catch((error) => message.error(String(error)))}>重试保存</Button>
                <Button size="small" onClick={() => {
                    const id = useCanvasStore.getState().importProject({ ...project, title: `${project.title} · 恢复副本` });
                    router.push(`/canvas/${id}`);
                }}>另存当前编辑</Button>
            </>}
            {quarantined.length > 0 && <Button type="text" size="small" onClick={() => setShowRelations(true)}>{quarantined.length} 条历史关系待核对</Button>}
        </div>
        <Modal title="保留的历史关系" open={showRelations} onCancel={() => setShowRelations(false)} footer={null}>
            <p>这些关系的节点已不在当前画布中，原记录已保留。确认原节点后可以重新连接。</p>
            {quarantined.map((item) => <p key={item.connection.id} className="break-all text-xs">{item.connection.fromNodeId} → {item.connection.toNodeId}（{item.reason}）</p>)}
        </Modal>
    </>;
}
