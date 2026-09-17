"use client";

import { useEffect, useRef } from "react";
import { Globe2, Image as ImageIcon, Layers3, Music2, Settings2, Type, Video, type LucideIcon } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type Position } from "../types";

/** 画布七类可创建节点：底部工具栏、双击空白处菜单、连线松手菜单共用这一份图标和标签。 */
export const canvasNodeCreateOptions: { type: CanvasNodeType; label: string; description?: string; icon: LucideIcon }[] = [
    { type: CanvasNodeType.Text, label: "文本", description: "脚本、广告词、品牌文案", icon: Type },
    { type: CanvasNodeType.Image, label: "图片", icon: ImageIcon },
    { type: CanvasNodeType.Video, label: "视频", icon: Video },
    { type: CanvasNodeType.Audio, label: "音频", icon: Music2 },
    { type: CanvasNodeType.Panorama, label: "全景图", description: "文生全景、图生全景", icon: Globe2 },
    { type: CanvasNodeType.Director, label: "导演台", description: "3D 场景、角色、机位", icon: Layers3 },
    { type: CanvasNodeType.Config, label: "生成配置", description: "模型、尺寸、数量和输入顺序", icon: Settings2 },
];

export function getCanvasNodeCreateOption(type: CanvasNodeType) {
    return canvasNodeCreateOptions.find((option) => option.type === type)!;
}

type CanvasNodeCreateMenuProps = {
    title: string;
    position: Position;
    /** 连线松手菜单由画布自己在松手/点空白时关闭；双击菜单靠点击菜单外关闭。 */
    closeOnOutsideClick?: boolean;
    dataAttr: "data-connection-create-menu" | "data-canvas-no-zoom";
    onCreate: (type: CanvasNodeType) => void;
    onClose: () => void;
};

export function CanvasNodeCreateMenu({ title, position, closeOnOutsideClick = false, dataAttr, onCreate, onClose }: CanvasNodeCreateMenuProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!closeOnOutsideClick) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
        };
        document.addEventListener("pointerdown", handlePointerDown, true);
        return () => document.removeEventListener("pointerdown", handlePointerDown, true);
    }, [closeOnOutsideClick, onClose]);

    return (
        <div
            ref={menuRef}
            className="absolute z-[120] w-[300px] rounded-[18px] border p-3 shadow-2xl backdrop-blur"
            {...{ [dataAttr]: true }}
            style={{ left: position.x, top: position.y, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    {title}
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-white/10 hover:opacity-100" onClick={onClose} aria-label="关闭">
                    ×
                </button>
            </div>
            <div className="grid gap-1">
                {canvasNodeCreateOptions.map(({ type, label, description, icon: Icon }) => (
                    <button
                        key={type}
                        type="button"
                        className="flex h-16 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition"
                        style={{ color: theme.node.text }}
                        onClick={() => onCreate(type)}
                        onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
                        onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
                    >
                        <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>
                            <Icon className="size-5" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2 text-base font-semibold leading-5">{label}</span>
                            {description ? (
                                <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>
                                    {description}
                                </span>
                            ) : null}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}
