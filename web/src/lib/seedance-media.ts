import { localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";

// Capabilities verified at /v1/media/models. Other Seedance providers differ.
export const seedanceMediaDurations: Record<string, number[]> = {
    "seedance2.5": [30], "seedance2.0": [5, 10, 15],
    "seedance2.0fast": [5, 10, 15], "seedance2.0mini": [5, 10],
};

export function isSeedanceMediaConfig(config: AiConfig) {
    return config.channelMode === "local" && localChannelForActiveModel(config)?.videoApiMode === "media";
}

export function seedanceMediaDuration(model: string, value: string) {
    const options = seedanceMediaDurations[model];
    if (!options) throw new Error("当前媒体接口不支持此模型，请重新选择 Seedance 模型");
    return options.includes(Number(value)) ? Number(value) : options[0];
}
