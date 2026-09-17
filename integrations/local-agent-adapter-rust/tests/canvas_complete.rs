use local_agent_adapter::{
    Actor, AgentOperationRequest, CanvasCommandRequest, CanvasOperationAdapter, SqliteCanvasAdapter,
};
use rusqlite::Connection;
use serde_json::{json, Value};

fn fixture() -> (tempfile::TempDir, SqliteCanvasAdapter) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("canvas.db");
    Connection::open(&path).unwrap().execute_batch("CREATE TABLE canvas_projects(user_id TEXT,id TEXT,project_data TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT DEFAULT '',PRIMARY KEY(user_id,id));").unwrap();
    let adapter = SqliteCanvasAdapter::open(path).unwrap();
    adapter
        .project_action("film", &json!({"action":"create","title":"完整操作验收"}))
        .unwrap();
    (dir, adapter)
}
fn node(id: &str, kind: &str) -> Value {
    json!({"id":id,"type":kind,"title":id,"position":{"x":0,"y":0},"width":300,"height":200,"metadata":{"content":"原内容","history":[{"content":"历史原内容"}]}})
}
fn apply(
    adapter: &SqliteCanvasAdapter,
    id: &str,
    operations: Value,
) -> local_agent_adapter::CanvasOperationResult {
    adapter
        .apply_operations(
            AgentOperationRequest {
                project_id: "film".into(),
                request_id: id.into(),
                base_revision: adapter.get_project("film").unwrap().revision,
                actor: Actor::Agent,
                operations: serde_json::from_value(operations).unwrap(),
            },
            false,
        )
        .unwrap()
}
fn command(adapter: &SqliteCanvasAdapter, id: &str, action: &str) -> CanvasCommandRequest {
    CanvasCommandRequest {
        project_id: "film".into(),
        request_id: id.into(),
        base_revision: adapter.get_project("film").unwrap().revision,
        action: action.into(),
        arguments: json!({"prompt":"测试"}),
    }
}

#[test]
fn all_node_types_roundtrip_group_movement_metadata_and_exact_delete_recovery() {
    let (_dir, adapter) = fixture();
    let kinds = [
        "text", "image", "panorama", "video", "audio", "config", "director", "group",
    ];
    apply(
        &adapter,
        "all-types",
        json!(kinds.map(|kind| json!({"type":"create_node","node":node(kind,kind)}))),
    );
    apply(
        &adapter,
        "group",
        json!([{"type":"set_group_members","group_id":"group","node_ids":["text","image"]},{"type":"move_node","node_id":"group","position":{"x":400,"y":500}},{"type":"update_node","node_id":"director","patch":{"metadata":{"directorProject":{"camera":{"zoom":2}},"content":null}}}]),
    );
    let before = adapter.get_project("film").unwrap();
    let nodes = before.project["nodes"].as_array().unwrap();
    assert_eq!(nodes[0]["position"], json!({"x":400.0,"y":500.0}));
    assert_eq!(nodes[1]["metadata"]["content"], "原内容");
    assert_eq!(nodes[6]["metadata"]["directorProject"]["camera"]["zoom"], 2);
    assert!(nodes[6]["metadata"].get("content").is_none());
    apply(
        &adapter,
        "delete",
        json!([{"type":"delete_node","node_id":"group"},{"type":"delete_node","node_id":"image"}]),
    );
    let after = adapter.get_project("film").unwrap();
    assert_eq!(after.project["nodes"].as_array().unwrap().len(), 6);
    assert!(after.project["nodes"][0]["metadata"]
        .get("groupId")
        .is_none());
    let history = adapter.history_list("film").unwrap();
    let sequence = history
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["revision"] == before.revision)
        .unwrap()["sequence"]
        .as_i64()
        .unwrap();
    adapter
        .history_restore("film", sequence, &after.revision, "restore-deleted")
        .unwrap();
    assert_eq!(
        adapter.get_project("film").unwrap().project["nodes"],
        before.project["nodes"]
    );
}

#[test]
fn invalid_and_locked_edits_roll_back_entire_batch_and_keep_unknown_fields() {
    let (_dir, adapter) = fixture();
    let mut image = node("image", "image");
    image["metadata"]["agentLocked"] = json!(true);
    apply(
        &adapter,
        "initial",
        json!([{"type":"create_node","node":node("text","text")},{"type":"create_node","node":image}]),
    );
    let before = adapter.get_project("film").unwrap();
    let request=AgentOperationRequest { project_id:"film".into(),request_id:"atomic".into(),base_revision:before.revision.clone(),actor:Actor::Agent,operations:serde_json::from_value(json!([{"type":"update_node","node_id":"text","patch":{"title":"不应保存"}},{"type":"delete_node","node_id":"image"}])).unwrap() };
    assert!(adapter.apply_operations(request, false).is_err());
    assert_eq!(
        adapter.get_project("film").unwrap().revision,
        before.revision
    );
    for bad in [
        json!({"type":"update_node","node_id":"text","patch":{"id":"other"}}),
        json!({"type":"update_node","node_id":"text","patch":{"position":{"x":1e20,"y":0}}}),
        json!({"type":"set_group_members","group_id":"text","node_ids":[]}),
    ] {
        assert!(adapter
            .apply_operations(
                AgentOperationRequest {
                    project_id: "film".into(),
                    request_id: "invalid".into(),
                    base_revision: before.revision.clone(),
                    actor: Actor::Agent,
                    operations: serde_json::from_value(json!([bad])).unwrap()
                },
                false
            )
            .is_err());
    }
    assert_eq!(
        adapter.get_project("film").unwrap().revision,
        before.revision
    );
}

