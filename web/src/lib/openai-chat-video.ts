// Some OpenAI-compatible gateways deliver a video URL inside an assistant reply.
export function parseOpenAIChatVideoResponse(payload: unknown, fallbackId: string) {
    if (typeof payload === "string") {
        const text = payload;
        try { payload = JSON.parse(text); }
        catch {
            if (!text.startsWith("data:") && !text.startsWith("event:")) throw new Error("视频接口返回了非 JSON 内容，请检查服务地址");
            const events = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).flatMap((line) => {
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") return [];
                return [JSON.parse(data)];
            });
            const failed = events.find((event) => event.error);
            if (failed) throw new Error(failed.error.message || "视频生成失败");
            payload = { ...events.at(-1), choices: [{ message: { content: events.map((event) => event.choices?.[0]?.delta?.content || event.choices?.[0]?.message?.content || "").join("") } }] };
        }
    }
    const record = asRecord(payload);
    if (record.error) throw new Error(String(asRecord(record.error).message || record.error));
    const texts: string[] = [];
    const collect = (value: unknown, depth = 0) => {
        if (depth > 8 || value == null) return;
        if (typeof value === "string") { texts.push(value); return; }
        if (Array.isArray(value)) { value.forEach((item) => collect(item, depth + 1)); return; }
        const item = asRecord(value);
        for (const key of ["video_url", "url", "download_url", "choices", "message", "content", "text", "output", "result", "metadata", "data"]) collect(item[key], depth + 1);
    };
    collect(record);
    const urls = texts.flatMap((text) => text.match(/https?:\/\/[^\s<>"\]\)]+/g) || []).map((url) => url.replace(/&amp;/g, "&"));
    const videoUrl = urls.find((url) => /\.(mp4|mov|webm)(?:[?#]|$)/i.test(url)) || urls[0];
    const taskId = firstString(record.task_id, record.video_id, asRecord(record.data).task_id);
    if (videoUrl) return { id: firstString(record.id, taskId, fallbackId), status: "completed", progress: 100, video_url: videoUrl, url: videoUrl };
    if (taskId) return { id: taskId, task_id: taskId, status: firstString(record.status, "queued") };
    throw new Error("接口已回复，但没有返回视频地址或视频任务号；请保留响应排查，不要重复生成");
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]) {
    return values.find((value): value is string => typeof value === "string" && !!value.trim())?.trim() || "";
}
