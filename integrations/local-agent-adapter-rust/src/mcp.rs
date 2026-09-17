use std::{
    io::{self, BufRead, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::{
    find_project_binding, read_credential_token, Actor, AgentOperationRequest, BridgeClient,
    BridgeError, CanvasOperation,
};

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub fn serve_mcp_stdio(
    endpoint: &str,
    credential_file: &Path,
    project_directory: Option<&Path>,
) -> Result<(), BridgeError> {
    let token = read_credential_token(credential_file)?;
    let client = BridgeClient::new(endpoint, token)?;
    let (directory, binding) = find_project_binding(project_directory)?;
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line.map_err(|_| BridgeError::invalid("The MCP request could not be read."))?;
        if line.len() > MAX_MESSAGE_BYTES {
            write_response(
                &mut stdout,
                &jsonrpc_error(
                    Value::Null,
                    -32600,
                    "The MCP request exceeds the 1 MiB limit.",
                ),
            )?;
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                write_response(
                    &mut stdout,
                    &jsonrpc_error(Value::Null, -32700, "The MCP request is not valid JSON."),
                )?;
                continue;
            }
        };
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        let response = handle_request(&client, &directory, &binding.project_id, id, &request);
        write_response(&mut stdout, &response)?;
    }
    Ok(())
}

fn handle_request(
    client: &BridgeClient,
    project_directory: &Path,
    project_id: &str,
    id: Value,
    request: &Value,
) -> Value {
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return jsonrpc_error(id, -32600, "The MCP request method is missing.");
    };
    match method {
        "initialize" => jsonrpc_result(
            id,
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "infinite-canvas", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "This server is bound to one film directory and one Infinite Canvas project. Read canvas_context first. Use canvas_mutate in dry_run mode before apply."
            }),
        ),
        "ping" => jsonrpc_result(id, json!({})),
        "tools/list" => jsonrpc_result(id, json!({ "tools": tool_catalog() })),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return jsonrpc_error(id, -32602, "The MCP tool name is missing.");
            };
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(client, project_directory, project_id, name, arguments) {
                Ok(value) => jsonrpc_result(id, tool_result(value, false)),
                Err(error) => jsonrpc_result(id, tool_result(json!(error.envelope()), true)),
            }
        }
        _ => jsonrpc_error(id, -32601, "The MCP method is not supported."),
    }
}

