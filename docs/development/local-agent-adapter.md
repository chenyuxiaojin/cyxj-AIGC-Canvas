# 本机 Agent 适配层

无限画布桌面版提供正式的本机 Agent Bridge 和 `infinite-canvas` CLI。Codex、Claude Code 等进程通过结构化协议操作画布，不需要注册网页账号，也不需要模拟鼠标点击。

## 安全边界

- Bridge 固定监听 `127.0.0.1:3102`，拒绝 `localhost`、`0.0.0.0`、IPv6 和公网地址。
- 桌面首次启动时在应用数据目录生成安装专属凭据，文件权限为 `0600`，目录权限为 `0700`。
- CLI 只从凭据文件读取认证信息；不提供 token 命令行参数，也不要把凭据写入环境变量、日志、脚本或项目导出。
- `infinite-canvas credentials revoke` 会立即废止当前 bearer，并把替代凭据原子写回同一私有文件；响应不会返回 secret。
- Bridge 没有任意 shell、任意可执行文件、任意路径、任意 URL、原始 SQL
  入口。媒体生成通过画布任务入口执行，按该项目的用户授权处理。
- Agent 写请求必须包含 `project_id`、`request_id`、`base_revision` 和
  `actor: "agent"`。人类编辑造成 revision 变化时，Agent 写入以
  `REVISION_CONFLICT` 失败，不覆盖较新的人工版本。
- 节点带有 `locked: true`、`metadata.locked: true` 或
  `metadata.agentLocked: true` 时，Agent 不能修改该节点。

桌面 WebView 通过 Tauri IPC 读写同一份 SQLite `canvas_projects` 表；
Agent Bridge 也通过隔离的 `CanvasOperationAdapter` 使用该表。不存在
第二份 Agent 画布数据库。旧的桌面 IndexedDB 项目会在桌面版下次加载时
按 `updatedAt` 合并到该表。

## 安装 CLI

正式应用为 `~/Applications/小陈的画布.app`，安装器维护 `~/.local/bin/infinite-canvas` 指向包内 CLI，不需要 sudo 或另装第二份应用。

CLI 默认连接 `http://127.0.0.1:3102`，并读取：

```text
~/Library/Application Support/com.chenyuxiaojin.infinitecanvas/agent-bridge/credential.json
```

不要查看或复制该文件内容。需要使用开发实例时，只传不同的凭据文件路径；凭据本身仍不出现在命令行：

```bash
infinite-canvas --credential-file /path/to/private/credential.json capabilities
```

## 常用命令

所有成功和业务错误都输出 JSON。稳定退出码为：`0` 成功、`2` 参数或请求
schema 错误、`3` Bridge/运行时不可用、`4` 未认证、`5` revision/幂等冲突、
`6` 未找到、`7` 能力被策略拒绝、`1` 其他内部错误。

```bash
infinite-canvas capabilities
infinite-canvas projects list
infinite-canvas projects get PROJECT_ID
infinite-canvas canvas operations dry-run --file request.json
infinite-canvas canvas operations apply --file request.json
infinite-canvas runtime
infinite-canvas tasks status TASK_ID
infinite-canvas tasks cancel TASK_ID
infinite-canvas tasks test-clip --file test-clip-request.json
infinite-canvas tasks submit --file canvas-command.json
infinite-canvas tasks get PROJECT_ID REQUEST_ID
infinite-canvas tasks stop PROJECT_ID REQUEST_ID
infinite-canvas projects action PROJECT_ID --file project-action.json
infinite-canvas media upload PROJECT_ID --file original.png
infinite-canvas media download PROJECT_ID ARTIFACT_ID --file downloaded.png
infinite-canvas credentials revoke
```

`--file -` 可从标准输入读取 JSON。`tasks status/cancel/test-clip` 保留原本地运行时契约；新画布任务用 `submit/get/stop`。媒体生成能力已开放，尚未获得项目授权时返回 `pending_approval`，不能把排队回执当作成功素材。

## 画布操作请求

先用 `projects get` 读取最新 revision，再准备请求文件：

```json
{
  "project_id": "PROJECT_ID",
  "request_id": "agent-run-0001",
  "base_revision": "PROJECT_REVISION_SHA256",
  "actor": "agent",
  "operations": [
    {
      "type": "create_text_node",
      "node_id": "agent-note-1",
      "title": "Agent 草稿",
      "content": "这是可继续人工编辑的文本节点。",
      "position": { "x": 240, "y": 160 },
      "size": { "width": 360, "height": 220 }
    }
  ]
}
```

