// A fixed upstream avoids exposing an arbitrary credential-bearing HTTP proxy.
use axum::{body::{Body, Bytes}, http::{HeaderMap, Method, StatusCode}, response::{IntoResponse, Response}, Json};
use futures_util::StreamExt;
use serde_json::json;
use std::{io, time::Duration};

fn allowed(method: &Method, path: &str) -> bool {
    (method == Method::GET && ["v1/models", "v1/media/models"].contains(&path))
        || (method == Method::POST && ["v1/chat/completions", "v1/media/videos"].contains(&path))
        || (method == Method::GET && path.strip_prefix("v1/media/videos/").or_else(|| path.strip_prefix("v1/videos/")).is_some_and(|id| {
            let id = id.strip_suffix("/content").unwrap_or(id);
            !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        }))
}

pub async fn forward(method: Method, path: String, headers: HeaderMap, body: Bytes) -> Response {
    if !allowed(&method, &path) { return StatusCode::NOT_FOUND.into_response(); }
    let Some(auth) = headers.get("authorization").filter(|v| v.to_str().is_ok_and(|s| s.starts_with("Bearer ") && s.len() > 7)) else { return StatusCode::UNAUTHORIZED.into_response(); };
    let client = match reqwest::Client::builder()
        // Only completed-content GETs may follow a signed CDN redirect. Reqwest
        // strips Authorization on cross-host redirects; creation never redirects.
        .redirect(if method == Method::GET && path.ends_with("/content") { reqwest::redirect::Policy::limited(5) } else { reqwest::redirect::Policy::none() })
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(900))
        .build() {
        Ok(client) => client,
        Err(_) => return failure("本机请求服务初始化失败"),
    };
    let body = if method == Method::POST && path == "v1/media/videos" {
        if !headers.contains_key("idempotency-key") { return (StatusCode::BAD_REQUEST, Json(json!({"error":{"message":"缺少防重复提交标识"}}))).into_response(); }
        match crate::laogou_refs::public_references(&client, &body).await {
            Ok(body) => Bytes::from(body),
            Err(message) => return (StatusCode::BAD_REQUEST, Json(json!({"error":{"message":message}}))).into_response(),
        }
    } else { body };
    let mut request = client.request(method, format!("https://api.laogou.org/{path}"))
        .header("authorization", auth)
        .header("content-type", "application/json")
        .header("user-agent", "Mozilla/5.0");
    for name in ["idempotency-key", "range"] {
        if let Some(value) = headers.get(name) { request = request.header(name, value); }
    }
    let response = match request.body(body).send().await {
        Ok(response) => response,
        Err(_) => return failure("视频服务连接中断或超时；请求可能已提交，请先核对结果，勿重复生成"),
    };
    let mut output = Response::builder().status(response.status()).header("cache-control", "no-store");
    for name in ["content-type", "x-request-id", "content-range", "accept-ranges", "location"] {
        if let Some(value) = response.headers().get(name) { output = output.header(name, value); }
    }
    output.body(Body::from_stream(response.bytes_stream().map(|chunk| chunk.map_err(|_| io::Error::other("视频接口连接中断")))))
        .unwrap_or_else(|_| failure("视频响应无法读取"))
}

fn failure(message: &str) -> Response {
    (StatusCode::BAD_GATEWAY, Json(json!({"error":{"message":message}}))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_expected_video_paths_and_methods_are_forwarded() {
        assert!(allowed(&Method::GET, "v1/models"));
        assert!(allowed(&Method::POST, "v1/chat/completions"));
        assert!(allowed(&Method::GET, "v1/videos/task_123-abc"));
        assert!(allowed(&Method::POST, "v1/media/videos"));
        assert!(allowed(&Method::GET, "v1/media/models"));
        assert!(allowed(&Method::GET, "v1/media/videos/task_123-abc"));
        assert!(allowed(&Method::GET, "v1/media/videos/task_123-abc/content"));
        assert!(!allowed(&Method::POST, "v1/media/videos/task_123-abc"));
        assert!(!allowed(&Method::GET, "v1/media/videos/a/b/content"));
        for path in ["https://elsewhere.test/v1/models", "v1/usage", "v1/videos/../models", "v1/videos/a/b", "v1/videos/"] { assert!(!allowed(&Method::GET, path)); }
        assert!(!allowed(&Method::POST, "v1/models"));
        assert!(!allowed(&Method::GET, "v1/chat/completions"));
    }
}
