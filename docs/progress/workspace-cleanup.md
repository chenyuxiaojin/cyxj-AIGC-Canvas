# 本地文件夹改名与开发副本清理

## 已完成

- 主项目由 `infinite-canvas` 改为 `小陈的画布`，已修复 Git 工作树关联并更新工作区导航、README 与现行开发指南。
- 改名瞬间核对 635 个源码/未跟踪文件的 SHA-256 或链接目标，内容及 Git 修改状态完全一致。
- 清理前未发现进程打开副本中的文件；13 个副本的已提交内容均被本地 `main` 和已保存的 `origin/main` 包含。两者提交均为 `171ee7a19bd3b39bbd0695bd57370184550ccb99`；本轮没有联网刷新远端。
- 移除了全部 13 个副本和空的副本总目录；保留全部分支，不切换主项目分支，不覆盖原有未提交工作。
- 原有备份目录、正式 App 及应用业务数据保留。
- 磁盘可用空间前后实测：29.8 GB → 67.5 GB，净增约 37.7 GB（十进制；系统其他活动会影响实时数值）。

## 逐项检查

| 副本 | 检查结果 | 处置 |
| --- | --- | --- |
| `agent-image-ingest` | 已合入 main；无未提交修改 | 删除副本，保留分支 |
| `bridge-node-whitelist` | 已合入 main；无未提交修改 | 删除副本，保留分支 |
| `external-connectors` | 已合入 main；无未提交修改 | 删除副本，保留分支 |
| `human-agent-canvas-core` | 已合入 main；无未提交修改 | 删除副本，保留分支 |
| `human-agent-collaboration-ui` | 已合入 main；无未提交修改 | 删除副本，保留分支 |
| `human-agent-integration` | 已提交内容已合入；另有 7 个修改文件、3 个未跟踪文件 | 完整源码快照与补丁已校验归档，再删除副本 |
| `local-agent-adapter` | 已合入 main；无未提交修改 | 删除副本，保留分支 |
| `local-ai-audio` | 已合入 main；无未提交修改；另有 4 个音频验收文件 | 验收文件已校验归档，再删除副本 |
| `local-executor` | 已合入 main；无未提交修改 | 删除副本，保留分支 |
| `local-media-reference-streaming` | 已合入 main；无未提交修改；另有 1 个项目 ZIP、3 张验收图片 | ZIP 与图片已校验归档，再删除副本 |
| `main-integration` | 已合入 main；无未提交修改 | 删除副本，保留分支 |
| `paid-generation` | 已合入 main；无未提交修改 | 删除副本，保留分支 |
| `upstream-060-cherrypick` | 已合入 main；无未提交修改 | 删除副本，保留分支 |

其余未跟踪且被忽略的内容为依赖目录、Rust/Next 构建缓存、打包资源和生成文件。逐副本清单保存在 `worktree-inventory.json`；这些可重新构建，未另存体积庞大的构建副本。

## 恢复资料

恢复目录：`/Users/chenhuajin/项目/自己的应用/infinite-canvas-backups/folder-cleanup-20260914-103722`。

- `worktree-recovery.tar.gz`：522 个文件，包含人机集成副本的完整源码快照及两个副本的验收数据；约 21.1 MB。
- `recovery-file-manifest.json`：逐文件路径、大小、权限和 SHA-256；归档后已逐项读回校验。
- `human-agent-integration.patch`：未提交的已跟踪代码差异；3 个未跟踪文件已包含在源码归档中。
- `worktree-inventory.json`、`cleanup-receipts.json`：原路径、分支、提交、修改状态和删除记录。
- `main-file-hashes-before.json`、`main-status-before.bin`、`main-diff-before.patch`：主项目改名前的核对资料。

所有原分支都仍在主项目 Git 仓库中。恢复普通副本时，以清单里的分支创建新的 Git worktree；恢复人机集成副本时先检出 `feat/human-agent-canvas-integration`，再覆盖归档中 `human-agent-integration/` 下的源码内容。恢复测试数据时只提取对应归档路径。

## 验证范围

本轮仅调整本地工程目录及开发副本，不改产品逻辑。已检查主项目文件完整性、原有修改状态、所有分支提交、工作树登记和归档校验。构建脚本根据自身位置计算源码路径，不依赖旧目录名；未发现需要迁移的启动配置或绝对符号链接。历史验收记录保留当时路径。

没有重新构建、启动正式 App 或进行运行内存泄漏测试；既有功能验收待办保持原状态。
