import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useRef, useState } from "react";
import { Button, Dropdown, Segmented, Switch } from "antd";
import type { MenuProps } from "antd";
import { CircleDot, Ellipsis, Eraser, Grid2x2, Hand, History, Info, Keyboard, Moon, MousePointer2, Palette, Plus, Redo2, Settings2, Square, Sun, Trash2, Undo2, Upload } from "lucide-react";

import { canvasThemes, type CanvasBackgroundMode, type CanvasColorTheme, type CanvasTheme } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { CanvasNodeType } from "../types";
import { getCanvasNodeCreateOption } from "./canvas-node-create-menu";

/**
 * 底部工具栏三档（PRD 10.1）：
 * 一档常露：选择/移动 · 撤销 重做 · 文本 图片 视频 · 「+ 更多」 · 「…」
 * 二档「+ 更多」：音频 · 全景图 · 导演台 · 生成配置
 * 三档「…」：添加本机素材 · 画布外观 · 版本历史 · 快捷键 · 配置 ｜ 删除选中 · 清空画布 · 删除当前画布
 */
export function CanvasToolbar({
    selectedCount,
    canvasTool,
    canUndo,
    canRedo,
    backgroundMode,
    showImageInfo,
    versionHistoryAvailable,
    onAddImage,
    onAddVideo,
    onAddAudio,
    onAddText,
    onAddPanorama,
    onAddDirector,
    onAddConfig,
    onUndo,
    onRedo,
    onUpload,
    onDelete,
    onClear,
    onDeleteProject,
    onOpenVersionHistory,
    onOpenShortcuts,
    onOpenConfig,
    onCanvasToolChange,
    onBackgroundModeChange,
    onShowImageInfoChange,
}: {
    selectedCount: number;
    canvasTool: "select" | "pan";
    canUndo: boolean;
    canRedo: boolean;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    versionHistoryAvailable: boolean;
    onAddImage: () => void;
    onAddVideo: () => void;
    onAddAudio: () => void;
    onAddText: () => void;
    onAddPanorama: () => void;
    onAddDirector: () => void;
    onAddConfig: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onUpload: () => void;
    onDelete: () => void;
    onClear: () => void;
    onDeleteProject: () => void;
    onOpenVersionHistory: () => void;
    onOpenShortcuts: () => void;
    onOpenConfig: () => void;
    onCanvasToolChange: (tool: "select" | "pan") => void;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (show: boolean) => void;
}) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const overflowRef = useRef<HTMLSpanElement>(null);
    const colorTheme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const theme = canvasThemes[colorTheme];
    const [hovered, setHovered] = useState<string | null>(null);
    const [tipX, setTipX] = useState(0);
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [moreOpen, setMoreOpen] = useState(false);
    const [overflowOpen, setOverflowOpen] = useState(false);
    const [panelX, setPanelX] = useState(0);
    const dockStyle = { background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item, boxShadow: colorTheme === "dark" ? "0 18px 45px rgba(0,0,0,.32)" : "0 16px 40px rgba(28,25,23,.12)" };
    const hoverStyle = { background: theme.toolbar.itemHover, color: theme.toolbar.activeText };
    const activeStyle = { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };
    const tip = hovered && !moreOpen && !overflowOpen ? toolLabel(hovered) : "";
    const buttonProps = { hovered, hoverStyle, wrapRef, onTipX: setTipX, onHover: setHovered };

    const primaryCreateItems = [[CanvasNodeType.Text, onAddText], [CanvasNodeType.Image, onAddImage], [CanvasNodeType.Video, onAddVideo]] as const;
    const moreItems: MenuProps["items"] = ([[CanvasNodeType.Audio, onAddAudio], [CanvasNodeType.Panorama, onAddPanorama], [CanvasNodeType.Director, onAddDirector], [CanvasNodeType.Config, onAddConfig]] as const).map(([type, onClick]) => {
        const { label, icon: Icon } = getCanvasNodeCreateOption(type);
        return { key: type, icon: <Icon className="size-4" />, label, onClick };
    });
    const overflowItems: MenuProps["items"] = [
        { key: "upload", icon: <Upload className="size-4" />, label: "添加本机素材", onClick: onUpload },
        {
            key: "appearance",
            icon: <Palette className="size-4" />,
            label: "画布外观",
            onClick: () => {
                if (overflowRef.current) setPanelX(getTipX(wrapRef.current, overflowRef.current));
                setAppearanceOpen(true);
            },
        },
        ...(versionHistoryAvailable ? [{ key: "history", icon: <History className="size-4" />, label: "版本历史", onClick: onOpenVersionHistory }] : []),
        { key: "shortcuts", icon: <Keyboard className="size-4" />, label: "快捷键", onClick: onOpenShortcuts },
        { key: "settings", icon: <Settings2 className="size-4" />, label: "配置…", onClick: onOpenConfig },
        { type: "divider" },
        { key: "delete", icon: <Trash2 className="size-4" />, label: selectedCount ? `删除选中（${selectedCount}）` : "删除选中", disabled: !selectedCount, danger: true, onClick: onDelete },
        { key: "clear", icon: <Eraser className="size-4" />, label: "清空画布", danger: true, onClick: onClear },
        { key: "delete-project", icon: <Trash2 className="size-4" />, label: "删除当前画布", danger: true, onClick: onDeleteProject },
    ];

    return (
        <div className="pointer-events-none absolute bottom-5 z-50 flex justify-center" style={{ left: 240, right: 16 }}>
            {tip ? <DockTip label={tip} x={tipX} theme={theme} /> : null}
            <div ref={wrapRef} className="pointer-events-auto flex h-14 max-w-full items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur [&>*]:shrink-0" style={dockStyle}>
                <ToolbarButton id={`tool-${canvasTool}`} label={canvasTool === "select" ? "选择" : "移动"} active activeStyle={activeStyle} {...buttonProps} onClick={() => onCanvasToolChange(canvasTool === "select" ? "pan" : "select")}>
                    {canvasTool === "select" ? <MousePointer2 className="size-4.5" /> : <Hand className="size-4.5" />}
                </ToolbarButton>
                <Divider theme={theme} />
                <ToolbarButton id="tool-undo" label="撤销" disabled={!canUndo} {...buttonProps} onClick={onUndo}>
                    <Undo2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-redo" label="重做" disabled={!canRedo} {...buttonProps} onClick={onRedo}>
                    <Redo2 className="size-4.5" />
                </ToolbarButton>
                <Divider theme={theme} />
                {primaryCreateItems.map(([type, onClick]) => {
                    const { label, icon: Icon } = getCanvasNodeCreateOption(type);
                    return (
                        <ToolbarButton key={type} id={`tool-${type}`} label={label} {...buttonProps} onClick={onClick}>
                            <Icon className="size-4.5" />
                        </ToolbarButton>
                    );
                })}
                <Dropdown trigger={["click"]} placement="top" open={moreOpen} onOpenChange={setMoreOpen} menu={{ items: moreItems, onClick: () => setMoreOpen(false) }}>
                    <span>
                        <ToolbarButton id="tool-more" label="更多" active={moreOpen} activeStyle={activeStyle} {...buttonProps}>
                            <Plus className="size-4.5" />
                        </ToolbarButton>
                    </span>
                </Dropdown>
                <Divider theme={theme} />
                <Dropdown trigger={["click"]} placement="topRight" open={overflowOpen} onOpenChange={setOverflowOpen} menu={{ items: overflowItems, onClick: () => setOverflowOpen(false) }}>
                    <span ref={overflowRef}>
                        <ToolbarButton id="tool-overflow" label="更多操作" active={overflowOpen || appearanceOpen} activeStyle={activeStyle} {...buttonProps}>
                            <Ellipsis className="size-4.5" />
                        </ToolbarButton>
                    </span>
                </Dropdown>
            </div>

            {appearanceOpen ? (
                <>
                    <button type="button" aria-label="关闭画布外观" className="pointer-events-auto fixed inset-0 z-20 cursor-default" onClick={() => setAppearanceOpen(false)} />
                    <div
                        className="pointer-events-auto absolute bottom-[72px] z-30 w-[248px] -translate-x-1/2 rounded-xl border p-2.5 shadow-xl backdrop-blur"
                        style={{ left: panelX || "50%", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}
                    >
                        <div className="px-1 pb-2 text-sm font-medium opacity-65">画布外观</div>
                        <div className="px-1 pb-1.5 text-[11px] font-medium opacity-50">主题模式</div>
                        <div className="grid grid-cols-2 gap-1 rounded-lg p-1" style={{ background: theme.toolbar.itemHover }}>
                            <CanvasThemeButton colorTheme={colorTheme} targetTheme="light" onThemeChange={setTheme}>
                                <Sun className="size-4" />
                                浅色
                            </CanvasThemeButton>
                            <CanvasThemeButton colorTheme={colorTheme} targetTheme="dark" onThemeChange={setTheme}>
                                <Moon className="size-4" />
                                深色
                            </CanvasThemeButton>
                        </div>
                        <div className="mt-3 px-1 pb-1.5 text-[11px] font-medium opacity-50">网格样式</div>
                        <Segmented
                            className="w-full !p-1 [&_.ant-segmented-group]:!flex [&_.ant-segmented-item]:!min-h-8 [&_.ant-segmented-item]:!flex-1 [&_.ant-segmented-item-label]:!min-h-8 [&_.ant-segmented-item-label]:!leading-8"
                            value={backgroundMode}
                            onChange={(value) => onBackgroundModeChange(value as CanvasBackgroundMode)}
                            options={[
                                {
                                    value: "dots",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <CircleDot className="size-4" />点
                                        </span>
                                    ),
                                },
                                {
                                    value: "lines",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Grid2x2 className="size-4" />线
                                        </span>
                                    ),
                                },
                                {
                                    value: "blank",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Square className="size-4" />
                                            空白
                                        </span>
                                    ),
                                },
                            ]}
                        />
                        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg px-1.5 py-1">
                            <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium opacity-65">
                                <Info className="size-3.5" />
                                图片信息
                            </span>
                            <Switch size="small" checked={showImageInfo} onChange={onShowImageInfoChange} />
                        </div>
                    </div>
                </>
            ) : null}
        </div>
    );
}

