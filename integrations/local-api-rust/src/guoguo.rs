// Fixed host and paths: the desktop must not become an arbitrary authenticated proxy.
use axum::{body::{Body, Bytes}, http::{HeaderMap, Method, StatusCode}, response::{IntoResponse, Response}, Json};
use futures_util::StreamExt;
use serde_json::json;
use std::{io, time::Duration};

fn allowed(method: &Method, path: &str) -> bool {
    (method == Method::GET && path == "v1/models")
        || (method == Method::POST && path == "v1/chat/completions")
}

pub async fn forward(method: Method, path: String, headers: HeaderMap, body: Bytes) -> Response {
    if !allowed(&method, &path) { return StatusCode::NOT_FOUND.into_response(); }
    let Some(auth) = headers.get("authorization").filter(|v| v.to_str().is_ok_and(|s| s.starts_with("Bearer ") && s.len() > 7)) else { return StatusCode::UNAUTHORIZED.into_response(); };
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(900))
        .build() {
        Ok(client) => client,
        Err(_) => return failure("本机请求服务初始化失败"),
    };
    let response = match client.request(method, format!("https://api.chatgpt-code.com/{path}"))
        .header("authorization", auth)
        .header("content-type", "application/json")
        .header("user-agent", "Mozilla/5.0")
        .body(body).send().await {
        Ok(response) => response,
        Err(_) => return failure("Omni Flash 连接中断或超时；请求可能已提交，请先核对结果，勿重复生成"),
    };
    let mut output = Response::builder().status(response.status()).header("cache-control", "no-store");
    for name in ["content-type", "x-request-id", "x-oneapi-request-id"] {
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
    fn only_model_listing_and_chat_creation_are_forwarded() {
        assert!(allowed(&Method::GET, "v1/models"));
        assert!(allowed(&Method::POST, "v1/chat/completions"));
        for path in ["v1/models", "v1/chat/completions", "v1/videos", "v1/media/videos", "v1/../models", "https://elsewhere.test/v1/models"] {
            assert_eq!(allowed(&Method::GET, path), path == "v1/models");
            assert_eq!(allowed(&Method::POST, path), path == "v1/chat/completions");
            assert!(!allowed(&Method::DELETE, path));
        }
    }

    #[tokio::test]
    async fn rejects_missing_auth_and_unlisted_paths_before_network() {
        assert_eq!(forward(Method::GET, "v1/models".into(), HeaderMap::new(), Bytes::new()).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(forward(Method::POST, "v1/videos".into(), HeaderMap::new(), Bytes::new()).await.status(), StatusCode::NOT_FOUND);
    }
}