fn tool_catalog() -> Vec<Value> {
    vec![
        json!({
            "name": "canvas_context",
            "title": "Read film and canvas context",
            "description": "Read the film directory binding, canvas revision, counts, workflow folders, and optionally a compact summary of selected nodes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "node_ids": { "type": "array", "items": { "type": "string" }, "maxItems": 100 }
                },
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true, "destructiveHint": false }
        }),
        json!({
            "name": "canvas_read",
            "title": "Read canvas nodes",
            "description": "Read all nodes or a requested set of node ids from the canvas bound to the current film directory.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "node_ids": { "type": "array", "items": { "type": "string" }, "maxItems": 100 },
                    "include_connections": { "type": "boolean", "default": true }
                },
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true, "destructiveHint": false }
        }),
        json!({
            "name": "canvas_mutate",
            "title": "Change canvas safely",
            "description": "Preview or apply edits to every canvas node type, metadata, groups, connections and project settings. Apply requires the revision you read and a stable request_id; reuse the exact request on transport failure.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "mode": { "type": "string", "enum": ["dry_run", "apply"], "default": "dry_run" },
                    "request_id": { "type": "string" },
                    "base_revision": { "type": "string", "description": "SHA-256 revision returned by canvas_read/context or dry_run; required for apply." },
                    "operations": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 100,
                        "items": {
                            "type": "object",
                            "description": "create_node {node:{id,type,title,position:{x,y},width,height,metadata}}; update_node {node_id,patch:{title?,position?,width?,height?,metadata?}} (null clears individual metadata fields); delete_node {node_id}; set_group_members {group_id,node_ids}; update_project {patch}; create_text_node; move_node; set_node_text; set_project_title; add_connection; remove_connection. Node types: text,image,panorama,video,audio,config,director,group. Every operation requires its type field."
                        }
                    }
                },
                "required": ["operations"],
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": true }
        }),
        json!({
            "name": "canvas_task",
            "title": "Execute canvas creation tasks",
            "description": "Submit App actions including generation using configured providers. Open the project with open_project first; the App executes queued work without manual clicks. Paid work uses the user's project authorization or waits for approval. A queued/submitted receipt is not completed media. Query the same task id after interruption; never resubmit paid work with a new id automatically.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["runtime", "list", "submit", "status", "cancel", "local_status", "local_cancel"] },
                    "task_id": { "type": "string" },
                    "request_id": { "type": "string" },
                    "base_revision": { "type": "string" },
                    "offset": {"type":"integer","minimum":0},
                    "command": { "type": "string", "enum": crate::commands::ACTIONS },
                    "arguments": { "type": "object", "description": "Arguments for the selected App action; use get_generation_config to inspect model/channel settings. Generation accepts prompt,title,sourceNodeIds,size,count,seconds,generateAudio,voice,instructions. generate_node: nodeId,mode(text/image/video/audio),prompt; uses that node's full settings. retry_node: nodeId (explicit new attempt). mask_edit_image: nodeId,prompt,artifact_id (marked PNG),model?,channelId?. generate_angle: nodeId,params{horizontalAngle:-60..60,pitchAngle:-60..60,cameraDistance:1..20,wideAngle:boolean}. upscale_image: nodeId,params{targetLongEdge:32..4096,algorithm:high/bilinear/nearest}. replace_media: nodeId,artifact_id,type?,mimeType?,title?. read_media/collect_asset: nodeId. import_media: artifact_id,type(image/panorama/video/audio),mimeType,title,nodeId(optional reference). export_project: {}. import_project: artifact_id. crop_image: nodeId,crop{x,y,width,height} all 0-1. split_image: nodeId,horizontalLines,verticalLines arrays of 0-1. capture_video_frame: nodeId,position(first/last/current),seconds. director_read/director_capture/director_export_video: nodeId,cameraId(optional),seconds(optional timeline position); capture preset: current/four/twelve. Returns actual rendered images or MP4 using existing director, no paid model. arrange_nodes/create_group: nodeIds,title(optional). open_project/undo/redo: {}." }
                },
                "required": ["action"],
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false }
        }),
        json!({
            "name":"canvas_project", "title":"Project and version history", "description":"Create an explicitly named project or inspect/restore this bound project's version history. Creates never overwrite an existing project. Restore requires base_revision and request_id; opening and ZIP transfer use canvas_task.",
            "inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["create","history","preview","restore"]},"project_id":{"type":"string","description":"Required for create; other actions are scoped to this bound project."},"title":{"type":"string"},"project":{"type":"object"},"sequence":{"type":"integer"},"base_revision":{"type":"string"},"request_id":{"type":"string"}},"required":["action"],"additionalProperties":false},
            "annotations":{"readOnlyHint":false,"destructiveHint":true}
        }),
        json!({
            "name":"canvas_media","title":"Transfer project media","description":"Upload a file from this bound film directory or download a read_media/export_project artifact to a NEW file inside that directory. Does not invoke a model. Upload returns artifact_id for canvas_task import_media/import_project.",
            "inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["upload","download"]},"path":{"type":"string","description":"Relative path inside the bound film directory."},"artifact_id":{"type":"string"}},"required":["action","path"],"additionalProperties":false},
            "annotations":{"readOnlyHint":false,"destructiveHint":false}
        }),
    ]
}