function ToolbarButton({
    id,
    label,
    active,
    hovered,
    activeStyle,
    hoverStyle,
    wrapRef,
    onTipX,
    onHover,
    onClick,
    disabled = false,
    danger = false,
    children,
}: {
    id: string;
    label: string;
    active?: boolean;
    hovered: string | null;
    activeStyle?: CSSProperties;
    hoverStyle: CSSProperties;
    wrapRef: RefObject<HTMLDivElement | null>;
    onTipX: (x: number) => void;
    onHover: (id: string | null) => void;
    onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    disabled?: boolean;
    danger?: boolean;
    children: ReactNode;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <Button
            type="text"
            aria-label={label}
            className="!h-8 !w-8 !min-w-8 !p-0"
            disabled={disabled}
            style={active ? activeStyle : hovered === id && !disabled ? hoverStyle : { color: danger ? "#f87171" : theme.toolbar.item, opacity: disabled ? 0.35 : 1 }}
            icon={children}
            onMouseEnter={(event) => {
                onHover(id);
                onTipX(getTipX(wrapRef.current, event.currentTarget));
            }}
            onMouseLeave={() => onHover(null)}
            onClick={onClick}
        />
    );
}

function Divider({ theme }: { theme: CanvasTheme }) {
    return <div className="mx-1 h-6 w-px" style={{ background: theme.toolbar.border }} />;
}

