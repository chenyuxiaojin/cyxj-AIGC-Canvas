import { afterAll, expect, mock, test } from "bun:test";
import axios from "axios";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";

const originals = new Map<string, Blob>();
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 18, 90]);
const reads: Array<{ projectId: string; storageKey: string }> = [];
mock.module("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: async (name: string, args: { projectId: string; storageKey: string }) => {
    expect(name).toBe("read_canvas_local_media");
    reads.push(args);
    if (args.projectId !== "fixture" || args.storageKey === "local-ref:missing") throw new Error("素材不属于当前画布或文件不存在");
    return png.slice().buffer;
} }));
mock.module("localforage", () => ({ default: { createInstance: () => ({ getItem: async (key: string) => originals.get(key) || null, setItem: async () => {} }) } }));
class TestFileReader {
    result = "";
    onload?: () => void;
    readAsDataURL(blob: Blob) { void blob.arrayBuffer().then((bytes) => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`; this.onload?.(); }); }
}
const oldReader = globalThis.FileReader;
// Substitute browser IO only; resolution, graph hydration and provider payload use production code.
Object.assign(globalThis, { FileReader: TestFileReader });
const { imageToDataUrl } = await import("../src/services/image-storage");
const { readMediaOriginal } = await import("../src/services/file-storage");
const { buildNodeGenerationContext, hydrateNodeGenerationContext } = await import("../src/app/(user)/canvas/components/canvas-node-generation");
const { CanvasNodeType } = await import("../src/app/(user)/canvas/types");
const { createVideoGenerationTask } = await import("../src/services/api/video");
const { useConfigStore } = await import("../src/stores/use-config-store");
const originalAdapter = axios.defaults.adapter;
const originalFetch = globalThis.fetch;
const requests: any[] = [];
axios.defaults.adapter = async (request) => { requests.push(request); return { status: 200, statusText: "OK", config: request, headers: {}, data: { id: "fixture-task", status: "queued" } }; };
globalThis.fetch = (() => { throw new Error("Unexpected network fetch"); }) as typeof fetch;
afterAll(() => { axios.defaults.adapter = originalAdapter; globalThis.fetch = originalFetch; globalThis.FileReader = oldReader; });
const reference = { id: "image", name: "original.png", type: "image/png", dataUrl: "local-ref:asset-test", storageKey: "local-ref:asset-test" };
const config = { ...useConfigStore.getState().config, channelMode: "local" as const, model: "seedance2.5", videoModel: "seedance2.5", videoSeconds: "30", videoChannelId: "fixture", localChannels: [{ id: "fixture", name: "test", protocol: "openai" as const, baseUrl: "http://127.0.0.1:3320/v1", apiKey: "fake", models: ["seedance2.5"], videoApiMode: "media" as const }] };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("local-ref reaches Seedance image_urls byte-for-byte without mutating source or duplicate IO", async () => {
    const before = JSON.stringify(reference), count = reads.length;
    const dataUrl = await imageToDataUrl({ ...reference, projectId: "fixture" });
    await createVideoGenerationTask(config, "fixture", [{ ...reference, dataUrl, projectId: "fixture" }]);
    const body = JSON.parse(requests.at(-1).data);
    expect(body.image_urls[0]).toStartWith("data:image/png;base64,");
    expect(hash(Buffer.from(body.image_urls[0].split(",")[1], "base64"))).toBe(hash(png));
    expect(reads.length - count).toBe(1);
    expect(reads.at(-1)).toEqual({ projectId: "fixture", storageKey: reference.storageKey });
    expect(JSON.stringify(reference)).toBe(before);
});
test("graph references, first/last frames and advanced media retain explicit project scope", async () => {
    const nodes = ["first", "last", "ordinary"].map((id) => ({ id, title: id, type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: reference.dataUrl, storageKey: reference.storageKey } }));
    const target = { id: "target", title: "target", type: CanvasNodeType.Video, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { firstFrameNodeId: "first", lastFrameNodeId: "last" } };
    const source = buildNodeGenerationContext("target", [...nodes, target], nodes.map((node) => ({ id: node.id, fromNodeId: node.id, toNodeId: "target" })), "fixture");
    source.referenceVideos = [{ id: "v", name: "v.mp4", type: "video/mp4", url: reference.dataUrl }];
    source.referenceAudios = [{ id: "a", name: "a.mp3", type: "audio/mpeg", url: reference.dataUrl }];
    source.videoElementList = [{ name: "person", description: "", references: [{ ...reference, kind: "image" }] }];
    const before = JSON.stringify(source), hydrated = await hydrateNodeGenerationContext(source, "fixture");
    for (const image of [...hydrated.referenceImages, hydrated.firstFrame!, hydrated.lastFrame!]) { expect(image.projectId).toBe("fixture"); expect(image.dataUrl).toStartWith("data:image/png;base64,"); }
    expect(hydrated.referenceVideos[0].projectId).toBe("fixture");
    expect(hydrated.referenceAudios[0].projectId).toBe("fixture");
    expect(hydrated.videoElementList[0].references[0].projectId).toBe("fixture");
    expect(JSON.stringify(source)).toBe(before);
});
test("missing/wrong project fails before provider submission; local-ref is never fetched as a URL", async () => {
    const count = requests.length;
    for (const image of [reference, { ...reference, projectId: "other" }, { ...reference, storageKey: "local-ref:missing", projectId: "fixture" }]) await expect(createVideoGenerationTask(config, "fixture", [image])).rejects.toThrow();
    expect(requests.length).toBe(count);
});
test("local audio/video originals use scoped reads, including content-only references", async () => {
    for (const type of ["video/mp4", "audio/mpeg"]) {
        const blob = await readMediaOriginal(undefined, reference.dataUrl, "fixture", type);
        expect(blob.type).toBe(type); expect(hash(new Uint8Array(await blob.arrayBuffer()))).toBe(hash(png));
    }
});
test("existing IndexedDB images and inline images still work", async () => {
    originals.set("image:old", new Blob([png], { type: "image/png" }));
    const data = await imageToDataUrl({ storageKey: "image:old" });
    expect(await imageToDataUrl({ dataUrl: data })).toBe(data);
    expect(await imageToDataUrl({ dataUrl: reference.dataUrl, projectId: "fixture" })).toBe(data);
});

 test("saved retry references resolve local originals and preserve stable storage keys", async () => {
    const page = readFileSync(new URL("../src/app/(user)/canvas/[id]/canvas-client-page.tsx", import.meta.url), "utf8");
    const start = page.indexOf("async function resolveMetadataReferences(");
    const code = ts.transpileModule(page.slice(start, page.indexOf("function prepareCanvasNodes", start)) + "exports.resolve=resolveMetadataReferences;", { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const context = { exports: {} as { resolve: (metadata: unknown, project: string) => Promise<any> }, imageToDataUrl };
    vm.runInNewContext(code, context);
    const refs = await context.exports.resolve({ generationType: "edit", references: [reference.storageKey] }, "fixture");
    expect(refs[0].storageKey).toBe(reference.storageKey);
    expect(refs[0].projectId).toBe("fixture");
    expect(hash(Buffer.from(refs[0].dataUrl.split(",")[1], "base64"))).toBe(hash(png));
});
