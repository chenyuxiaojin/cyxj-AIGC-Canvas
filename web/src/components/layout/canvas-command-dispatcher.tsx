"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Checkbox, Modal } from "antd";
import { isDesktopRuntime } from "@/services/desktop-runtime";
import { approveCanvasCommand, claimCanvasCommand, currentCanvasExecutor, finishCanvasCommand, listCanvasCommands, getCanvasCommand, readCanvasDocument, type CanvasCommand } from "@/services/canvas-commands";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";

export function CanvasCommandDispatcher() {
    const router = useRouter();
    const { message } = App.useApp();
    const [pending, setPending] = useState<CanvasCommand | null>(null);
    const [preview, setPreview] = useState<ReturnType<NonNullable<ReturnType<typeof currentCanvasExecutor>>["preview"]> | null>(null);
    const [remember, setRemember] = useState(false);
    const running = useRef(false);
    const opening = useRef<CanvasCommand | null>(null);
    const pendingRef = useRef(pending);
    pendingRef.current = pending;

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
                if (pendingRef.current && !tasks.some((task) => task.task_id === pendingRef.current?.task_id && task.status === "pending_approval")) setPending(null);
                const active = currentCanvasExecutor();
                if (opening.current && active?.projectId === opening.current.project_id) {
                    await active.flush();
                    await finishCanvasCommand(opening.current, { ok: true, projectId: active.projectId });
                    opening.current = null;
                }
                const approval = tasks.find((task) => task.status === "pending_approval" && task.project_id === active?.projectId);
                if (approval && !pendingRef.current) {
                    setRemember(false);
                    setPreview(active?.preview(approval) || null);
                    setPending(approval);
                }
                if (running.current || opening.current || active?.busy()) return;
                // Only accept a remote document when the current editor has no unsaved work.
                if (active && useCanvasStore.getState().saveStatus[active.projectId]?.state === "saved") {
                    const document = await readCanvasDocument(active.projectId);
                    const local = useCanvasStore.getState().projects.find((project) => project.id === active.projectId);
                    if (currentCanvasExecutor() !== active || active.busy()) return;
                    if (document.revision !== local?.__desktopRevision) await active.sync(document);
                }
                const next = tasks.find((task) => task.status === "queued" && (task.request.action === "open_project" || task.project_id === active?.projectId));
                if (!next) return;
                if (active) await active.flush();
                await claimCanvasCommand(next);
                if (next.request.action === "open_project") {
                    opening.current = next;
                    if (active?.projectId === next.project_id) {
                        await finishCanvasCommand(next, { ok: true, projectId: next.project_id });
                        opening.current = null;
                    } else {
                        opening.current = next;
                        router.push(`/canvas/${encodeURIComponent(next.project_id)}`);
                    }
                    return;
                }
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

    const approve = async (allow: boolean) => {
        if (!pending) return;
        try {
            await approveCanvasCommand(pending, allow, remember);
            setPending(null);
        } catch (error) {
            void message.error(String(error));
        }
    };
    return (
        <Modal
            open={Boolean(pending)}
            title="允许画布生成任务"
            onCancel={() => void approve(false)}
            footer={[
                <Button key="cancel" onClick={() => void approve(false)}>
                    取消任务
                </Button>,
                <Button key="approve" type="primary" onClick={() => void approve(true)}>
                    允许生成
                </Button>,
            ]}
        >
            <p>{preview?.prompt || String(pending?.request.arguments.title || pending?.request.action || "")}</p>
            {preview && (
                <p>
                    模型：{preview.model || "尚未配置"} · 数量：{preview.quantity} · 尺寸：{preview.size}
                    {preview.seconds ? ` · 时长：${preview.seconds} 秒` : ""}
                </p>
            )}
            <p>将使用此画布的模型、渠道及参考素材，费用由对应服务收取。</p>
            <Checkbox checked={remember} onChange={(event) => setRemember(event.target.checked)}>
                允许本项目后续生成任务（可在画布中关闭）
            </Checkbox>
        </Modal>
    );
}
