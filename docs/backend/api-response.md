---
title: 接口响应约定
description: 业务接口统一响应结构与前端处理约定
---

# 接口响应约定

后端业务接口统一返回 JSON：

```json
{
  "code": 0,
  "data": {},
  "msg": "ok"
}
```

- `code`: 业务状态码，`0` 表示成功，非 `0` 表示失败。
- `data`: 业务数据。失败时通常为 `null`。
- `msg`: 响应消息。成功默认为 `ok`，失败时放错误原因。

前端请求逻辑以 `code` 判断业务是否成功。当前后端业务失败也会返回 HTTP 200，前端不要只依赖 HTTP 状态码判断结果。

接口连接失败、服务不可达、返回体不是约定 JSON 时，前端按网络或接口异常处理。


## 画布轻量查询

- `POST /v1/projects/{project_id}/actions`，`{"action":"status"}`：返回内容哈希 `revision`、`operationRevision`、更新时间、节点摘要（id/type/title/status/storageKey）及连线数；不返回正文、内嵌图片和撤销快照。CLI：`projects status <project_id>`。MCP：`canvas_read` 传 `summary: true`。
- 同一路径 `{"action":"node","node_id":"..."}` 返回单节点与读取时的修订号。CLI：`projects node <project_id> <node_id>`。
- 任务轮询继续使用 `GET /v1/projects/{project_id}/commands/{request_id}` / `tasks get`；重复生成提交继续沿用相同 request_id 的幂等回执，不需要导出画布查询状态。
- 原有完整 `projects get` 和默认 `canvas_read` 保持兼容。摘要与单节点查询只读，素材读取沿用原有项目登记及哈希校验。
