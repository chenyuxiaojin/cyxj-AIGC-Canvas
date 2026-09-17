use std::collections::HashSet;

use serde_json::{json, Value};

use crate::canvas::{
    editable_node, ensure_node_editable, validate_identifier, validate_point, validate_size,
    validate_text, CanvasSize, Point,
};
use crate::BridgeError;

pub const NODE_TYPES: &[&str] = &[
    "text", "image", "panorama", "video", "audio", "config", "director", "group",
];

fn object_fields(value: &Value, allowed: &[&str]) -> Result<(), BridgeError> {
    let object = value
        .as_object()
        .ok_or_else(|| BridgeError::invalid("操作参数必须是对象。"))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(BridgeError::invalid("操作包含不支持的字段。"));
    }
    Ok(())
}

fn validate_node(node: &Value) -> Result<(), BridgeError> {
    object_fields(
        node,
        &[
            "id", "type", "title", "position", "width", "height", "metadata",
        ],
    )?;
    validate_identifier("node.id", node["id"].as_str().unwrap_or_default(), 64)?;
    if !NODE_TYPES.contains(&node["type"].as_str().unwrap_or_default()) {
        return Err(BridgeError::invalid("未知的画布节点类型。"));
    }
    validate_text("title", node["title"].as_str().unwrap_or_default(), 256)?;
    let position: Point = serde_json::from_value(node["position"].clone())
        .map_err(|_| BridgeError::invalid("节点位置无效。"))?;
    validate_point(&position)?;
    validate_size(&CanvasSize {
        width: node["width"].as_f64().unwrap_or(0.0),
        height: node["height"].as_f64().unwrap_or(0.0),
    })?;
    if !node["metadata"].is_null() && !node["metadata"].is_object() {
        return Err(BridgeError::invalid("节点 metadata 必须是对象。"));
    }
    Ok(())
}

pub fn create_node(project: &mut Value, node: Value) -> Result<(), BridgeError> {
    validate_node(&node)?;
    if let Some(group) = node["metadata"]["groupId"].as_str() {
        ensure_node_editable(project, group)?;
    }
    let nodes = project["nodes"].as_array_mut().unwrap();
    if nodes.iter().any(|existing| existing["id"] == node["id"]) {
        return Err(BridgeError::conflict("NODE_EXISTS", "节点编号已存在。"));
    }
    nodes.push(node);
    Ok(())
}

