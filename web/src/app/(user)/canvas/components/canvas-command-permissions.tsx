"use client";

import { useEffect, useState } from "react";
import { App, Segmented } from "antd";
import { setCanvasGenerationPermission } from "@/services/canvas-commands";

/** Agent 设置弹窗里的一行：外部 Agent 提交生成任务前是否需要确认 */
export function CanvasCommandPermissionsSetting({ projectId }: { projectId: string }) {
    const [allowed, setAllowed] = useState(false);
    const { message } = App.useApp();
    useEffect(() => {
        void setCanvasGenerationPermission(projectId)
            .then(setAllowed)
            .catch((error) => message.error(String(error)));
    }, [projectId, message]);
    const change = async (allow: boolean) => {
        try {
            setAllowed(await setCanvasGenerationPermission(projectId, allow));
        } catch (error) {
            void message.error(String(error));
        }
    };
    return (
        <div className="flex items-center justify-between gap-6 py-2">
            <div className="min-w-0">
                <div className="text-sm font-medium">外部 Agent 生成权限</div>
                <div className="mt-1 text-xs leading-5 opacity-55">CLI / MCP 提交付费生成任务时，是每次弹窗确认，还是本项目后续直接允许</div>
            </div>
            <Segmented
                size="small"
                value={allowed ? "allow" : "ask"}
                onChange={(value) => void change(value === "allow")}
                options={[
                    { value: "ask", label: "生成前确认" },
                    { value: "allow", label: "本项目允许" },
                ]}
            />
        </div>
    );
}
