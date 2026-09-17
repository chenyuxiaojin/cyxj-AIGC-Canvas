//! The configured personal image host supplies HTTPS references; Laogou rejects data URLs.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::OnceLock};
use tokio::sync::Mutex;

#[derive(Default)]
struct UploadCache { token: String, urls: HashMap<String, String> }
static CACHE: OnceLock<Mutex<UploadCache>> = OnceLock::new();

fn decode_image(value: &str) -> Result<Option<(String, Vec<u8>)>, String> {
    if value.starts_with("https://") { return Ok(None); }
    let (prefix, data) = value.split_once(";base64,").ok_or("参考图必须是原图数据或 HTTPS 地址")?;
    let mime = prefix.strip_prefix("data:").unwrap_or("");
    if !["image/png", "image/jpeg", "image/webp"].contains(&mime) { return Err("参考图只支持 PNG、JPEG、WebP".into()); }
    let bytes = STANDARD.decode(data).map_err(|_| "参考图数据损坏")?;
    if bytes.is_empty() || bytes.len() > 12 * 1024 * 1024 { return Err("单张参考图必须在 12MB 以内".into()); }
    Ok(Some((mime.into(), bytes)))
}

pub async fn public_references(client: &reqwest::Client, body: &[u8]) -> Result<Vec<u8>, String> {
    let mut payload: Value = serde_json::from_slice(body).map_err(|_| "视频请求格式错误")?;
    let Some(images) = payload.get_mut("image_urls").and_then(Value::as_array_mut) else { return Ok(body.to_vec()); };
    if images.len() > 30 { return Err("参考图最多 30 张".into()); }
    let decoded: Vec<_> = images.iter().map(|v| decode_image(v.as_str().unwrap_or(""))).collect::<Result<_, _>>()?;
    if decoded.iter().flatten().map(|(_, bytes)| bytes.len()).sum::<usize>() > 70 * 1024 * 1024 { return Err("参考图总量超过 70MB".into()); }
    if decoded.iter().all(Option::is_none) { return Ok(body.to_vec()); }
    let mut cache = CACHE.get_or_init(Default::default).lock().await;
    if cache.token.is_empty() {
        let home = std::env::var("HOME").map_err(|_| "无法定位统一密钥存储")?;
        let path = std::path::Path::new(&home).join("项目/自己的应用/密钥存储/.env");
        let env: HashMap<String, String> = dotenvy::from_path_iter(path).map_err(|_| "无法读取已配置的图床凭据")?.collect::<Result<_, _>>().map_err(|_| "图床凭据配置格式错误")?;
        let email = env.get("LSKY_EMAIL").ok_or("密钥存储缺少图床登录信息")?;
        let password = env.get("LSKY_PASSWORD").ok_or("密钥存储缺少图床登录信息")?;
        let data: Value = client.post("https://img.xiaochens.com/api/v1/tokens").header("accept", "application/json")
            .json(&serde_json::json!({"email":email,"password":password})).send().await.map_err(|_| "图床连接失败，尚未提交视频")?
            .json().await.map_err(|_| "图床登录响应无效")?;
        cache.token = data.pointer("/data/token").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("图床登录失败，尚未提交视频")?.into();
    }
    for (image, decoded) in images.iter_mut().zip(decoded) {
        let Some((mime, bytes)) = decoded else { continue; };
        let hash = format!("{:x}", Sha256::digest(&bytes));
        if let Some(url) = cache.urls.get(&hash) { *image = Value::String(url.clone()); continue; }
        let extension = if mime == "image/jpeg" { "jpg" } else { mime.strip_prefix("image/").unwrap() };
        let part = reqwest::multipart::Part::bytes(bytes).file_name(format!("{hash}.{extension}")).mime_str(&mime).map_err(|_| "参考图类型无效")?;
        let response = client.post("https://img.xiaochens.com/api/v1/upload").bearer_auth(&cache.token).header("accept", "application/json")
            .multipart(reqwest::multipart::Form::new().part("file", part).text("permission", "1")).send().await.map_err(|_| "参考图上传失败，尚未提交视频")?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED { cache.token.clear(); return Err("图床登录已过期，尚未提交视频".into()); }
        let data: Value = response.json().await.map_err(|_| "图床上传响应无效")?;
        let url = data.pointer("/data/links/url").and_then(Value::as_str).filter(|url| url.starts_with("https://img.xiaochens.com/")).ok_or("图床未返回有效图片地址，尚未提交视频")?.to_string();
        *image = Value::String(url.clone()); cache.urls.insert(hash, url);
    }
    serde_json::to_vec(&payload).map_err(|_| "视频请求编码失败".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_inputs_are_bounded_and_bad_inputs_do_not_upload() {
        assert!(decode_image("https://img.xiaochens.com/i/ref.png").unwrap().is_none());
        assert_eq!(decode_image("data:image/png;base64,aGVsbG8=").unwrap().unwrap().1, b"hello");
        for input in ["file:///secret", "http://localhost/private", "data:text/html;base64,aGk=", "data:image/png;base64,", "data:image/png;base64,???"] { assert!(decode_image(input).is_err()); }
    }
}
