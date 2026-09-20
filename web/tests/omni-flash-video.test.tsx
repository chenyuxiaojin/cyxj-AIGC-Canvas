import { describe, expect, test } from "bun:test";
import axios from "axios";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoSettingsPanel } from "../src/components/video-settings-panel";
import { CanvasVideoSettingsPopover } from "../src/app/(user)/canvas/components/canvas-video-settings-popover";
import { canvasThemes } from "../src/lib/canvas-theme";
import { localVideoGatewayUrl } from "../src/lib/local-video-gateway";
import { omniFlashVideoPreset } from "../src/lib/video-model-capabilities";
import { createVideoGenerationTask, pollCreatedVideoGenerationTask } from "../src/services/api/video";
import { localChannelForActiveModel, modelMatchesCapability, selectableModelsByCapability, useConfigStore, type AiConfig } from "../src/stores/use-config-store";

const omni = "omni_flash-landscape-10s";
const config: AiConfig = {
    ...useConfigStore.getState().config,
    channelMode: "local", model: omni, videoModel: "seedance2.5", videoChannelId: "old",
    videoSeconds: "30", size: "1:1", vquality: "1080", videoGenerateAudio: "true",
    models: ["seedance2.5", omni],
    localChannels: [
        { id: "old", name: "老狗", protocol: "openai", baseUrl: "https://api.laogou.org/v1", apiKey: "test-old-key", models: ["seedance2.5"], videoApiMode: "media" },
        { id: "new", name: "Omni Flash", protocol: "openai", baseUrl: "https://api.chatgpt-code.com/v1", apiKey: "test-new-key", models: [omni], videoApiMode: "chat" },
    ],
};

describe("Omni Flash as an additional video channel", () => {
    test("all six provider model names are video models with fixed presets", () => {
        for (const direction of ["landscape", "portrait"]) for (const seconds of [4, 6, 10]) {
            const model = `omni_flash-${direction}-${seconds}s`;
            expect(modelMatchesCapability(model, "video")).toBe(true);
            expect(modelMatchesCapability(model, "text")).toBe(false);
            expect(omniFlashVideoPreset(model)).toEqual({ seconds, ratio: direction === "portrait" ? "9:16" : "16:9" });
        }
        expect(omniFlashVideoPreset("seedance2.5")).toBeNull();
        expect(omniFlashVideoPreset("omni_flash-landscape-30s")).toBeNull();
        expect(selectableModelsByCapability(config, "video")).toEqual(["seedance2.5", omni]);
        expect(localChannelForActiveModel(config)?.id).toBe("new");
        expect(localChannelForActiveModel({ ...config, model: "seedance2.5" })?.id).toBe("old");
    });

    test("fixed local gateways keep providers and allowed paths separate", () => {
        expect(localVideoGatewayUrl("https://api.chatgpt-code.com/v1/chat/completions")).toBe("/api/ai/guoguo/v1/chat/completions");
        expect(localVideoGatewayUrl("https://api.laogou.org/v1/media/videos")).toBe("/api/ai/laogou/v1/media/videos");
        for (const url of ["https://api.chatgpt-code.com/v1/videos", "https://elsewhere.test/v1/chat/completions", "https://user:password@api.chatgpt-code.com/v1/models", "https://api.chatgpt-code.com/v1/models?host=elsewhere.test"]) {
            expect(localVideoGatewayUrl(url)).toBe(url);
        }
    });

    test("creation uses the new key, ten seconds and landscape despite stale old-model settings", async () => {
        const original = axios.defaults.adapter;
        const before = JSON.stringify(config);
        const requests: Array<{ url: string | undefined; auth: unknown; body: Record<string, unknown> }> = [];
        axios.defaults.adapter = async (request) => {
            requests.push({ url: request.url, auth: request.headers.Authorization, body: JSON.parse(request.data) });
            return { status: 200, statusText: "OK", config: request, headers: {}, data: request.url?.includes("guoguo") ? { choices: [{ message: { content: "[视频](https://media.example.test/clip.mp4)" } }] } : { id: "old-task", status: "queued" } };
        };
        try {
            const created = await createVideoGenerationTask(config, "测试提示词", [], undefined, { clientTaskId: "new-task" });
            expect(requests[0]).toMatchObject({ url: "/api/ai/guoguo/v1/chat/completions", auth: "Bearer test-new-key", body: { model: omni, stream: false, duration: 10, aspect_ratio: "16:9" } });
            expect(requests[0].body.resolution).toBeUndefined();
            expect(requests[0].body.generate_audio).toBeUndefined();
            expect(created.task.seconds).toBe("10");
            const result = await pollCreatedVideoGenerationTask(config, created.task);
            expect(result.url).toBe("https://media.example.test/clip.mp4");
            expect(requests.length).toBe(1);
            await createVideoGenerationTask({ ...config, model: "seedance2.5" }, "旧模型测试");
            expect(requests[1]).toMatchObject({ url: "/api/ai/laogou/v1/media/videos", auth: "Bearer test-old-key", body: { model: "seedance2.5", duration: 30, ratio: "1:1", resolution: "720p" } });
            expect(JSON.stringify(config)).toBe(before);
        } finally { axios.defaults.adapter = original; }
    });

    test("an uncertain response is reported once without another paid submission", async () => {
        const original = axios.defaults.adapter;
        let calls = 0;
        axios.defaults.adapter = async () => { calls++; throw new Error("connection interrupted"); };
        try {
            await expect(createVideoGenerationTask(config, "测试")).rejects.toThrow();
            expect(calls).toBe(1);
        } finally { axios.defaults.adapter = original; }
    });

    test("settings show model duration and orientation in both themes without misleading controls", () => {
        for (const theme of Object.values(canvasThemes)) {
            const html = renderToStaticMarkup(<VideoSettingsPanel config={config} theme={theme} onConfigChange={() => { throw new Error("Must not change the old defaults"); }} />);
            expect(html).toContain("10 秒");
            expect(html).toContain("横屏");
            expect(html).not.toContain("30");
            expect(html).not.toContain("<input");
        }
        const summary = renderToStaticMarkup(<CanvasVideoSettingsPopover config={config} onConfigChange={() => {}} />);
        expect(summary).toContain("10s");
        expect(summary).toContain("16:9");
        expect(summary).not.toContain("30s");
        expect(summary).not.toContain("1080p");
    });
});
