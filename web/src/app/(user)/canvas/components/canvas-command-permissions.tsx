"use client";

import { useState } from "react";
import { App, Button, Dropdown } from "antd";
import { setCanvasGenerationPermission } from "@/services/canvas-commands";

export function CanvasCommandPermissions({ projectId }: { projectId: string }) {
    const [allowed, setAllowed] = useState(false);
    const { message } = App.useApp();
    const change = async (allow: boolean) => {
        try {
            setAllowed(await setCanvasGenerationPermission(projectId, allow));
        } catch (error) {
            void message.error(String(error));
        }
    };
    return (
        <Dropdown
            onOpenChange={(open) => {
                if (open)
                    void setCanvasGenerationPermission(projectId)
                        .then(setAllowed)
                        .catch((error) => message.error(String(error)));
            }}
            menu={{
                selectable: true,
                selectedKeys: [allowed ? "allow" : "ask"],
                items: [
                    { key: "ask", label: "生成前确认", onClick: () => void change(false) },
                    { key: "allow", label: "允许本项目后续生成", onClick: () => void change(true) },
                ],
            }}
        >
            <Button type="text" size="small">
                Agent 权限
            </Button>
        </Dropdown>
    );
}
