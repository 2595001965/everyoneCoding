//! 受限网络命令：host 白名单强制 + 受限 fetch。
//!
//! 默认拒绝所有主机，需经 `net_set_allowed_hosts` 显式放行（OAuth / AI 请求 / 版本检查）。
//! 这是「不依赖命令行、不出网上传用户内容」硬约束的 enforcer。Rust 侧与 TS 侧双重校验。

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use serde::Serialize;
use tauri::State;

use crate::error::CommandError;
use crate::state::AppState;

/// 允许的 host 集合（Rust 侧权威状态，TS 同时维护本地镜像用于同步判断）。
#[derive(Clone)]
pub enum AllowedHosts {
    All,
    List(Vec<String>),
}

impl Default for AllowedHosts {
    fn default() -> Self {
        AllowedHosts::List(Vec::new())
    }
}

/// `net_set_allowed_hosts` 入参：`"*"` 表示全部放行，或字符串数组。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum AllowedHostsWire {
    All(String),
    List(Vec<String>),
}

/// HTTP 方法（与 TS `HttpMethod` 对齐，大写下划线）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethodWire {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

/// `net_fetch` 请求入参（与 TS `NetRequest` 对齐）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct NetRequestWire {
    pub url: String,
    pub method: Option<HttpMethodWire>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    pub body_base64: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// `net_fetch` 响应（与 TS `NetResponse` 对齐）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetResponseWire {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// 在白名单快照中检查 host。
fn host_allowed(policy: &AllowedHosts, host: &str) -> bool {
    match policy {
        AllowedHosts::All => true,
        AllowedHosts::List(list) => list.iter().any(|h| h == host),
    }
}

/// 设置允许的 host 白名单。
#[tauri::command(rename_all = "snake_case")]
pub async fn net_set_allowed_hosts(
    hosts: AllowedHostsWire,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let next = match hosts {
        AllowedHostsWire::All(s) if s == "*" => AllowedHosts::All,
        AllowedHostsWire::All(_) => AllowedHosts::List(Vec::new()),
        AllowedHostsWire::List(list) => AllowedHosts::List(list),
    };
    *state.allowed_hosts.lock().await = next;
    Ok(())
}

/// 判断某 host 是否被放行（同步查询 Rust 侧状态）。
#[tauri::command(rename_all = "snake_case")]
pub async fn net_is_host_allowed(
    host: String,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let policy = state.allowed_hosts.lock().await.clone();
    Ok(host_allowed(&policy, &host))
}

/// 受限 fetch：未放行主机直接拒绝，绝不发起请求。
#[tauri::command(rename_all = "snake_case")]
pub async fn net_fetch(
    request: NetRequestWire,
    state: State<'_, AppState>,
) -> Result<NetResponseWire, CommandError> {
    let policy = state.allowed_hosts.lock().await.clone();
    let parsed = reqwest::Url::parse(&request.url)
        .map_err(|e| CommandError::invalid_argument(format!("URL 非法: {e}")))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| CommandError::net_blocked("URL 缺少 host"))?;
    if !host_allowed(&policy, host) {
        return Err(CommandError::net_blocked(format!("目标主机未被放行: {host}")));
    }

    let method = match request.method.unwrap_or(HttpMethodWire::Get) {
        HttpMethodWire::Get => reqwest::Method::GET,
        HttpMethodWire::Post => reqwest::Method::POST,
        HttpMethodWire::Put => reqwest::Method::PUT,
        HttpMethodWire::Patch => reqwest::Method::PATCH,
        HttpMethodWire::Delete => reqwest::Method::DELETE,
    };

    let mut builder = reqwest::Client::builder();
    if let Some(ms) = request.timeout_ms {
        builder = builder.timeout(Duration::from_millis(ms));
    }
    let client = builder
        .build()
        .map_err(|e| CommandError::net_error(e.to_string()))?;

    let mut req = client.request(method, &request.url);
    if let Some(headers) = &request.headers {
        for (k, v) in headers {
            req = req.header(k, v);
        }
    }
    if let Some(b64) = &request.body_base64 {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| CommandError::invalid_argument(format!("body_base64 解码失败: {e}")))?;
        req = req.body(raw);
    } else if let Some(body) = &request.body {
        req = req.body(body.clone());
    }

    let resp = req
        .send()
        .await
        .map_err(|e| CommandError::net_error(e.to_string()))?;
    let status = resp.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let mut headers_map = HashMap::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            headers_map.insert(k.as_str().to_string(), s.to_string());
        }
    }
    let body = resp
        .text()
        .await
        .map_err(|e| CommandError::net_error(e.to_string()))?;

    Ok(NetResponseWire {
        status: status.as_u16(),
        status_text,
        headers: headers_map,
        body,
    })
}
