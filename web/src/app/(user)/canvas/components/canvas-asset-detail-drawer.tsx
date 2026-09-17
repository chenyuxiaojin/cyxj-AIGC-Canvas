"use client";

import { Copy, Download, PencilLine, Plus, Trash2 } from "lucide-react";
import { App, Button, Drawer, Image, Space, Tag, Typography } from "antd";
import { saveAs } from "file-saver";

import { useStoredMediaSource } from "@/hooks/use-stored-media-source";
import { useCopyText } from "@/hooks/use-copy-text";
import { assetMediaReference } from "@/services/asset-media-reference";
import { readCanvasMediaBlob } from "@/services/canvas-media";
import { formatBytes } from "@/lib/image-utils";
import { useAssetStore, type Asset, type AssetKind } from "@/stores/use-asset-store";

/** 左侧「资产」页签里点开一张素材后的详情抽屉：素材的编辑 / 复制 / 下载 / 删除 / 插入画布都在这里 */
export function CanvasAssetDetailDrawer({ asset, onClose, onEdit, onInsert }: { asset: Asset | null; onClose: () => void; onEdit: (asset: Asset) => void; onInsert: (asset: Asset) => void }) {
    const { message, modal } = App.useApp();
    const copyText = useCopyText();
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const reference = assetMediaReference(asset, true);
    const coverSource = useStoredMediaSource(reference);
    const contentSource = useStoredMediaSource(assetMediaReference(asset));
    const cover = reference.image ? coverSource.src : "";

    const download = async (item: Asset) => {
        if (item.kind === "text") return;
        try {
            const original = item.data.storageKey ? await readCanvasMediaBlob("", item.data.storageKey, item.data.mimeType) : item.kind === "image" ? item.data.dataUrl : item.data.url;
            saveAs(original, `${item.title || "asset"}.${item.data.mimeType.split("/")[1] || "png"}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载原素材失败");
        }
    };
    const confirmDelete = (item: Asset) => {
        modal.confirm({
            title: "删除素材？",
            content: `「${item.title}」会从我的素材中移除，已插入画布的节点不受影响。`,
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            centered: true,
            onOk: () => {
                removeAsset(item.id);
                message.success("素材已删除");
                onClose();
            },
        });
    };

    return (
        <Drawer title="素材详情" open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {cover ? (
                        <Image src={cover} alt={asset.title} className="rounded-lg" />
                    ) : (
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : "暂无封面"}</div>
                    )}
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{assetKindLabel(asset.kind)}</Tag>
                            {(asset.tags || []).map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                            {asset.source ? <Tag>{asset.source}</Tag> : null}
                        </Space>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                        <Typography.Text type="secondary" className="block text-xs">
                            内容
                        </Typography.Text>
                        {asset.kind === "text" ? (
                            <Typography.Paragraph className="mt-2 whitespace-pre-wrap">{asset.data.content}</Typography.Paragraph>
                        ) : asset.kind === "video" ? (
                            <video src={contentSource.src || undefined} controls className="mt-2 aspect-video w-full rounded-lg bg-black" />
                        ) : asset.kind === "audio" ? (
                            <audio src={contentSource.src || undefined} controls className="mt-2 w-full" />
                        ) : (
                            <Typography.Text className="mt-2 block">
                                {asset.data.width}x{asset.data.height} · {formatBytes(asset.data.bytes)} · {asset.data.mimeType}
                            </Typography.Text>
                        )}
                    </div>
                    {asset.note ? (
                        <div>
                            <Typography.Text type="secondary">备注</Typography.Text>
                            <Typography.Paragraph className="mt-1">{asset.note}</Typography.Paragraph>
                        </div>
                    ) : null}
                    <Space wrap>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => onInsert(asset)}>
                            插入画布
                        </Button>
                        <Button icon={<PencilLine className="size-4" />} onClick={() => onEdit(asset)}>
                            编辑
                        </Button>
                        {asset.kind === "text" ? (
                            <Button icon={<Copy className="size-4" />} onClick={() => copyText(asset.data.content, "文本已复制")}>
                                复制文本
                            </Button>
                        ) : (
                            <Button icon={<Download className="size-4" />} onClick={() => void download(asset)}>
                                {asset.kind === "video" ? "下载视频" : asset.kind === "audio" ? "下载音频" : "下载图片"}
                            </Button>
                        )}
                        <Button danger icon={<Trash2 className="size-4" />} onClick={() => confirmDelete(asset)}>
                            删除
                        </Button>
                    </Space>
                </div>
            ) : null}
        </Drawer>
    );
}

function assetKindLabel(kind: AssetKind) {
    if (kind === "image") return "图片";
    if (kind === "video") return "视频";
    if (kind === "audio") return "音频";
    return "文本";
}
