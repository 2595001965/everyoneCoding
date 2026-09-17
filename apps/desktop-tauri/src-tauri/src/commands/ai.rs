//! Tauri AI 命令占位接口。
//!
//! 真实 AiStack 运行在 Rust 侧接入后，通过同一结构化 RPC/Channel 契约替换实现。
//! 在未接入时显式返回 NOT_SUPPORTED，不伪造成功结果。

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

#[derive(Debug, Deserialize)]
pub struct AiRpcRequest {
    pub request_id: String,
    pub method: String,
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct AiRpcResponse {
    pub request_id: String,
    pub ok: bool,
    pub error: Option<AiRpcErrorWire>,
    pub result: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct AiRpcErrorWire {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct AiStreamRequest {
    pub request_id: String,
    pub purpose: String,
    pub messages: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct AiStreamEventWire {
    pub request_id: String,
    pub event: serde_json::Value,
}

#[tauri::command]
pub async fn ai_invoke(request: AiRpcRequest) -> Result<AiRpcResponse, String> {
    Ok(AiRpcResponse {
        request_id: request.request_id,
        ok: false,
        error: Some(AiRpcErrorWire { code: "NOT_SUPPORTED".into(), message: "Tauri Rust AI 栈尚未接入".into() }),
        result: None,
    })
}

#[tauri::command]
pub async fn ai_stream_start(
    request: AiStreamRequest,
    _channel: Channel<AiStreamEventWire>,
) -> Result<(), String> {
    let _ = request;
    Err(serde_json::json!({ "code": "NOT_SUPPORTED", "message": "Tauri Rust AI 栈尚未接入" }).to_string())
}

#[tauri::command]
pub async fn ai_abort(_request_id: String) -> Result<(), String> {
    Ok(())
}