pub fn update_node(project: &mut Value, id: &str, patch: &Value) -> Result<(), BridgeError> {
    object_fields(patch, &["title", "position", "width", "height", "metadata"])?;
    let previous = editable_node(project, id)?.clone();
    let mut next = previous.clone();
    for (key, value) in patch.as_object().unwrap() {
        if key == "metadata" {
            let fields = value.as_object().ok_or_else(|| {
                BridgeError::invalid("metadata 补丁必须是对象；使用 null 清除其中单个字段。")
            })?;
            if !next["metadata"].is_object() {
                next["metadata"] = json!({});
            }
            let metadata = next["metadata"].as_object_mut().unwrap();
            for (field, value) in fields {
                if matches!(field.as_str(), "locked" | "agentLocked") {
                    return Err(BridgeError::forbidden("Agent 不能修改人工锁定状态。"));
                }
                if value.is_null() {
                    metadata.remove(field);
                } else {
                    metadata.insert(field.clone(), value.clone());
                }
            }
        } else {
            next[key] = value.clone();
        }
    }
    // Preserve unknown legacy fields while validating the current editable schema.
    let editable: Value = next
        .as_object()
        .unwrap()
        .iter()
        .filter(|(key, _)| {
            [
                "id", "type", "title", "position", "width", "height", "metadata",
            ]
            .contains(&key.as_str())
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    validate_node(&editable)?;
    if next["type"] == "group" && next["position"] != previous["position"] {
        let dx =
            next["position"]["x"].as_f64().unwrap() - previous["position"]["x"].as_f64().unwrap();
        let dy =
            next["position"]["y"].as_f64().unwrap() - previous["position"]["y"].as_f64().unwrap();
        let children: Vec<String> = project["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|node| node["metadata"]["groupId"] == id)
            .filter_map(|node| node["id"].as_str().map(str::to_owned))
            .collect();
        for child in children {
            let node = editable_node(project, &child)?;
            let position = Point {
                x: node["position"]["x"].as_f64().unwrap_or(0.0) + dx,
                y: node["position"]["y"].as_f64().unwrap_or(0.0) + dy,
            };
            validate_point(&position)?;
            node["position"] = json!(position);
        }
    }
    for group in [
        previous["metadata"]["groupId"].as_str(),
        next["metadata"]["groupId"].as_str(),
    ]
    .into_iter()
    .flatten()
    {
        if previous["metadata"]["groupId"] != next["metadata"]["groupId"] {
            ensure_node_editable(project, group)?;
        }
    }
    *editable_node(project, id)? = next;
    Ok(())
}

pub fn delete_node(project: &mut Value, id: &str) -> Result<(), BridgeError> {
    ensure_node_editable(project, id)?;
    let nodes = project["nodes"].as_array().unwrap();
    let mut removed = HashSet::from([id.to_owned()]);
    if let Some(children) = nodes
        .iter()
        .find(|n| n["id"] == id)
        .and_then(|n| n["metadata"]["batchChildIds"].as_array())
    {
        removed.extend(
            children
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned)),
        );
    }
    for node in nodes {
        if node["metadata"]["isBatchRoot"] == true
            && node["metadata"]["batchChildIds"]
                .as_array()
                .is_some_and(|children| {
                    !children.is_empty()
                        && children
                            .iter()
                            .all(|child| child.as_str().is_some_and(|id| removed.contains(id)))
                })
        {
            removed.insert(node["id"].as_str().unwrap().to_owned());
        }
    }
    for id in &removed {
        ensure_node_editable(project, id)?;
    }
    let affected: Vec<String> = nodes
        .iter()
        .filter(|node| {
            node["metadata"]["groupId"]
                .as_str()
                .is_some_and(|id| removed.contains(id))
                || node["metadata"]["batchChildIds"]
                    .as_array()
                    .is_some_and(|ids| {
                        ids.iter()
                            .any(|id| id.as_str().is_some_and(|id| removed.contains(id)))
                    })
        })
        .filter_map(|n| n["id"].as_str().map(str::to_owned))
        .collect();
    for id in affected {
        ensure_node_editable(project, &id)?;
    }
    for connection in project["connections"].as_array().unwrap() {
        if ["fromNodeId", "toNodeId"].iter().any(|key| {
            connection[*key]
                .as_str()
                .is_some_and(|id| removed.contains(id))
        }) {
            for key in ["fromNodeId", "toNodeId"] {
                ensure_node_editable(project, connection[key].as_str().unwrap())?;
            }
        }
    }
    project["nodes"]
        .as_array_mut()
        .unwrap()
        .retain(|node| !removed.contains(node["id"].as_str().unwrap()));
    let retained = project["nodes"].clone();
    for node in project["nodes"].as_array_mut().unwrap() {
        if node["metadata"]["groupId"]
            .as_str()
            .is_some_and(|id| removed.contains(id))
        {
            node["metadata"].as_object_mut().unwrap().remove("groupId");
        }
        if let Some(children) = node["metadata"]["batchChildIds"].as_array_mut() {
            children.retain(|id| !id.as_str().is_some_and(|id| removed.contains(id)));
        }
        if node["metadata"]["primaryImageId"]
            .as_str()
            .is_some_and(|id| removed.contains(id))
        {
            let primary = node["metadata"]["batchChildIds"][0].clone();
            if let Some(source) = retained
                .as_array()
                .unwrap()
                .iter()
                .find(|n| n["id"] == primary)
            {
                for field in [
                    "content",
                    "storageKey",
                    "naturalWidth",
                    "naturalHeight",
                    "panoramaProjection",
                ] {
                    if let Some(value) = source["metadata"].get(field) {
                        node["metadata"][field] = value.clone();
                    }
                }
            }
            node["metadata"]["primaryImageId"] = primary;
        }
    }
    project["connections"]
        .as_array_mut()
        .unwrap()
        .retain(|edge| {
            !["fromNodeId", "toNodeId"]
                .iter()
                .any(|key| removed.contains(edge[*key].as_str().unwrap()))
        });
    // Persistent media and history remain available for recovery.
    Ok(())
}

pub fn set_group_members(
    project: &mut Value,
    id: &str,
    members: &[String],
) -> Result<(), BridgeError> {
    if editable_node(project, id)?["type"] != "group" {
        return Err(BridgeError::invalid("目标节点不是分组。"));
    }
    let selected: HashSet<&str> = members.iter().map(String::as_str).collect();
    if selected.len() != members.len() {
        return Err(BridgeError::invalid("分组成员编号重复。"));
    }
    for member in members {
        let node = editable_node(project, member)?;
        if node["type"] == "group" {
            return Err(BridgeError::invalid("暂不支持嵌套分组。"));
        }
        if let Some(previous) = node["metadata"]["groupId"]
            .as_str()
            .filter(|previous| *previous != id)
            .map(str::to_owned)
        {
            ensure_node_editable(project, &previous)?;
        }
    }
    let affected: Vec<String> = project["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| {
            n["metadata"]["groupId"] == id
                || n["id"].as_str().is_some_and(|id| selected.contains(id))
        })
        .map(|n| n["id"].as_str().unwrap().to_owned())
        .collect();
    for member in affected {
        let node = editable_node(project, &member)?;
        if !node["metadata"].is_object() {
            node["metadata"] = json!({});
        }
        if selected.contains(member.as_str()) {
            node["metadata"]["groupId"] = json!(id);
        } else {
            node["metadata"].as_object_mut().unwrap().remove("groupId");
        }
    }
    Ok(())
}

