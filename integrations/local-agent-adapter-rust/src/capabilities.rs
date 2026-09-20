use serde_json::{json, Value};

pub fn catalog() -> Value {
    json!({
        "schema_version": "1.1",
        "transport": {
            "kind": "http_loopback",
            "listen_host": "127.0.0.1",
            "authentication": "desktop_install_credential",
            "public_network": false
        },
        "operation_protocol": {
            "actor": "agent",
            "required_fields": ["project_id", "request_id", "base_revision", "actor", "operations"],
            "idempotency": "request_id_and_payload",
            "concurrency": "sha256_base_revision_compare_and_swap",
            "canonical_adapter": "CanvasOperationAdapter",
            "backend": "rust_shared_sqlite_canvas_projects"
        },
        "capabilities": [
            {
                "id": "capabilities.read",
                "method": "GET",
                "path": "/v1/capabilities",
                "risk": "read_only",
                "dry_run": false,
                "paid": false,
                "source": "agent_bridge"
            },
            {
                "id": "projects.list",
                "method": "GET",
                "path": "/v1/projects",
                "risk": "read_only",
                "dry_run": false,
                "paid": false,
                "source": "rust_canvas_projects_same_database"
            },
            {
                "id": "projects.get",
                "method": "GET",
                "path": "/v1/projects/{project_id}",
                "risk": "read_only",
                "dry_run": false,
                "paid": false,
                "source": "rust_canvas_projects_same_database"
            },
            {
                "id": "projects.create",
                "method": "POST",
                "path": "/v1/projects",
                "risk": "reversible_write",
                "dry_run": false,
                "paid": false,
                "source": "CanonicalCanvasAdapter",
                "idempotency": "request_id_and_payload"
            },
            {
                "id": "canvas.operations.dry_run",
                "method": "POST",
                "path": "/v1/canvas/operations/dry-run",
                "risk": "read_only",
                "dry_run": true,
                "paid": false,
                "source": "CanvasOperationAdapter"
            },
            {
                "id": "canvas.operations.apply",
                "method": "POST",
                "path": "/v1/canvas/operations/apply",
                "risk": "reversible_write",
                "dry_run": true,
                "paid": false,
                "source": "CanonicalCanvasAdapter",
                "operations": [
                    "create_node",
                    "update_node",
                    "delete_node",
                    "set_group_members",
                    "update_project",
                    "create_text_node",
                    "create_image_node",
                    "create_video_node",
                    "create_config_node",
                    "move_node",
                    "set_node_text",
                    "set_project_title",
                    "add_connection",
                    "remove_connection"
                ]
            },
            {
                "id":"canvas.commands.submit", "method":"POST", "path":"/v1/canvas/commands",
                "risk":"action_dependent", "paid":"generation_only", "source":"AppCanvasExecutor",
                "actions":crate::commands::ACTIONS,
                "generation_authorization":"authenticated_request_no_canvas_confirmation",
                "execution":"App must be running; open_project selects the bound canvas without manual clicks. A queue receipt is not media success.",
                "idempotency":"request_id_and_exact_payload; claimed commands are never automatically replayed"
            },
            {"id":"canvas.commands.list","method":"GET","path":"/v1/projects/{project_id}/commands?offset=0","risk":"read_only","paid":false},
            {"id":"canvas.commands.status","method":"GET","path":"/v1/projects/{project_id}/commands/{request_id}","risk":"read_only","paid":false},
            {"id":"canvas.commands.cancel","method":"POST","path":"/v1/projects/{project_id}/commands/{request_id}/cancel","risk":"reversible_write","paid":false,"note":"Running remote work may continue; cancel_requested does not mean provider cancellation."},
            {"id":"media.upload","method":"POST","path":"/v1/projects/{project_id}/transfers","content_type":"application/octet-stream","max_bytes":crate::transfers::MAX_BYTES,"paid":false},
            {"id":"media.download","method":"GET","path":"/v1/projects/{project_id}/transfers/{artifact_id}","content_type":"application/octet-stream","paid":false},
            {"id":"projects.actions","method":"POST","path":"/v1/projects/{project_id}/actions","actions":["create","history","preview","restore","status","node"],"risk":"action_dependent","paid":false},
            {
                "id": "runtime.probe",
                "method": "GET",
                "path": "/v1/runtime",
                "risk": "read_only",
                "dry_run": false,
                "paid": false,
                "source": "DesktopRuntime"
            },
            {
                "id": "media.inbox",
                "method": "GET",
                "path": "/v1/media/inbox",
                "risk": "read_only",
                "dry_run": false,
                "paid": false,
                "source": "DesktopRuntime",
                "arbitrary_paths": false
            },
            {
                "id": "media.video_ingest",
                "method": "POST",
                "path": "/v1/media/video-ingests",
                "risk": "reversible_write",
                "dry_run": false,
                "paid": false,
                "source": "DesktopRuntime+CanonicalCanvasAdapter",
                "accepted_mime_types": ["video/mp4"],
                "path_scope": "fixed_app_support_inbox_basename_only",
                "integrity": "required_lowercase_sha256",
                "canvas_node_type": "video"
            },
            {
                "id": "media.image_ingest",
                "method": "POST",
                "path": "/v1/media/image-ingests",
                "risk": "reversible_write",
                "dry_run": false,
                "paid": false,
                "source": "DesktopRuntime+CanonicalCanvasAdapter",
                "accepted_mime_types": ["image/png", "image/jpeg", "image/webp"],
                "path_scope": "fixed_app_support_inbox_basename_only",
                "integrity": "required_lowercase_sha256",
                "canvas_node_type": "image"
            },
            {
                "id": "generation.video_request",
                "method": "POST",
                "path": "/v1/generation/video-requests",
                "risk": "paid_write",
                "dry_run": false,
                "paid": true,
                "approval_required": false,
                "source": "DesktopRuntime+CanonicalCanvasAdapter",
                "resolutions": ["768P", "2K"],
                "duration_seconds_range": [4, 15],
                "keyframe_scope": "existing_image_node_with_local_media",
                "note": "创建 queued 任务与占位节点并启动受控生成；相同 request_id 不重复提交，无画布二次确认"
            },
            {
                "id": "tasks.test_clip",
                "method": "POST",
                "path": "/v1/tasks/test-clips",
                "risk": "reversible_write",
                "dry_run": false,
                "paid": false,
                "mode": "deterministic_local_fixture",
                "source": "DesktopRuntime"
            },
            {
                "id": "tasks.status",
                "method": "GET",
                "path": "/v1/tasks/{task_id}",
                "risk": "read_only",
                "dry_run": false,
                "paid": false,
                "source": "DesktopRuntime"
            },
            {
                "id": "tasks.cancel",
                "method": "POST",
                "path": "/v1/tasks/{task_id}/cancel",
                "risk": "irreversible_local_side_effect",
                "dry_run": false,
                "paid": false,
                "source": "DesktopRuntime"
            },
            {
                "id": "credentials.revoke",
                "method": "POST",
                "path": "/v1/credentials/revoke",
                "risk": "security_state_change",
                "dry_run": false,
                "paid": false,
                "source": "agent_bridge"
            }
        ],
        "existing_interfaces": {
            "tauri_ipc": [
                "probe_desktop_runtime",
                "generate_desktop_test_clip",
                "generate_canvas_test_clip",
                "desktop_task_status",
                "desktop_task_media",
                "cancel_desktop_task",
                "desktop_canvas_projects",
                "save_desktop_canvas_project",
                "delete_desktop_canvas_projects"
            ],
            "desktop_runtime": [
                "ffmpeg_probe",
                "external_connector_probe",
                "local_audio_service_probe",
                "deterministic_test_clip",
                "task_status",
                "task_cancel"
            ]
        },
        "explicitly_denied": [
            "arbitrary_shell",
            "arbitrary_executable",
            "arbitrary_path",
            "arbitrary_url",
            "public_network_listener",
            "raw_sql"
        ]
    })
}
