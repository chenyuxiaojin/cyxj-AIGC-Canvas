# AIGC Agent 续作交接

本交接用于恢复 `ancient-attire-v2-20260919` 的图生视频任务。修复已合入并推送 `main`，代码提交 `b11dc66`；正式 App 已更新并启动，BUILD_ID 为 `EEGCQQ3Sivduu8_X253Gc`。开发使用 `~/项目/自己的应用/小陈的画布` 的最新主线；不要为续作启动旧 worktree 或废纸篓中的 App。

## 已修复与验证边界

- `local-ref:` 原图已经接入节点生成、参考图、首尾帧及历史重试读取。素材并未丢失，不需要重新生图、转图床或把本地引用手工写成 data URL。
- 独立命令不再借用侧栏会话的旧操作版本；桌面后台收取已提交结果，视频预览和空字段不再阻塞下一条命令。
- 79 项自动化测试及原生协议替身生成、落盘、播放、连续接续和冷启动通过；没有追加真实供应商付费生成，因此仍需按用户的创作授权验收实际成片。
- 32 个原有项目正文、84 份原图和 7 个渠道配置均已对账保留。证据见 [修复验收](../progress/canvas-generation-reference-repair.md)。

## 收到用户“继续”后

正式 CLI 使用 `/Users/chenhuajin/Applications/小陈的画布.app/Contents/MacOS/infinite-canvas`，默认 Bridge 为 `127.0.0.1:3102`。不要打印或复制凭据。

1. 先用 `projects status ancient-attire-v2-20260919` 读取当前状态，再用 `projects node ancient-attire-v2-20260919 i-s00` 和目标视频节点 ID 核对输入及输出位置。日常状态查询使用这两个轻量接口，避免反复读取包含历史的完整项目。
2. 用 `tasks list ancient-attire-v2-20260919` 与 `tasks get PROJECT_ID REQUEST_ID` 核对旧任务。已经受理、提交或完成的任务先查结果，不再次提交；旧中断任务逐项核对后再决定是否继续，不批量唤醒。
3. 新动作的 `base_revision` 使用刚读取的 `projects status` 返回的 **revision 字符串**。不要复用截图中的版本、旧请求载荷，或把数字 `operationRevision` 填入这个字段。真正冲突时重新读取并协调当前编辑，不能覆盖旧快照或盲目重试。
4. 复用原有图片和明确的目标视频节点；已有节点用 `generate_node`，确实需要新节点才用 `generate_video` 并明确 `sourceNodeIds`。保持原创作任务已确定的渠道、型号、时长及声音设置，不因默认渠道变化而改模型。
5. 先单发当前目标，读取回执直至完成并核对生成的视频，再按用户已授权的场次继续。新一次生成使用新的唯一 `request_id`；同一提交的响应不明时，按原 ID 查询，不能换 ID 重发。

## 两条旧失败记录

以下记录已现场只读核实，升级不会改写历史失败回执：

| 请求 ID | 原失败 | 恢复方式 |
| --- | --- | --- |
| `vidn30-s00-ed0bc308` | `EXECUTION_FAILED / Load failed` | 原图解析已修复；先检查目标节点和任务记录，用户授权继续后再创建新动作 |
| `vid30-s00-89f31f43` | `stale_revision`，745 → 746 | 命令独立版本已修复；重新读取当前 revision 后创建新动作 |

重复查询旧请求仍显示 failed 是历史记录，不代表新版修复失效。不要为清除这些显示而删除原图、节点或历史。此交接本身只传递状态，不授权新增付费任务。
