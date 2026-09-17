import { directorAgentReady, directorStore, captureDirector, directorAgentExportVideo } from "./assets/index-oQuo7db8.js";

let executing = false;
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
window.addEventListener("message", async (event) => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.type !== "storyai:director-command") return;
    const { requestId, action, arguments: args = {} } = event.data;
    const reply = (payload) => parent.postMessage({ type: "storyai:director-command-result", requestId, payload }, location.origin);
    if (typeof requestId !== "string") return;
    if (executing) { reply({ ok: false, message: "导演台正在执行其他任务" }); return; }
    executing = true;
    try {
        const started = Date.now();
        while (!directorAgentReady()) {
            if (Date.now() - started > 30000) throw new Error("导演台渲染器未准备完成");
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const state = directorStore.getState();
        if (args.cameraId != null) {
            if (!state.project.cameras.some((camera) => camera.id === args.cameraId)) throw new Error("指定机位不存在");
            state.setActiveCamera(args.cameraId);
        }
        if (args.seconds != null) {
            if (!Number.isFinite(args.seconds) || args.seconds < 0 || args.seconds > state.project.timeline.durationSeconds) throw new Error("时间轴位置超出范围");
            state.setTimelineTime(args.seconds);
        }
        if (action === "director_read") { reply({ ok: true, project: directorStore.getState().project }); return; }
        if (!["director_capture", "director_export_video"].includes(action)) throw new Error("未知导演台命令");
        state.setViewMode("camera");
        // Wait for the existing React renderer to apply camera/time changes before capture.
        await frame(); await frame();
        if (action === "director_capture") {
            const preset = args.preset || "current";
            if (!["current", "four", "twelve"].includes(preset)) throw new Error("截图方式无效");
            const cameraId = directorStore.getState().project.activeCameraId;
            const captures = await captureDirector({ preset, source: "camera-panel", cameraId });
            if (!captures.length) throw new Error("导演台没有返回截图");
            reply({ ok: true, captures, project: directorStore.getState().project });
        } else {
            const video = await directorAgentExportVideo();
            reply({ ok: true, video, project: directorStore.getState().project });
        }
    } catch (error) { reply({ ok: false, message: String(error) }); }
    finally { executing = false; }
});