function CanvasThemeButton({ colorTheme, targetTheme, onThemeChange, children }: { colorTheme: CanvasColorTheme; targetTheme: CanvasColorTheme; onThemeChange: (theme: CanvasColorTheme) => void; children: ReactNode }) {
    const theme = canvasThemes[colorTheme];
    const active = colorTheme === targetTheme;
    const activeStyle = colorTheme === "light" ? { background: "#111111", color: "#ffffff" } : { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };

    return (
        <AnimatedThemeToggler
            theme={colorTheme}
            targetTheme={targetTheme}
            onThemeChange={onThemeChange}
            className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm transition"
            style={active ? activeStyle : { color: theme.toolbar.item }}
            aria-label={`切换到${targetTheme === "dark" ? "深色" : "浅色"}主题`}
            title={`切换到${targetTheme === "dark" ? "深色" : "浅色"}主题`}
        >
            {children}
        </AnimatedThemeToggler>
    );
}

function DockTip({ label, x, theme }: { label: string; x: number; theme: CanvasTheme }) {
    return (
        <span className="absolute bottom-[calc(100%+8px)] -translate-x-1/2 rounded-md px-2 py-1 text-xs shadow-lg" style={{ left: x, background: theme.node.text, color: theme.node.panel }}>
            {label}
        </span>
    );
}

function toolLabel(id: string) {
    if (id === "tool-select") return "选择";
    if (id === "tool-pan") return "移动";
    if (id === "tool-undo") return "撤销";
    if (id === "tool-redo") return "重做";
    if (id === "tool-text") return "文本";
    if (id === "tool-image") return "图片";
    if (id === "tool-video") return "视频";
    if (id === "tool-more") return "更多节点";
    if (id === "tool-overflow") return "更多操作";
    return "";
}

function getTipX(wrap: HTMLDivElement | null, target: HTMLElement) {
    if (!wrap) return 0;
    const wrapBox = wrap.parentElement?.getBoundingClientRect() || wrap.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    return box.left - wrapBox.left + box.width / 2;
}
