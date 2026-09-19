//! Durable dispatch to the App's existing canvas executor. Claims are never replayed automatically.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    canvas::{now_rfc3339, validate_identifier},
    BridgeError, CanvasOperationAdapter, SqliteCanvasAdapter,
};

pub const ACTIONS: &[&str] = &[
    "save_inspect", "save_use_latest", "save_copy",
    "director_read",
    "director_capture",
    "director_export_video",
    "open_project",
    "get_generation_config",
    "get_selected_nodes",
    "get_node",
    "get_canvas_summary",
    "generate_image",
    "edit_image",
    "generate_video",
    "generate_audio",
    "generate_node",
    "mask_edit_image",
    "generate_angle",
    "retry_node",
    "upscale_image",
    "replace_media",
    "arrange_nodes",
    "create_group",
    "undo",
    "redo",
    "import_media",
    "read_media",
    "export_project",
    "import_project",
    "collect_asset",
    "crop_image",
    "split_image",
    "capture_video_frame",
];
pub fn is_paid(action: &str) -> bool {
    matches!(
        action,
        "generate_image" | "edit_image" | "generate_video" | "generate_audio" | "generate_node" | "mask_edit_image" | "generate_angle" | "retry_node"
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanvasCommandRequest {
    pub project_id: String,
    pub request_id: String,
    pub base_revision: String,
    pub action: String,
    #[serde(default = "empty_arguments")]
    pub arguments: Value,
}
fn empty_arguments() -> Value {
    json!({})
}

pub fn initialize(db: &Connection) -> Result<(), BridgeError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS canvas_commands (
        request_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        request_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_canvas_commands_project ON canvas_commands(project_id,status,created_at);
        CREATE TABLE IF NOT EXISTS canvas_command_permissions (
        project_id TEXT PRIMARY KEY, allow_generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);")?;
    Ok(())
}

pub fn submit(
    adapter: &SqliteCanvasAdapter,
    request: CanvasCommandRequest,
) -> Result<Value, BridgeError> {
    validate_identifier("request_id", &request.request_id, 128)?;
    validate_identifier("project_id", &request.project_id, 64)?;
    if !ACTIONS.contains(&request.action.as_str()) || !request.arguments.is_object() {
        return Err(BridgeError::invalid("不支持的画布任务或参数。"));
    }
    if matches!(request.action.as_str(), "save_use_latest" | "save_copy") && request.arguments["draftToken"].as_str().is_none_or(|value| value.is_empty()) {
        return Err(BridgeError::invalid("请先用 save_inspect 读取差异，再提供 draftToken。"));
    }
    // Credentials live in the App's existing configuration, never in the task journal.
    fn has_secret(value: &Value) -> bool {
        match value {
            Value::Object(object) => object.iter().any(|(key, value)| {
                matches!(
                    key.to_ascii_lowercase().as_str(),
                    "apikey" | "api_key" | "authorization" | "access_token" | "password"
                ) || has_secret(value)
            }),
            Value::Array(values) => values.iter().any(has_secret),
            _ => false,
        }
    }
    if has_secret(&request.arguments) {
        return Err(BridgeError::invalid(
            "请使用 App 已配置的渠道，不要在任务中传入凭据。",
        ));
    }
    let raw =
        serde_json::to_string(&request).map_err(|_| BridgeError::invalid("无法编码任务。"))?;
    let hash = format!("{:x}", Sha256::digest(raw.as_bytes()));
    let mut db = adapter.connect()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(previous) = tx
        .query_row(
            "SELECT payload_hash FROM canvas_commands WHERE request_id=?1",
            [&request.request_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        if previous != hash {
            return Err(BridgeError::conflict(
                "REQUEST_ID_REUSED",
                "请求编号已用于其他任务。",
            ));
        }
        let mut result = read(&tx, &request.project_id, &request.request_id)?;
        result["duplicate"] = json!(true);
        return Ok(result);
    }
    let project = adapter.get_project(&request.project_id)?;
    if project.revision != request.base_revision {
        return Err(BridgeError::conflict(
            "REVISION_CONFLICT",
            "画布已有修改，请读取最新内容后提交任务。",
        )
        .with_details(json!({"current_revision":project.revision})));
    }
    // The authenticated caller already requested generation. The canvas adds no
    // second approval step; historical pending requests are deliberately untouched.
    let state = "queued";
    let now = now_rfc3339()?;
    tx.execute("INSERT INTO canvas_commands(request_id,project_id,payload_hash,request_json,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",params![request.request_id,request.project_id,hash,raw,state,now])?;
    let result = read(&tx, &request.project_id, &request.request_id)?;
    tx.commit()?;
    Ok(result)
}

fn read(db: &Connection, project: &str, id: &str) -> Result<Value, BridgeError> {
    db.query_row("SELECT request_json,status,result_json,created_at,updated_at FROM canvas_commands WHERE project_id=?1 AND request_id=?2",params![project,id],|row| {
        let request:String=row.get(0)?; let result:Option<String>=row.get(2)?;
        Ok(json!({"request":serde_json::from_str::<Value>(&request).unwrap_or(Value::Null),"task_id":id,"project_id":project,"status":row.get::<_,String>(1)?,"result":result.and_then(|v|serde_json::from_str::<Value>(&v).ok()),"created_at":row.get::<_,String>(3)?,"updated_at":row.get::<_,String>(4)?,"duplicate":false}))
    }).optional()?.ok_or_else(||BridgeError::not_found("画布任务不存在。"))
}

pub fn status(
    adapter: &SqliteCanvasAdapter,
    project: &str,
    id: &str,
) -> Result<Value, BridgeError> {
    let task = read(&adapter.connect()?, project, id)?;
    if !matches!(
        task["status"].as_str(),
        Some("submitted" | "cancel_requested")
    ) {
        return Ok(task);
    }
    let document = adapter.get_project(project)?;
    let ids = task["result"]["createdNodeIds"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if task["result"]["pending"] != true {
        return Ok(task);
    }
    let nodes: Vec<&Value> = document.project["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|node| {
            ids.iter().any(|id| *id == node["id"]) || node["metadata"]["canvasCommandId"] == id
        })
        .collect();
    if nodes.is_empty()
        || ids
            .iter()
            .any(|id| !nodes.iter().any(|node| node["id"] == *id))
    {
        return Ok(task);
    }
    let failed = nodes
        .iter()
        .find(|node| node["metadata"]["status"] == "error");
    if failed.is_none()
        && nodes
            .iter()
            .any(|node| node["metadata"]["status"] != "success")
    {
        return Ok(task);
    }
    let mut result = task["result"].as_object().cloned().unwrap_or_default();
    result.insert("ok".into(), json!(failed.is_none()));
    result.insert("pending".into(), json!(false));
    result.insert(
        "cancel_requested".into(),
        json!(task["status"] == "cancel_requested"),
    );
    result.insert(
        "createdNodeIds".into(),
        json!(nodes.iter().map(|node| &node["id"]).collect::<Vec<_>>()),
    );
    result.insert("nodes".into(),json!(nodes.iter().map(|node|json!({"id":node["id"],"type":node["type"],"status":node["metadata"]["status"],"storageKey":node["metadata"]["storageKey"],"taskId":node["metadata"].get("videoTaskId").or_else(||node["metadata"].get("imageTaskId")).or_else(||node["metadata"].get("audioTaskId"))})).collect::<Vec<_>>()));
    if let Some(node) = failed {
        result.insert("message".into(), node["metadata"]["errorDetails"].clone());
    }
    adapter.finish_canvas_command(project, id, json!(result))
}
pub fn cancel(
    adapter: &SqliteCanvasAdapter,
    project: &str,
    id: &str,
) -> Result<Value, BridgeError> {
    let db = adapter.connect()?;
    db.execute("UPDATE canvas_commands SET status=CASE WHEN status IN ('queued','pending_approval') THEN 'cancelled' ELSE 'cancel_requested' END,updated_at=?1 WHERE project_id=?2 AND request_id=?3 AND status IN ('queued','pending_approval','running','submitted')",params![now_rfc3339()?,project,id])?;
    read(&db, project, id)
}

impl SqliteCanvasAdapter {
    pub fn canvas_commands(&self, project: Option<&str>) -> Result<Value, BridgeError> {
        let db = self.connect()?;
        let mut stmt=db.prepare("SELECT project_id,request_id FROM canvas_commands WHERE (?1 IS NULL OR project_id=?1) AND status IN ('queued','pending_approval','running','submitted','cancel_requested') ORDER BY CASE WHEN status IN ('queued','pending_approval') THEN 0 ELSE 1 END,created_at LIMIT 100")?;
        let rows = stmt
            .query_map([project], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        drop(db);
        rows.into_iter()
            .map(|(p, id)| status(self, &p, &id))
            .collect::<Result<Vec<_>, _>>()
            .map(|rows| json!(rows))
    }
    pub fn command_history(&self, project: &str, offset: u32) -> Result<Value, BridgeError> {
        self.get_project(project)?;
        let db = self.connect()?;
        let mut stmt = db.prepare("SELECT request_id FROM canvas_commands WHERE project_id=?1 ORDER BY created_at DESC,request_id DESC LIMIT 101 OFFSET ?2")?;
        let mut ids = stmt.query_map(params![project,offset], |row| row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        let has_more = ids.len() > 100;
        ids.truncate(100);
        drop(stmt); drop(db);
        let tasks = ids.into_iter().map(|id| status(self,project,&id)).collect::<Result<Vec<_>,_>>()?;
        Ok(json!({"tasks":tasks,"next_offset":if has_more {Some(offset+100)} else {None}}))
    }
    pub fn claim_canvas_command(&self, project: &str, id: &str) -> Result<Value, BridgeError> {
        let mut db = self.connect()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.execute("UPDATE canvas_commands SET status='running',updated_at=?1 WHERE project_id=?2 AND request_id=?3 AND status='queued'",params![now_rfc3339()?,project,id])?!=1 {
            return Err(BridgeError::conflict("COMMAND_ALREADY_CLAIMED","任务已被领取、取消或仍待授权。"));
        }
        let raw:String=tx.query_row("SELECT project_data FROM canvas_projects WHERE user_id=?1 AND id=?2 AND deleted_at=''",params![crate::canvas::DESKTOP_LOCAL_USER_ID,project],|row|row.get(0)).optional()?.ok_or_else(||BridgeError::not_found("目标画布已不存在。"))?;
        // In particular, an explicit retry must retain the exact pre-retry media reference.
        crate::history::record(&tx,crate::canvas::DESKTOP_LOCAL_USER_ID,project,&raw,"command_before",None)?;
        let result=read(&tx, project, id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn finish_canvas_command(
        &self,
        project: &str,
        id: &str,
        result: Value,
    ) -> Result<Value, BridgeError> {
        if !result["ok"].is_boolean() {
            return Err(BridgeError::invalid("任务回执必须明确包含 ok。"));
        }
        let state = if result["ok"] == false {
            "failed"
        } else if result["pending"] == true {
            "submitted"
        } else {
            "succeeded"
        };
        let db = self.connect()?;
        let raw =
            serde_json::to_string(&result).map_err(|_| BridgeError::invalid("任务结果无效。"))?;
        db.execute("UPDATE canvas_commands SET status=CASE WHEN status='cancel_requested' AND ?1='submitted' THEN 'cancel_requested' ELSE ?1 END,result_json=?2,updated_at=?3 WHERE project_id=?4 AND request_id=?5 AND status IN ('running','submitted','cancel_requested','interrupted')",params![state,raw,now_rfc3339()?,project,id])?;
        read(&db, project, id)
    }
    pub fn approve_canvas_command(
        &self,
        project: &str,
        id: &str,
        allow: bool,
        remember: bool,
    ) -> Result<Value, BridgeError> {
        let mut db = self.connect()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let command = read(&tx, project, id)?;
        if command["status"] != "pending_approval" {
            return Err(BridgeError::conflict(
                "APPROVAL_EXPIRED",
                "任务已处理，此次授权已失效。",
            ));
        }
        if remember && allow {
            tx.execute("INSERT INTO canvas_command_permissions(project_id,allow_generation,updated_at) VALUES(?1,1,?2) ON CONFLICT(project_id) DO UPDATE SET allow_generation=1,updated_at=excluded.updated_at",params![project,now_rfc3339()?])?;
        }
        tx.execute("UPDATE canvas_commands SET status=?1,updated_at=?2 WHERE project_id=?3 AND request_id=?4 AND status='pending_approval'",params![if allow {"queued"} else {"cancelled"},now_rfc3339()?,project,id])?;
        let result = read(&tx, project, id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn set_canvas_generation_permission(
        &self,
        project: &str,
        allow: bool,
    ) -> Result<(), BridgeError> {
        self.get_project(project)?;
        self.connect()?.execute("INSERT INTO canvas_command_permissions(project_id,allow_generation,updated_at) VALUES(?1,?2,?3) ON CONFLICT(project_id) DO UPDATE SET allow_generation=excluded.allow_generation,updated_at=excluded.updated_at",params![project,allow,now_rfc3339()?])?;
        Ok(())
    }
    pub fn canvas_generation_permission(&self, project: &str) -> Result<bool, BridgeError> {
        self.get_project(project)?;
        Ok(self
            .connect()?
            .query_row(
                "SELECT allow_generation FROM canvas_command_permissions WHERE project_id=?1",
                [project],
                |row| row.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false))
    }
    pub fn recover_canvas_commands(&self) -> Result<(), BridgeError> {
        self.connect()?.execute(
            "UPDATE canvas_commands SET status='interrupted',updated_at=?1 WHERE status='running'",
            [now_rfc3339()?],
        )?;
        Ok(())
    }
}
