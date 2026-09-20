"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Spin } from "antd";
import { ArrowRight, Download, FileUp, Plus } from "lucide-react";

import { isDesktopRuntime } from "@/services/desktop-runtime";
import { importCanvasArchive } from "./canvas/utils/canvas-import";
import { CanvasBindingLabel } from "./canvas/components/canvas-binding-label";
import { CanvasDeleteProjectsDialog } from "./canvas/components/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "./canvas/components/canvas-project-card";
import { useCanvasExport } from "./canvas/hooks/use-canvas-export";
import { useCanvasStore } from "./canvas/stores/use-canvas-store";
import { useCanvasUiStore } from "./canvas/stores/use-canvas-ui-store";

export default function MyCanvasesPage() {
    const { message } = App.useApp();
    const router = useRouter();
    const exportCanvasProjects = useCanvasExport();
    const inputRef = useRef<HTMLInputElement>(null);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const refreshFromDesktop = useCanvasStore((state) => state.refreshFromDesktop);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const [desktopSyncError, setDesktopSyncError] = useState("");

    useEffect(() => {
        if (!hydrated || !isDesktopRuntime()) return;
        setDesktopSyncError("");
        void refreshFromDesktop().catch((error) => setDesktopSyncError(error instanceof Error ? error.message : String(error)));
    }, [hydrated, refreshFromDesktop]);

    const orderedProjects = useMemo(
        () => [...projects].sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "")),
        [projects],
    );
    const latestProject = orderedProjects[0];

    // 新建不再弹片子目录选择：目录在 Agent / 终端首次使用时再绑定。
    const handleCreateProject = () => {
        if (!hydrated) return message.info("正在读取本地画布，请稍候");
        router.push(`/canvas/${createProject(`画布 ${projects.length + 1}`)}`);
    };

    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const imported = await importCanvasArchive(file);
            imported.forEach(importProject);
            message.success(`已导入 ${imported.length} 个画布`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导入失败，请选择有效的画布压缩包");
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return (
        <main className="h-full overflow-y-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <p className="text-xs text-stone-500">一部片子 · 一张画布 · 一个工作目录</p>
                        <h1 className="mt-2 text-3xl font-semibold">我的画布</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(projects.filter((project) => selectedIds.includes(project.id)), `小陈的画布-${selectedIds.length}个项目`)}>
                                    导出选中
                                </Button>
                                <Button disabled={!hydrated} danger onClick={() => setDeleteIds(selectedIds)}>
                                    删除选中
                                </Button>
                            </>
                        ) : null}
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            导入画布
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={handleCreateProject}>
                            新建
                        </Button>
                    </div>
                </header>

                {desktopSyncError ? <Alert type="warning" showIcon message="画布数据读取失败，列表可能不是最新" description={desktopSyncError} /> : null}

                {!hydrated ? (
                    <div className="grid h-40 place-items-center rounded-2xl bg-[#f1eee8] dark:bg-white/5">
                        <Spin />
                    </div>
                ) : latestProject ? (
                    <>
                        <button
                            type="button"
                            onClick={() => router.push(`/canvas/${latestProject.id}`)}
                            className="group flex w-full cursor-pointer flex-col gap-4 rounded-3xl border border-stone-300 bg-[#f1eee8] p-6 text-left transition hover:border-stone-500 hover:bg-[#ebe6dc] sm:flex-row sm:items-center sm:justify-between dark:border-stone-700 dark:bg-white/5 dark:hover:border-stone-500 dark:hover:bg-white/10"
                        >
                            <div className="min-w-0">
                                <div className="text-xs font-medium text-stone-500 dark:text-stone-400">继续上次</div>
                                <div className="mt-1 truncate text-2xl font-semibold">{latestProject.title || "未命名片子"}</div>
                                <CanvasBindingLabel projectId={latestProject.id} />
                                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                                    <span>{latestProject.__desktopSummary ? latestProject.nodeCount : latestProject.nodes?.length || 0} 个节点</span>
                                    <span>{latestProject.__desktopSummary ? latestProject.connectionCount : latestProject.connections?.length || 0} 条连线</span>
                                    <span>{new Date(latestProject.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                                </div>
                            </div>
                            <span className="inline-flex h-11 shrink-0 items-center gap-1 rounded-xl bg-stone-950 px-5 text-sm font-medium text-white transition group-hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 dark:group-hover:bg-stone-200">
                                打开 <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
                            </span>
                        </button>

                        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                            {orderedProjects.map((project) => (
                                <CanvasProjectCard key={project.id} project={project} />
                            ))}
                        </div>
                    </>
                ) : (
                    <button
                        type="button"
                        onClick={handleCreateProject}
                        className="flex h-56 w-full cursor-pointer flex-col items-center justify-center rounded-3xl border border-dashed border-stone-300 bg-[#f1eee8]/60 text-stone-500 transition hover:border-stone-500 hover:text-stone-800 disabled:cursor-wait dark:border-stone-700 dark:bg-white/5 dark:hover:text-stone-200"
                    >
                        <Plus className="size-8" />
                        <span className="mt-3 text-base font-medium">新建第一张画布</span>
                        <span className="mt-1 text-xs">片子目录在 Agent 或终端第一次启动时再选</span>
                    </button>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