fn call_tool(
    client: &BridgeClient,
    project_directory: &Path,
    project_id: &str,
    name: &str,
    arguments: Value,
) -> Result<Value, BridgeError> {
    if !arguments.is_object() {
        return Err(BridgeError::invalid(
            "MCP tool arguments must be a JSON object.",
        ));
    }
    match name {
        "canvas_context" => canvas_context(client, project_directory, project_id, &arguments),
        "canvas_read" => canvas_read(client, project_id, &arguments),
        "canvas_mutate" => canvas_mutate(client, project_id, &arguments),
        "canvas_task" => canvas_task(client, project_id, &arguments),
        "canvas_project" => {
            let id=if arguments["action"]=="create" {arguments["project_id"].as_str().ok_or_else(||BridgeError::invalid("创建项目需要明确 project_id。"))?} else {project_id};
            validate_identifier(id)?;
            client.post(&format!("/v1/projects/{id}/actions"),&arguments)
        }
        "canvas_media" => {
            use std::io::{Read,Write};
            let relative=arguments["path"].as_str().ok_or_else(||BridgeError::invalid("缺少相对路径。"))?;
            let relative=Path::new(relative);
            if relative.is_absolute() || relative.components().any(|part|!matches!(part,std::path::Component::Normal(_))) {return Err(BridgeError::forbidden("素材路径必须位于绑定片子目录内。"));}
            let root=project_directory.canonicalize().map_err(|_|BridgeError::invalid("绑定目录不可用。"))?;
            let path=root.join(relative);
            match arguments["action"].as_str() {
                Some("upload")=>{
                    let path=path.canonicalize().map_err(|_|BridgeError::not_found("素材文件不存在。"))?;
                    if !path.starts_with(&root) {return Err(BridgeError::forbidden("素材路径越界。"));}
                    let mut bytes=Vec::new();
                    std::fs::File::open(path).and_then(|file|file.take(crate::transfers::MAX_BYTES as u64+1).read_to_end(&mut bytes)).map_err(|_|BridgeError::invalid("无法读取素材文件。"))?;
                    if bytes.len()>crate::transfers::MAX_BYTES {return Err(BridgeError::invalid("素材超过 512 MiB。"));}
                    client.upload(&format!("/v1/projects/{project_id}/transfers"),&bytes)
                }
                Some("download")=>{
                    let parent=path.parent().ok_or_else(||BridgeError::invalid("输出路径无效。"))?.canonicalize().map_err(|_|BridgeError::invalid("输出目录不存在。"))?;
                    if !parent.starts_with(&root) {return Err(BridgeError::forbidden("输出路径越界。"));}
                    let id=arguments["artifact_id"].as_str().ok_or_else(||BridgeError::invalid("缺少 artifact_id。"))?; validate_identifier(id)?;
                    let bytes=client.download(&format!("/v1/projects/{project_id}/transfers/{id}"))?;
                    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|_|BridgeError::invalid("输出文件已存在或无法创建。"))?;
                    file.write_all(&bytes).map_err(|_|BridgeError::internal("素材写入失败。"))?;
                    Ok(json!({"ok":true,"artifact_id":id,"bytes":bytes.len(),"path":relative}))
                }
                _=>Err(BridgeError::invalid("action 必须为 upload 或 download。"))
            }
        }
        _ => Err(BridgeError::not_found(
            "The requested canvas MCP tool does not exist.",
        )),
    }
}

fn canvas_context(
    client: &BridgeClient,
    project_directory: &Path,
    project_id: &str,
    arguments: &Value,
) -> Result<Value, BridgeError> {
    let data = project_data(client, project_id)?;
    let project = data.get("project").cloned().unwrap_or_else(|| json!({}));
    let nodes = project
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let selected_ids = string_array(arguments.get("node_ids"))?;
    let selected_nodes = if selected_ids.is_empty() {
        Vec::new()
    } else {
        nodes
            .iter()
            .filter(|node| {
                node.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| selected_ids.iter().any(|selected| selected == id))
            })
            .map(compact_node)
            .collect::<Vec<_>>()
    };
    let folders = workflow_folders(project_directory);
    Ok(json!({
        "binding": {
            "project_id": project_id,
            "project_title": project.get("title").and_then(Value::as_str).unwrap_or("Untitled canvas"),
            "project_directory": project_directory,
        },
        "canvas": {
            "revision": data.get("revision"),
            "node_count": nodes.len(),
            "connection_count": project.get("connections").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            "selected_nodes": selected_nodes,
        },
        "workflow_folders": folders,
        "next_step": "Use canvas_read for detail. Use canvas_mutate with mode=dry_run before apply."
    }))
}