通用操作包括 `create_node`、`update_node`、`delete_node`、`set_group_members`、`update_project`，并保留原来的 `create_text_node`、`move_node`、`set_node_text`、`set_project_title`、`add_connection`、`remove_connection`。

`create_node.node` 接收 `id/type/title/position/width/height/metadata`，支持 text、image、panorama、video、audio、config、director、group。`update_node.patch` 可修改标题、位置、尺寸及 metadata；metadata 是逐字段合并，字段设为 null 表示移除，身份和人工锁定状态不由 Agent 改写。分组用 `set_group_members` 维护成员，移动分组同时移动成员；删除保留原媒体及操作前后的持久历史。

先 dry-run，再用读取时的同一个 `base_revision` apply。同一 `request_id` 和同一 payload 返回原结果并标记 `duplicate: true`，不同载荷返回 `REQUEST_ID_REUSED`。冲突必须读回新内容再决定如何修改。

## 画布任务与素材

```json
{
  "project_id": "PROJECT_ID",
  "request_id": "create-image-0001",
  "base_revision": "PROJECT_REVISION_SHA256",
  "action": "generate_node",
  "arguments": { "nodeId": "IMAGE_NODE_ID", "mode": "image", "prompt": "本次生成要求" }
}
```

App 必须运行。先用同样结构提交 `open_project`（arguments 为空），等待成功后读取当前版本，再提交生成或其他页面任务。生成调用 App 中已配置的渠道，不接受任务内 API Key。相同请求编号不能用于一次新的收费尝试；中断先查询原任务和节点。

可用动作和参数见 MCP 工具 schema、`capabilities` 及 [R9 覆盖表](../progress/canvas-r9-integration.md)。导入先上传原文件获得 `artifact_id`，再提交 `import_media`；导出或 `read_media` 返回的 `artifact_id` 可下载到新文件。单件上限 512 MiB，校验 SHA-256，已有文件不覆盖。MCP `canvas_media` 的本地路径限于明确绑定的片子目录。

未执行的取消成为 `cancelled`；执行中的取消成为 `cancel_requested`，不承诺远端撤销或退款。重启中的未完成执行标为 `interrupted`，不自动重新调用模型。成功必须有真实执行回执和节点结果，`queued`、`running`、`submitted` 不是成功。

MCP 工具为 `canvas_context`、`canvas_read`、`canvas_mutate`、`canvas_task`、`canvas_project`、`canvas_media`。`canvas_mutate` apply 必须显式提供读取时的版本和稳定请求编号；`canvas_task` 保留 runtime，新任务用 submit/status/cancel，旧本地任务用 local_status/local_cancel。

本地测试片请求同样绑定项目、request 和 revision：

```json
{
  "project_id": "PROJECT_ID",
  "request_id": "local-test-clip-0001",
  "base_revision": "PROJECT_REVISION_SHA256",
  "actor": "agent"
}
```

## 当前运行路径与实现位置

正式桌面业务 API 已切 Rust，能力目录不再把 Go 图片任务接口当作本机活跃接口。画布媒体任务仍复用前端渠道适配器与原轮询/保存逻辑；通用编辑使用同一 SQLite 文档和 revision，尚未完全改造所有历史页面专用操作。完整覆盖与未测范围以 [R9 实施与验收](../progress/canvas-r9-integration.md) 为准。

- `integrations/local-agent-adapter-rust/`：HTTP/CLI/MCP、通用节点、版本、任务日志、原文件传输。
- `desktop/src-tauri/src/agent_bridge.rs`、`permissions/desktop-runtime.toml`：正式窗口的同源 IPC 与许可。
- `web/src/services/canvas-commands.ts`、`components/layout/canvas-command-dispatcher.tsx`：页面执行器登记、任务领取、授权及回执。
- 画布页面及 `stores/use-canvas-store.ts`：当前画布状态、外部更新、保存、现有创作函数。
- `desktop/scripts/prepare-desktop.mjs` 和 `tauri.conf.json`：完整前端、Rust API 和 CLI 打包。


新增统一任务：`mask_edit_image`、`generate_angle`、`retry_node`、`upscale_image`、`replace_media` 及 `director_read/director_capture/director_export_video`。参数、授权和正式验收状态以 [R9 实施与验收](../progress/canvas-r9-integration.md) 为准。任务可用 `infinite-canvas tasks list <project_id> --offset 0` 或 MCP `canvas_task` 的 `list` 查询，每页 100 条；`next_offset` 为空代表结束。