#[test]
fn commands_require_real_approval_claim_once_and_never_replay_on_restart() {
    let (dir, adapter) = fixture();
    let request = command(&adapter, "image-generation", "generate_image");
    assert_eq!(
        adapter.submit_command(request.clone()).unwrap()["status"],
        "pending_approval"
    );
    assert!(adapter
        .claim_canvas_command("film", "image-generation")
        .is_err());
    adapter
        .approve_canvas_command("film", "image-generation", true, false)
        .unwrap();
    adapter
        .claim_canvas_command("film", "image-generation")
        .unwrap();
    assert!(adapter
        .claim_canvas_command("film", "image-generation")
        .is_err());
    assert_eq!(
        adapter.submit_command(request.clone()).unwrap()["duplicate"],
        true
    );
    let reopened = SqliteCanvasAdapter::open(dir.path().join("canvas.db")).unwrap();
    reopened.recover_canvas_commands().unwrap();
    assert_eq!(
        reopened.command_status("film", "image-generation").unwrap()["status"],
        "interrupted"
    );
    assert!(reopened
        .claim_canvas_command("film", "image-generation")
        .is_err());
    assert_eq!(
        reopened.submit_command(request).unwrap()["status"],
        "interrupted"
    );
}

#[test]
fn revoked_permission_cancelled_approval_and_payload_changes_cannot_execute() {
    let (_dir, adapter) = fixture();
    adapter
        .set_canvas_generation_permission("film", true)
        .unwrap();
    assert_eq!(
        adapter
            .submit_command(command(&adapter, "allowed", "generate_video"))
            .unwrap()["status"],
        "queued"
    );
    adapter.cancel_command("film", "allowed").unwrap();
    assert!(adapter.claim_canvas_command("film", "allowed").is_err());
    adapter
        .set_canvas_generation_permission("film", false)
        .unwrap();
    let original = command(&adapter, "denied", "generate_audio");
    adapter.submit_command(original.clone()).unwrap();
    adapter.cancel_command("film", "denied").unwrap();
    assert!(adapter
        .approve_canvas_command("film", "denied", true, true)
        .is_err());
    assert!(!adapter.canvas_generation_permission("film").unwrap());
    let mut changed = original;
    changed.arguments = json!({"prompt":"变更内容"});
    assert_eq!(
        adapter.submit_command(changed).unwrap_err().code,
        "REQUEST_ID_REUSED"
    );
}

#[test]
fn submitted_is_not_success_and_remote_cancel_does_not_claim_remote_rollback() {
    let (_dir, adapter) = fixture();
    adapter
        .set_canvas_generation_permission("film", true)
        .unwrap();
    adapter
        .submit_command(command(&adapter, "render", "generate_video"))
        .unwrap();
    adapter.claim_canvas_command("film", "render").unwrap();
    adapter
        .finish_canvas_command(
            "film",
            "render",
            json!({"ok":true,"pending":true,"createdNodeIds":["video"]}),
        )
        .unwrap();
    assert_eq!(
        adapter.command_status("film", "render").unwrap()["status"],
        "submitted"
    );
    assert_eq!(
        adapter.cancel_command("film", "render").unwrap()["status"],
        "cancel_requested"
    );
    let mut video = node("video", "video");
    video["metadata"]["canvasCommandId"] = json!("render");
    video["metadata"]["status"] = json!("success");
    apply(
        &adapter,
        "output",
        json!([{"type":"create_node","node":video}]),
    );
    let result = adapter.command_status("film", "render").unwrap();
    assert_eq!(result["status"], "succeeded");
    assert_eq!(result["result"]["cancel_requested"], true);
}