fn canvas_read(
    client: &BridgeClient,
    project_id: &str,
    arguments: &Value,
) -> Result<Value, BridgeError> {
    let data = project_data(client, project_id)?;
    let project = data.get("project").cloned().unwrap_or_else(|| json!({}));
    let all_nodes = project
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ids = string_array(arguments.get("node_ids"))?;
    let nodes = if ids.is_empty() {
        all_nodes
    } else {
        all_nodes
            .into_iter()
            .filter(|node| {
                node.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| ids.iter().any(|selected| selected == id))
            })
            .collect()
    };
    let include_connections = arguments
        .get("include_connections")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let connections = if include_connections {
        let all_connections = project
            .get("connections")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if ids.is_empty() {
            json!(all_connections)
        } else {
            json!(all_connections
                .into_iter()
                .filter(|connection| {
                    let from = connection.get("fromNodeId").and_then(Value::as_str);
                    let to = connection.get("toNodeId").and_then(Value::as_str);
                    from.is_some_and(|id| ids.iter().any(|selected| selected == id))
                        && to.is_some_and(|id| ids.iter().any(|selected| selected == id))
                })
                .collect::<Vec<_>>())
        }
    } else {
        json!([])
    };
    Ok(json!({
        "project_id": project_id,
        "title": project.get("title"),
        "revision": data.get("revision"),
        "nodes": nodes,
        "connections": connections
    }))
}

fn canvas_mutate(
    client: &BridgeClient,
    project_id: &str,
    arguments: &Value,
) -> Result<Value, BridgeError> {
    let operations: Vec<CanvasOperation> = serde_json::from_value(
        arguments
            .get("operations")
            .cloned()
            .ok_or_else(|| BridgeError::invalid("canvas_mutate requires operations."))?,
    )
    .map_err(|_| {
        BridgeError::invalid("One or more canvas operations do not match the allowlisted schema.")
    })?;
    let mode = arguments
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("dry_run");
    if !matches!(mode, "dry_run" | "apply") {
        return Err(BridgeError::invalid(
            "canvas_mutate mode must be dry_run or apply.",
        ));
    }
    if mode=="apply" && (arguments["base_revision"].as_str().is_none() || arguments["request_id"].as_str().is_none()) {
        return Err(BridgeError::invalid("apply 必须携带读取时的 base_revision 和固定 request_id，防止覆盖新编辑或重复操作。"));
    }
    let base_revision = if let Some(revision)=arguments["base_revision"].as_str() {revision.to_owned()} else {
        project_data(client,project_id)?["revision"].as_str().ok_or_else(||BridgeError::internal("缺少画布修订。"))?.to_owned()
    };
    let request_id = arguments
        .get("request_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(next_request_id);
    let request = AgentOperationRequest {
        project_id: project_id.to_owned(),
        request_id,
        base_revision: base_revision.to_owned(),
        actor: Actor::Agent,
        operations,
    };
    let mut response = client.post(
        if mode == "apply" {
            "/v1/canvas/operations/apply"
        } else {
            "/v1/canvas/operations/dry-run"
        },
        &request,
    )?;
    if let Some(data) = response.get_mut("data").and_then(Value::as_object_mut) {
        if let Some(project) = data.remove("project") {
            data.insert(
                "project_summary".to_owned(),
                json!({
                    "id": project.get("id"),
                    "title": project.get("title"),
                    "node_count": project.get("nodes").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                    "connection_count": project.get("connections").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                }),
            );
        }
    }
    Ok(response)
}

fn canvas_task(client: &BridgeClient, project_id:&str, arguments: &Value) -> Result<Value, BridgeError> {
    let action = arguments
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::invalid("canvas_task requires an action."))?;
    match action {
        "runtime" => client.get("/v1/runtime"),
        "list" => { let offset=arguments.get("offset").map(|v|v.as_u64().filter(|n| *n <= u32::MAX as u64).ok_or_else(||BridgeError::invalid("offset 必须是非负整数。"))).transpose()?.unwrap_or(0); client.get(&format!("/v1/projects/{project_id}/commands?offset={offset}")) },
        "submit" => {
            let request=crate::CanvasCommandRequest {
                project_id:project_id.to_owned(),
                request_id:arguments["request_id"].as_str().ok_or_else(||BridgeError::invalid("submit 需要固定 request_id。"))?.to_owned(),
                base_revision:arguments["base_revision"].as_str().ok_or_else(||BridgeError::invalid("submit 需要读取时的 base_revision。"))?.to_owned(),
                action:arguments["command"].as_str().ok_or_else(||BridgeError::invalid("缺少 command。"))?.to_owned(),
                arguments:arguments.get("arguments").cloned().unwrap_or_else(||json!({})),
            };
            client.post("/v1/canvas/commands",&request)
        }
        "status" | "cancel" => {
            let task_id=arguments["task_id"].as_str().ok_or_else(||BridgeError::invalid("缺少 task_id。"))?;
            validate_identifier(task_id)?;
            let path=format!("/v1/projects/{project_id}/commands/{task_id}");
            if action=="status" {client.get(&path)} else {client.post(&format!("{path}/cancel"),&json!({}))}
        }
        "local_status" | "local_cancel" => {
            let task_id = arguments
                .get("task_id")
                .and_then(Value::as_str)
                .ok_or_else(|| BridgeError::invalid("This canvas_task action requires task_id."))?;
            validate_identifier(task_id)?;
            if action == "local_status" {
                client.get(&format!("/v1/tasks/{task_id}"))
            } else {
                client.post(&format!("/v1/tasks/{task_id}/cancel"), &json!({}))
            }
        }
        _ => Err(BridgeError::invalid(
            "canvas_task action must be runtime, status, or cancel.",
        )),
    }
}

