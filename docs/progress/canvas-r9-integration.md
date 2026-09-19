# 完整程序操作与人机共同编辑：实施与验收

依据 [PRD R9](../overview/product-requirements.md#r9--完整程序操作与人机共同编辑)。旧的六项白名单和 `paid_generation` 永久禁止已从当前能力目录移除。需求通过、源码实现、隔离测试、正式安装及真实模型验收分别记录。

## 当前结构

- Rust Agent Bridge、CLI 和 MCP 共用桌面 SQLite 文档与版本校验。新增通用节点操作、分组、项目设置、项目创建、版本历史与原文件传输。
- 生成及页面创作任务持久保存，由正式 App 当前画布的执行器消费。`open_project` 可以切到目标画布；普通节点编辑不依赖当前打开哪个画布。App 须运行，生成当前仍依赖页面执行器，未实现独立后台渲染器。
- 普通生成、局部编辑、换角度、重试按钮、侧栏生成和外部生成使用同一任务记录与现有模型调用函数。用户已要求取消画布额外确认，新请求直接返回 `queued` 并使用现有渠道执行；历史 `pending_approval` 请求不自动启动。请求幂等、版本检查、取消和真实回执保留。
- 写入使用读取时的 `base_revision`；同一个 `request_id`、同一载荷重复调用返回原回执。已领取任务重启后标为 `interrupted`，不自动重提。排队回执和上游受理均不等同于素材成功。
- 页面空闲且没有未保存内容时接收外部新版本；编辑或生成期间保留当前状态。冲突保留现有保存恢复机制。Agent 删除保留媒体文件，并保存删除前后版本用于恢复。页面上传/替换、拖入/粘贴、裁剪、分割、收藏、高清放大及导演台发送素材也进入任务队列；任务领取前强制保存当前版本，避免重试或替换丢掉旧素材引用。
- `cancelled` 表示尚未执行的任务已取消；`cancel_requested` 表示执行中的取消请求，不能据此宣称远端已取消或退款。已提交远端任务继续由原轮询路径获取结果。

## 操作覆盖表

| 业务 | CLI / API / MCP 入口 | 页面与侧栏衔接 | 证据状态 |
| --- | --- | --- | --- |
| 文本、图片、视频、音频、全景、配置、导演台、分组节点 | `create_node` / `update_node` / `delete_node`；完整 metadata 读写 | 同一项目与节点标识；侧栏新增 `canvas_mutate` | Rust 全类型、回滚、锁定、历史恢复测试通过；正式交互下文记录 |
| 连线、移动、分组与项目设置 | 原连线操作、`move_node`、`set_group_members`、`update_project` | 分组移动带动成员；无效视图参数拒绝写入 | 隔离测试通过 |
| 项目创建、打开、历史及恢复 | `projects action`、`open_project`；`canvas_project` | 打开指定项目并由页面保存；恢复走持久版本 | 隔离测试通过；正式创建、自动打开及 ZIP 新项目导入通过 |
| 原文件导入、读取、导出 | `media upload/download`；`import_media` / `read_media` / `export_project` / `import_project` | 复用原存储及 ZIP 打包，返回 SHA-256 artifact_id | 原文件 HTTP 大于 2 MiB 往返通过；正式 App 的 PNG 导入、读取、导出 ZIP 原字节核验通过 |
| 图片、视频、音频及全景生成 | `generate_image/edit_image/generate_video/generate_audio`；`generate_node` 使用指定节点的完整设置；`mask_edit_image` / `generate_angle` / `retry_node` | 普通生成和侧栏共用记录与执行器 | 授权、幂等、中断、取消测试通过；真实新生成未调用 |
| 裁剪、分割、高清放大、替换、截帧、收藏、整理、撤销与重做 | 同名任务；支持节点与比例参数 | 复用原页面业务函数 | 正式裁剪、高清放大、替换、批量导入及手动裁剪的统一任务回查通过；其余交互逐项核验 |
| 导演台 | metadata 编辑完整场景/机位/时间轴；`director_read` / `director_capture` / `director_export_video` | 通过消息协议调用现有 WebGL 截图与 H.264 时间轴导出；按原节点回填新素材 | 协议与参数错误测试通过；正式截图包含角色，1 秒 1280×720 H.264 导出与完整解码通过 |
| 本机 Agent 真实调用 | 侧栏注册新增工具；外部六个 MCP 工具 | 仍沿用各家现有协议 | 本轮协议替身通过；本轮未新增 Codex/Grok/Antigravity 真实模型调用 |

## 自动化验证

- Agent Bridge：33 项通过，包括真实 HTTP 传输、CLI 查询同一任务、MCP 发现、八种节点、原始浮点精度、版本冲突与删除恢复。
- 前端：90 项协议、保存、素材、导出、请求生命周期、生成早期异常及导演台消息协议回归通过。
- 桌面 Rust：51 项通过；3 项需要专项环境或真实调用的测试保留忽略。
- 生产 Next.js 构建与全量 TypeScript 检查通过。

## 正式 App 验收

已在正式 `~/Applications/小陈的画布.app` 验证，不以浏览器独立存储代替桌面数据：

- 隔离项目 `r9-native-acceptance` 创建八种节点。MCP stdio 实际发现六个工具，并修改原生页面可见的正文。
- 在正式窗口手动修改文字，CLI 读回完整正文；Agent 追加内容后，正式窗口显示人工正文及 Agent 续写，两边使用同一节点。
- `r9-import-image` / `r9-read-image` 导入并读出 179 字节 PNG，SHA-256 一致；`r9-crop-image` 在原节点旁生成裁剪结果。
- `r9-export` 导出 ZIP 含原 PNG 字节；`r9-import-project` 导入独立项目 `CI8kKI4ok-wwI4W3JuHAq`，自动打开后十个节点及正文一致。
- `r9-approval-only` 在正式窗口显示模型、数量和尺寸，经“取消任务”后为 `cancelled`。没有点击付费批准，没有调用真实媒体模型。
- 初次原生验收发现新命令未加入桌面权限清单，已修复并重新安装；前述任务在修复后的正式 App 通过。
- 最新正式安装后，原人工正文及已取消任务能查回；`r9-upscale-final` 生成 128×128 PNG；`r9-replace-final` 同节点替换后的 SHA-256 与上传文件一致，替换前版本可在历史中查到。
- 导演台已完成实际截图与 3 秒 MP4（1280×720 H.264）导出，视频完整解码通过。1 秒首次导出失败且没有结果节点；复核还发现截图先于角色加载完成。已补素材等待及编码器 start 事件等待，正式复验产出角色完整截图与 1.001667 秒、1280×720 H.264 MP4（47,646 字节），完整解码无错误。
- 手动在正式窗口点“确认裁剪”，生成任务 `JLtosXPEpNLHWwZLbzeCG`，CLI 能查询同一成功回执；两文件批量导入作为一项任务生成两个节点。
- 正常退出重启后，测试画布 18 节点及当时 26 条任务记录逐项完全相同（24 成功、1 取消、1 修复前失败）；再次从原节点读取视频，其原文件 SHA-256 一致。
- 最终已切回案例 5，43 节点、31 连线及原 58% 视口可见。案例 5 原图通过接口再次读取到 2,632,085 字节原文件。

原始证据及安装前数据备份：`../infinite-canvas-backups/r9-20260906-131640/`（相对仓库目录）。保留 App、Application Support 与 WebKit。切回案例 5 前，原有 16 条项目记录逐条原始字节相同；最终切回后，15 条原始字节相同，案例 5 仅更新了临时 Blob 预览地址、视口与保存时间。剔除这三类已核对的运行字段，16 条项目的正文、结构、关系、配置及稳定素材引用全部相同，数据库 integrity_check 为 ok。没有用旧快照覆盖当前画布来追求表面字节相同。

## 调用约定

HTTP 基址为 `http://127.0.0.1:3102`，鉴权继续由安装凭据承担，CLI 不要求把凭据写到参数里。JSON 操作文件可通过 `--file -` 从标准输入传入。

```text
infinite-canvas capabilities
infinite-canvas projects get <project_id>
infinite-canvas canvas operations apply --file operations.json
infinite-canvas tasks submit --file command.json
infinite-canvas tasks list <project_id> --offset 0
infinite-canvas tasks get <project_id> <request_id>
infinite-canvas tasks stop <project_id> <request_id>
infinite-canvas media upload <project_id> --file original.png
infinite-canvas media download <project_id> <artifact_id> --file downloaded.png
```

任务请求包含 `project_id`、`request_id`、`base_revision`、`action` 和 `arguments`。打开项目后重新读取版本再提交下一项写入；冲突先读取人工修改，不能悄悄套用新版本覆盖它。生成使用 App 已有渠道配置，任务不接收 API Key。

MCP 先读 `canvas_context`，再用 `canvas_read` 获取详细节点和版本；`canvas_mutate` 写入要求明确版本与稳定请求编号。`canvas_task` 提交、查询或取消任务；`canvas_project` 管项目与历史；`canvas_media` 只在明确绑定的片子目录内传输文件。超过单次 512 MiB 的文件当前明确拒绝。


## 新增参数与维护边界

- `upscale_image`：`nodeId`、`params: {targetLongEdge: 32..4096, algorithm: "high" | "bilinear" | "nearest"}`。本地放大，不调用模型。
- `replace_media`：`nodeId`、`artifact_id`、可选 `type` / `mimeType` / `title`；素材类型限定 image/panorama/video/audio，保留节点编号与旧版本。
- `mask_edit_image`：`nodeId`、标记 PNG 的 `artifact_id`、`prompt`、可选 `model` / `channelId`。`generate_angle` 的 params 为 horizontalAngle、pitchAngle、cameraDistance、wideAngle；`retry_node` 是显式新尝试，不能自动用于未知提交结果。
- `director_read/director_capture/director_export_video`：`nodeId`、可选 `cameraId` 和时间轴 `seconds`；截图 preset 为 current/four/twelve。生成素材保留原渲染字节，导出视频不涉及付费模型。
- `tasks list` / `canvas_task action=list` 按项目分页，每页最多 100 条，包括已完成和中断记录。中断记录不堵塞执行队列。
- 导演台当前上游交付为编译产物。本轮只在 vendored runtime 末尾导出原存储与渲染函数，新增独立 `agent-bridge.js` 消息适配；更新导演台上游时须同步核验导出绑定与截图/视频真实结果。

手动拖入/粘贴/收藏及导演台发送素材已接统一任务；批量发送作为一项任务保存，连续手动导入按完成顺序提交。正文拖动等即时编辑继续使用原保存和历史机制，素材/生成任务使用共同任务记录。原生交互逐项验收不以这些源码连接代替。各入口已有完整节点/项目读写入口；真实付费生成、本机 Agent 实际工具与剩余交互验收通过前，R9 不记为整体完成。

编码器启动依据 [MediaStream Recording 的 start 事件语义](https://w3c.github.io/mediacapture-record/#dom-mediarecorder-start)：开始录制的通知异步发出。当前适配在启动期间持续渲染第一帧，收到 start 后再计时间轴时长，防止短片在编码器就绪前结束。


## 最终安装与未完成验收

- 正式唯一入口：`/Users/chenhuajin/Applications/小陈的画布.app`，identifier 与数据目录保持；3100/3101/3102 三服务仅监听本机。正式导演台文件与当前源码 SHA-256 一致。
- 最新安装前 ZIP：`../infinite-canvas-backups/local-installs/小陈的画布-2026-09-06T08-02-36-195Z-71635.zip`，安装器验证压缩包后将旧 App 移入废纸篓。本轮未创建分支或 worktree，仍在 `feat/canvas-runtime-validation`；未提交或推送已有混合改动。
- 免费实测回执保留于上述证据目录；原失败任务保持 failed，没有自动重放。当前新增统一接口已有可审查实现和正式证据，仍不把 R9 标为整体通过。
- 剩余验收：图片、视频、音频各自真实上游提交/查询/原文件，Codex/Grok/Antigravity 的真实工具调用，以及未穷尽的手动拖放、素材类型、复杂时间轴和并发交互。当前渠道费率未由接口返回，本轮未申请额外付费次数、未点击付费批准；后续新增扣费按用户具体授权进行。

## 保存冲突程序入口

在已有 `canvas_task` MCP 或 CLI `tasks submit` 中使用 `save_inspect` 读取本机未保存编辑与数据库最新版本差异，返回 `draftToken`。`save_use_latest` / `save_copy` 的 `arguments` 必须带同一个 `draftToken`，复用界面恢复逻辑；重复请求使用同一 `request_id`。它们可在保存冲突时执行，不先触发失败草稿重试，需要正式 App 运行。副本保留素材引用与任务身份，运行中的旧节点改为需重新发起的状态，不自动重交生成。
