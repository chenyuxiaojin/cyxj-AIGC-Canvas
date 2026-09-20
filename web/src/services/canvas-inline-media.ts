import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CanvasNodeMetadata, LocalMediaReference } from "@/app/(user)/canvas/types";
import { uploadImage } from "./image-storage";

// One result at a time; never retain the base64 as a cache key or in task history.
export async function persistCanvasInlineImage(data: string): Promise<CanvasNodeMetadata> {
    if (isTauri()) {
        const reference = await invoke<LocalMediaReference>("desktop_store_inline_media", { data });
        return { content: reference.storageKey, storageKey: reference.storageKey, localMedia: reference, bytes: reference.bytes, mimeType: reference.mimeType };
    }
    const image = await uploadImage(data, { localOnly: true, retainDisplayUrl: false });
    return { content: image.storageKey, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
}
