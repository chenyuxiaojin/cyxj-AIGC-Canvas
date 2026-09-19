# 保存冲突处理与生成直接执行验收

## 范围和结果

本次实现保存冲突完整处理与画布生成取消二次确认。正式安装和窗口验收记录在下节；不把工程替身测试当作真实视频生成成功。

- 保存使用结构化错误码，区分待保存、保存中、可重试错误、冲突与处理中；冲突后停止旧基线重发。
- Rust 在同一写事务内返回已保存文档与修订号，前端串行保存并使迟到回执失效。读回完全相同正文才识别丢失回执，不能仅靠时间戳判断成功。
- 使用最新版本之前，IndexedDB 持久记录原编辑并读回校验，再检查最新修订号，写入采用标记；重启以该标记恢复。保留本机视图，重置撤销历史适用范围。
- 另存编辑保留正文、关系、聊天、素材引用和原任务身份，副本不恢复生成指令；原项目仍保留冲突草稿。
- 界面和 CLI/API/MCP 共用 store 的比较与处理动作。程序选择须携带 `save_inspect` 返回的 `draftToken`，防止旧选择处理新输入。CLI 使用 `tasks submit`，MCP 使用 `canvas_task`，任务回查沿用原入口。
- 新生成请求直接进入队列，统一任务弹窗、节点批准按钮及两项生成审批设置下线；旧视频接口同样直接启动已有执行器。旧 `pending_approval` 记录不自动启动，删除确认不变。

## 自动化验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 真实保存 store / 恢复 / 原素材协议 | 25 通过 | `node --test docs/progress/canvas-repair.test.mjs` |
| 页面外部同步与自动保存时序 | 3 通过 | `node --test docs/progress/canvas-save-sync.test.mjs` |
| 真实任务分发与助手动作，替身 IPC | 6 通过 | `node --test docs/progress/canvas-save-dispatch.test.mjs` |
| 画布协议、操作 store、既有 Omni Flash | 27 通过 | `bun test tests/canvas-operation-protocol.test.ts tests/canvas-store-operation.test.ts tests/omni-flash-video.test.tsx` |
| 界面收敛及 R9 运行时 | 19 通过 | `canvas-ui-optimization.test.mjs` / `canvas-r9-runtime.test.mjs` |
| Rust Agent 适配器 | 49 通过 | `cargo test --locked --manifest-path integrations/local-agent-adapter-rust/Cargo.toml` |
| Rust 桌面库 | 65 通过、3 按条件跳过 | `cargo test --locked --lib`；真实模型和指定原素材测试未触发 |
| TypeScript | 通过 | `web/node_modules/.bin/tsc --noEmit --pretty false -p web/tsconfig.json` |

原生首轮发现外部文档已发布到 store、页面却等待缓存写入的短暂空窗，会触发旧节点自动保存。已改为同一同步步骤发布 store 与编辑器快照，缓存完成后才报告保存成功；新增真实页面函数回归覆盖该时序与缓存失败。

保存测试包含：双写入者、持续输入、处理中再次外部修改、迟到回执、持久化失败、回执丢失、采用标记失败、恢复副本、重启、仅视图改动、单项目故障、删除及任务不重复提交。视频接口用计数替身断言重复请求只启动一次，没有真实付费请求。

`local-workflow.test.mjs` 的桌面持久化用例通过。全套仍有 3 个既有失败（旧素材路径、旧设置页结构、旧轮询提取方式），在未改动的原工程也复现；不将其计入本次通过项。

## 正式安装和窗口验收

安装前已正常退出 App，完整备份并验证 App、Application Support、WebKit 三个 ZIP，同时保存 SQLite 快照与逐表哈希。证据目录：`/Users/chenhuajin/项目/自己的应用/infinite-canvas-backups/local-installs/save-conflict-fix-20260920-023230/`。

通过 `desktop` 的 `build:app` 完成构建、签名校验与安装。唯一正式入口为 `~/Applications/小陈的画布.app`，构建目录不留第二个可运行 App；旧包压缩校验后已移入废纸篓。Web/API 子进程均由正式 App 后台启动，无终端窗口。

原生最终验收使用 `save-conflict-native-final-20260920`：

1. 外部新增节点后，原生页面、store 比较结果、数据库均为 2 节点，持续读回未被旧编辑器写回。
2. 保持标题编辑时，外部写入第三节点；提交本机标题后显示“版本待处理”，摘要正确为本机 2 / 最新 3，原项目最新内容未被覆盖。
3. 点击“另存当前编辑”，恢复副本 `TZDhCgxTWCLI_L7FxCZc1` 保存 2 节点与本机标题；原项目保持 3 节点。返回原项目仍能继续处理冲突。
4. 点击“使用最新版本”，原生页面立即显示 3 节点、外部标题和“已保存”，撤销历史重置；改名为“验收通过 · 继续保存”再次保存成功。
5. 正常退出并重启，通过首页打开，仍为新标题、3 节点、“已保存”，旧草稿未夺回页面；CLI 比较结果也为 3 / 3。
6. 使用 CLI 提交引用不存在节点的 `generate_video` 请求，立即返回 `queued`，随后执行器以 `node_not_found` 结束。未出现审批弹窗、未调用媒体服务；重交相同请求返回 `duplicate: true`，数据库只存在 1 条任务。
7. 首轮复现项目另经 `save_inspect` → 携带 token 的 `save_use_latest` 在正式 App 队列处理成功；相同请求重复提交返回已有结果。CLI 请求及完整回执保存在证据目录。

安装前后 28 条原项目（含删除记录）的正文与删除标记、既有任务记录逐字节相同；146 个原有本机文件哈希相同，媒体根目录登记仅序列化格式变化、内容相同。浏览器渠道配置记录逐字节一致，SQLite 完整性为 `ok`。未覆盖正式跨朝代画布，也未新增真实生成任务。

## 交付边界

- 实机只用 `save-conflict-native-20260920`、`save-conflict-native-final-20260920` 及其恢复副本制造冲突。原跨朝代画布只读核对，不以修复旧数据代替程序测试。
- 候选包包含原工程快照中的已安装 Omni Flash 能力；原工程没有改写。这些既有改动与本次修复分开，测试与安装包含它们，本次提交不包含既有 Omni Flash 源码。上表 Omni 用例来自该未提交基线；本次提交的协议与 store 用例可独立运行。
- 本次未发起真实模型或媒体调用，真实成片效果及全产品 R1–R9 验收不在本报告中宣称通过。