#[test]
fn transfers_keep_bytes_and_scope_and_refuse_tampering() {
    let (_dir, adapter) = fixture();
    let bytes = b"unchanged original media bytes";
    let transfer = adapter.write_transfer("film", bytes).unwrap();
    let id = transfer["artifact_id"].as_str().unwrap();
    assert_eq!(adapter.read_transfer("film", id).unwrap(), bytes);
    assert_eq!(adapter.write_transfer("film", bytes).unwrap(), transfer);
    adapter
        .project_action("other", &json!({"action":"create"}))
        .unwrap();
    assert!(adapter.read_transfer("other", id).is_err());
    assert!(adapter.read_transfer("film", "../secret").is_err());
    std::fs::write(
        adapter
            .database_path()
            .parent()
            .unwrap()
            .join("canvas-transfers/film")
            .join(id),
        b"changed",
    )
    .unwrap();
    assert!(adapter.read_transfer("film", id).is_err());
}

#[test]
fn interrupted_request_cannot_reuse_an_old_successful_source_as_new_media_evidence() {
    let (_dir,adapter)=fixture();
    let mut image=node("source","image");
    image["metadata"]["canvasCommandId"]=json!("unknown-submit");
    image["metadata"]["status"]=json!("success");
    apply(&adapter,"old-image",json!([{"type":"create_node","node":image}]));
    adapter.set_canvas_generation_permission("film",true).unwrap();
    adapter.submit_command(command(&adapter,"unknown-submit","generate_node")).unwrap();
    adapter.claim_canvas_command("film","unknown-submit").unwrap();
    adapter.recover_canvas_commands().unwrap();
    assert_eq!(adapter.command_status("film","unknown-submit").unwrap()["status"],"interrupted");
}

#[test]
fn invalid_view_settings_and_locked_group_membership_do_not_corrupt_the_document() {
    let (_dir,adapter)=fixture();
    let mut group=node("group","group"); group["metadata"]["agentLocked"]=json!(true);
    apply(&adapter,"group",json!([{"type":"create_node","node":group},{"type":"create_node","node":node("member","text")}]));
    let before=adapter.get_project("film").unwrap();
    for operation in [json!({"type":"update_project","patch":{"viewport":{"x":0,"y":0,"k":0}}}),json!({"type":"update_project","patch":{"backgroundMode":{}}}),json!({"type":"update_project","patch":{"sidePanel":{"open":"yes","width":-1}}}),json!({"type":"update_node","node_id":"member","patch":{"metadata":{"groupId":"group"}}})] {
        assert!(adapter.apply_operations(AgentOperationRequest{project_id:"film".into(),request_id:"invalid-setting".into(),base_revision:before.revision.clone(),actor:Actor::Agent,operations:serde_json::from_value(json!([operation])).unwrap()},false).is_err());
        assert_eq!(adapter.get_project("film").unwrap().revision,before.revision);
    }
}

#[test]
fn special_generation_needs_approval_and_claim_preserves_exact_before_media() {
    let (_dir, adapter) = fixture();
    let mut original = adapter.get_project("film").unwrap().project;
    original["nodes"] = json!([node("image", "image")]);
    // Human autosaves can be coalesced; the claim must force a snapshot of this latest revision.
    adapter.save_human_project(original).unwrap();
    let before = adapter.get_project("film").unwrap();
    for action in ["mask_edit_image", "generate_angle", "retry_node"] {
        assert_eq!(adapter.submit_command(command(&adapter,action,action)).unwrap()["status"],"pending_approval");
        assert!(adapter.claim_canvas_command("film",action).is_err());
    }
    adapter.approve_canvas_command("film","retry_node",true,false).unwrap();
    adapter.claim_canvas_command("film","retry_node").unwrap();
    let entries = adapter.history_list("film").unwrap();
    assert!(entries.as_array().unwrap().iter().any(|entry|entry["revision"]==before.revision));
    assert_eq!(adapter.get_project("film").unwrap().revision,before.revision);
}

#[test]
fn task_history_includes_terminal_states_paginates_and_keeps_interrupted_out_of_worker() {
    let (_dir, adapter) = fixture();
    for index in 0..102 {
        let id = format!("history-{index:03}");
        adapter.submit_command(command(&adapter,&id,"read_media")).unwrap();
        adapter.cancel_command("film",&id).unwrap();
    }
    let page = adapter.list_commands("film",0).unwrap();
    assert_eq!(page["tasks"].as_array().unwrap().len(),100);
    assert_eq!(page["next_offset"],100);
    assert!(page["tasks"].as_array().unwrap().iter().all(|task|task["status"]=="cancelled"));
    let rest = adapter.list_commands("film",100).unwrap();
    assert_eq!(rest["tasks"].as_array().unwrap().len(),2);
    assert_eq!(rest["next_offset"],Value::Null);
    adapter.submit_command(command(&adapter,"interrupted","read_media")).unwrap();
    adapter.claim_canvas_command("film","interrupted").unwrap();
    adapter.recover_canvas_commands().unwrap();
    assert_eq!(adapter.canvas_commands(None).unwrap(),json!([]));
    assert_eq!(adapter.command_status("film","interrupted").unwrap()["status"],"interrupted");
}
