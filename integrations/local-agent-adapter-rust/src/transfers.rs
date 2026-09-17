use crate::{BridgeError, CanvasOperationAdapter, SqliteCanvasAdapter};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
};

pub const MAX_BYTES: usize = 512 * 1024 * 1024;
fn directory(adapter: &SqliteCanvasAdapter, project: &str) -> Result<PathBuf, BridgeError> {
    adapter.get_project(project)?;
    let root = adapter
        .database_path()
        .parent()
        .ok_or_else(|| BridgeError::internal("缺少传输目录。"))?
        .join("canvas-transfers");
    let path = root.join(project);
    for p in [&root, &path] {
        if p.exists()
            && fs::symlink_metadata(p)
                .map_err(|_| BridgeError::internal("无法读取传输目录。"))?
                .file_type()
                .is_symlink()
        {
            return Err(BridgeError::forbidden("传输目录不能是符号链接。"));
        }
        fs::create_dir_all(p).map_err(|_| BridgeError::internal("无法创建传输目录。"))?;
    }
    Ok(path)
}
pub fn write(
    adapter: &SqliteCanvasAdapter,
    project: &str,
    bytes: &[u8],
) -> Result<Value, BridgeError> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(BridgeError::invalid("素材必须为 1 字节至 512 MiB。"));
    }
    let hash = format!("{:x}", Sha256::digest(bytes));
    let root = directory(adapter, project)?;
    let target = root.join(&hash);
    if target.exists() {
        if read(adapter, project, &hash)? != bytes {
            return Err(BridgeError::conflict(
                "TRANSFER_CONFLICT",
                "素材校验不一致。",
            ));
        }
    } else {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| BridgeError::internal("无法创建传输编号。"))?;
        let temporary = root.join(format!(
            ".{}.tmp",
            random
                .iter()
                .map(|v| format!("{v:02x}"))
                .collect::<String>()
        ));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temporary)
                .map_err(|_| BridgeError::internal("无法创建素材文件。"))?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| BridgeError::internal("素材写入失败。"))?;
            if fs::hard_link(&temporary, &target).is_err()
                && read(adapter, project, &hash)? != bytes
            {
                return Err(BridgeError::conflict("TRANSFER_CONFLICT", "素材写入冲突。"));
            }
            Ok(())
        })();
        let _ = fs::remove_file(&temporary);
        result?;
    }
    Ok(json!({"artifact_id":hash,"sha256":hash,"bytes":bytes.len(),"project_id":project}))
}
pub fn read(
    adapter: &SqliteCanvasAdapter,
    project: &str,
    id: &str,
) -> Result<Vec<u8>, BridgeError> {
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(BridgeError::invalid("素材编号必须是 SHA-256。"));
    }
    let target = directory(adapter, project)?.join(id);
    let metadata = fs::symlink_metadata(&target)
        .map_err(|_| BridgeError::not_found("素材传输文件不存在。"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BYTES as u64
    {
        return Err(BridgeError::forbidden("素材传输文件无效。"));
    }
    let mut bytes = Vec::new();
    fs::File::open(&target)
        .and_then(|file| file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| BridgeError::internal("素材读取失败。"))?;
    if bytes.len() > MAX_BYTES || format!("{:x}", Sha256::digest(&bytes)) != id {
        return Err(BridgeError::invalid("素材校验失败。"));
    }
    Ok(bytes)
}