fn project_data(client: &BridgeClient, project_id: &str) -> Result<Value, BridgeError> {
    let response = client.get(&format!("/v1/projects/{project_id}"))?;
    response
        .get("data")
        .cloned()
        .ok_or_else(|| BridgeError::internal("The Agent Bridge returned no project data."))
}

fn string_array(value: Option<&Value>) -> Result<Vec<String>, BridgeError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let array = value
        .as_array()
        .ok_or_else(|| BridgeError::invalid("node_ids must be an array."))?;
    if array.len() > 100 {
        return Err(BridgeError::invalid(
            "node_ids may contain at most 100 values.",
        ));
    }
    array
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| BridgeError::invalid("Every node id must be a string."))
        })
        .collect()
}

fn compact_node(node: &Value) -> Value {
    let metadata = node.get("metadata").cloned().unwrap_or_else(|| json!({}));
    json!({
        "id": node.get("id"),
        "type": node.get("type"),
        "title": node.get("title"),
        "content": metadata.get("content").or_else(|| metadata.get("prompt")),
        "local_media": metadata.get("localMedia"),
    })
}

fn workflow_folders(project_directory: &Path) -> Vec<String> {
    let mut values = std::fs::read_dir(project_directory)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .collect::<Vec<_>>();
    values.sort();
    values.truncate(40);
    values
}

fn validate_identifier(value: &str) -> Result<(), BridgeError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(BridgeError::invalid("The task id is invalid."));
    }
    Ok(())
}

fn next_request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("mcp-{nanos:x}-{sequence:x}")
}

fn tool_result(value: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&value)
        .unwrap_or_else(|_| "{\"error\":\"JSON encoding failed\"}".to_owned());
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": value,
        "isError": is_error
    })
}

fn jsonrpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn write_response(output: &mut impl Write, value: &Value) -> Result<(), BridgeError> {
    serde_json::to_writer(&mut *output, value)
        .map_err(|_| BridgeError::internal("The MCP response could not be encoded."))?;
    output
        .write_all(b"\n")
        .map_err(|_| BridgeError::internal("The MCP response could not be written."))?;
    output
        .flush()
        .map_err(|_| BridgeError::internal("The MCP response could not be flushed."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_are_deterministic_and_include_the_four_canvas_capabilities() {
        let names = tool_catalog()
            .into_iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "canvas_context",
                "canvas_read",
                "canvas_mutate",
                "canvas_task",
                "canvas_project"
                ,"canvas_media"
            ]
        );
    }

    #[test]
    fn generated_request_ids_are_valid_route_identifiers() {
        let first = next_request_id();
        let second = next_request_id();
        assert_ne!(first, second);
        validate_identifier(&first).unwrap();
    }
}