pub fn validate_groups(project: &Value) -> Result<(), BridgeError> {
    for node in project["nodes"].as_array().unwrap() {
        if let Some(group) = node["metadata"]["groupId"].as_str() {
            if node["type"] == "group"
                || !project["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|n| n["id"] == group && n["type"] == "group")
            {
                return Err(BridgeError::invalid("分组引用无效。"));
            }
        }
    }
    Ok(())
}

pub fn update_project(project: &mut Value, patch: &Value) -> Result<(), BridgeError> {
    object_fields(
        patch,
        &[
            "title",
            "autoTitlePending",
            "agentConfig",
            "backgroundMode",
            "showImageInfo",
            "viewport",
            "sidePanel",
            "agentPanel",
        ],
    )?;
    if let Some(title) = patch.get("title") {
        validate_text("title", title.as_str().unwrap_or_default(), 256)?;
    }
    for (key, value) in patch.as_object().unwrap() {
        let valid = match key.as_str() {
            "title" => value.is_string(),
            "autoTitlePending" | "showImageInfo" => value.is_boolean(),
            "backgroundMode" => matches!(value.as_str(), Some("lines" | "dots" | "blank")),
            "agentConfig" => {
                value.is_null()
                    || (value.is_object()
                        && value.as_object().unwrap().iter().all(|(key, value)| {
                            ["imageQuality", "imageSize", "videoQuality", "videoSize"]
                                .contains(&key.as_str())
                                && value.as_str().is_some_and(|text| text.len() <= 128)
                        }))
            }
            "viewport" => {
                object_fields(value, &["x", "y", "k"])?;
                value["x"]
                    .as_f64()
                    .is_some_and(|v| v.is_finite() && v.abs() <= 1e8)
                    && value["y"]
                        .as_f64()
                        .is_some_and(|v| v.is_finite() && v.abs() <= 1e8)
                    && value["k"]
                        .as_f64()
                        .is_some_and(|v| v.is_finite() && v > 0.0 && v <= 100.0)
            }
            "sidePanel" | "agentPanel" => {
                object_fields(value, &["open", "width"])?;
                value["open"].is_boolean()
                    && value["width"]
                        .as_f64()
                        .is_some_and(|v| v.is_finite() && (100.0..=3000.0).contains(&v))
            }
            _ => false,
        };
        if !valid {
            return Err(BridgeError::invalid(format!("画布字段 {key} 无效。")));
        }
        project[key] = value.clone();
    }
    Ok(())
}
