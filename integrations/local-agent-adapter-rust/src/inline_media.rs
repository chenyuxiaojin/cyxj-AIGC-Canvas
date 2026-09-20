//! Persist original media before it enters project snapshots or the operation journal.
use std::{fs::{self, OpenOptions}, io::Write, path::Path};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::BridgeError;

pub fn store(root: &Path, data: &str) -> Result<Value, BridgeError> {
    store_inner(root, data, true)
}

fn store_inner(root: &Path, data: &str, persist: bool) -> Result<Value, BridgeError> {
    let (header, encoded) = data.split_once(",").ok_or_else(|| BridgeError::invalid("素材 data URL 无效"))?;
    let mime = header.strip_prefix("data:").and_then(|v| v.strip_suffix(";base64"))
        .ok_or_else(|| BridgeError::invalid("素材必须是 base64 data URL"))?;
    let extension = match mime {
        "image/png" => "png", "image/jpeg" => "jpg", "image/webp" => "webp", "image/gif" => "gif",
        "image/avif" => "avif", "video/mp4" => "mp4", "audio/mpeg" => "mp3", "audio/wav" => "wav",
        _ => return Err(BridgeError::invalid("不支持的内嵌素材格式")),
    };
    if encoded.len() > 96 * 1024 * 1024 { return Err(BridgeError::invalid("单份内嵌素材超过 72 MiB，请使用文件导入")); }
    let bytes = STANDARD.decode(encoded).map_err(|_| BridgeError::invalid("素材 base64 无效"))?;
    if bytes.is_empty() { return Err(BridgeError::invalid("素材为空")); }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let asset = format!("asset-{}", &hash[..32]);
    let relative = format!("owned/{asset}.{extension}");
    let reference = json!({"assetId":asset,"storageKey":format!("local-ref:{asset}"),"rootId":"project-media","relativePath":relative,
        "sha256":hash,"mimeType":mime,"bytes":bytes.len(),"fileName":format!("{asset}.{extension}"),"mode":"project_copy"});
    if !persist { return Ok(reference); }
    let directory = root.join("project-media").join("owned");
    for path in [root.join("project-media"), directory.clone()] {
        if path.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) { return Err(BridgeError::forbidden("素材目录不能是符号链接")); }
        fs::create_dir_all(path).map_err(|_| BridgeError::internal("无法创建素材目录"))?;
    }
    let target = root.join("project-media").join(&relative);
    if target.exists() {
        let metadata = target.symlink_metadata().map_err(|_| BridgeError::internal("无法检查素材"))?;
        if !metadata.is_file() || metadata.len() != bytes.len() as u64 || format!("{:x}", Sha256::digest(fs::read(&target).map_err(|_| BridgeError::internal("无法校验素材"))?)) != hash {
            return Err(BridgeError::invalid("已有素材校验失败，未覆盖"));
        }
    } else {
        let mut random = [0;16]; getrandom::fill(&mut random).map_err(|_| BridgeError::internal("无法创建临时素材"))?;
        let temporary = directory.join(format!(".inline-{:x}.part", u128::from_ne_bytes(random)));
        let result: Result<(), BridgeError> = (|| {
            let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|_| BridgeError::internal("无法写入素材"))?;
            file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| BridgeError::internal("素材写入失败"))?;
            fs::hard_link(&temporary, &target).or_else(|error| if error.kind() == std::io::ErrorKind::AlreadyExists { Ok(()) } else { Err(error) })
                .map_err(|_| BridgeError::internal("无法发布素材"))?;
            Ok(())
        })();
        let _ = fs::remove_file(temporary); result?;
    }
    Ok(reference)
}

pub fn normalize(root: &Path, value: &mut Value) -> Result<(), BridgeError> {
    normalize_with_persistence(root, value, true)
}

pub fn normalize_with_persistence(root: &Path, value: &mut Value, persist: bool) -> Result<(), BridgeError> {
    match value {
        Value::Array(values) => for value in values { normalize_with_persistence(root, value, persist)?; },
        Value::Object(object) => {
            if let Some(content) = object.get("content").and_then(Value::as_str).filter(|v| v.starts_with("data:image/") || v.starts_with("data:video/") || v.starts_with("data:audio/")) {
                let reference = store_inner(root, content, persist)?;
                object.insert("content".into(), reference["storageKey"].clone());
                object.insert("storageKey".into(), reference["storageKey"].clone());
                object.insert("localMedia".into(), reference);
            }
            for value in object.values_mut() { normalize_with_persistence(root, value, persist)?; }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_bytes_and_nested_undo_are_preserved_and_deduplicated() {
        let root = tempfile::tempdir().unwrap();
        let data = "data:image/png;base64,aGVsbG8=";
        let mut project = json!({"nodes":[{"metadata":{"content":data}}],"undo":{"nodes":[{"metadata":{"content":data}}]}});
        normalize(root.path(), &mut project).unwrap();
        let meta = &project["nodes"][0]["metadata"];
        assert_eq!(meta, &project["undo"]["nodes"][0]["metadata"]);
        assert_eq!(fs::read(root.path().join("project-media").join(meta["localMedia"]["relativePath"].as_str().unwrap())).unwrap(), b"hello");
        assert_eq!(fs::read_dir(root.path().join("project-media/owned")).unwrap().count(),1);
        let original = project.clone(); normalize(root.path(), &mut project).unwrap(); assert_eq!(original, project);
    }
}
