//! AI 控制命令：把侧车里的真实 AI 栈（Provider/Model/预算/流式/远程配置）接到渲染层。
//!
//! ## 与旧版占位实现的区别（本轮的关键变化）
//!
//! 旧版本这里是一组"占位接口"，任何调用都返回 `NOT_SUPPORTED：Tauri Rust AI 栈尚未接入`。
//! 现在 AI 栈**不再需要**在 Rust 里重写：它随侧车一起跑（`@ec/ai` + better-sqlite3 +
//! DPAPI 密钥环 + 流式网关），Rust 只负责协议搬运与错误合成。
//!
//! ## 为什么流式不走 Channel 参数
//!
//! `ai.stream` 的分片与 `domain.event` 共用一条侧车事件总线（`sidecar_subscribe`）。
//! 原因：流式分片与触发它的请求在时序上互相纠缠（同一次调用的进度与结果），
//! 若各开一条通道，桥接层就要维护"哪条通道先建立"的竞态。
//! 渲染层按 `requestId` 分流，与 Electron 形态完全同构。
//!
//! ## 三条不变量
//!
//! 1. **请求体原样透传**：`AiStreamRequest` 里的 `projectId` / `modelId` / `temperature`
//!    等字段一个都不能丢 —— 用 `Value` 而不是精简 struct，正是为了不留"未声明的字段
//!    会被静默吃掉"的口子（那类故障表现为"配了模型却不生效"）。
//! 2. **一定返回 `AiRpcResponse` 形状**：侧车不可用时合成 `ok:false` + 真实原因。
//! 3. **失败必须可操作**：原因里要指出缺的是什么（Node？DPAPI？产物？）。

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::State;

use crate::sidecar::protocol::{op, WireError};
use crate::sidecar::SidecarManager;

/// AI RPC 超时：包含真实网络往返（测试连接、拉取模型列表、远程配置拉取），
/// 比域调用更需要余量，但同样必须有上限。
const AI_INVOKE_TIMEOUT: Duration = Duration::from_secs(180);

fn request_id_of(request: &Value) -> String {
    request
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or("invalid")
        .to_string()
}

/// 合成一份 `AiRpcResponse` 形状的失败响应。
fn failure(request_id: String, error: WireError) -> Value {
    serde_json::json!({
        "requestId": request_id,
        "ok": false,
        "error": { "code": error.code, "message": error.message },
    })
}

/// AI RPC 调用（Provider / Model / 预算 / 远程配置 / 密钥环，共 32 个方法）。
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_invoke(
    manager: State<'_, Arc<SidecarManager>>,
    request: Value,
) -> Result<Value, String> {
    let request_id = request_id_of(&request);
    match manager
        .inner()
        .request(op::AI_INVOKE, request, AI_INVOKE_TIMEOUT)
        .await
    {
        Ok(value) => Ok(value),
        Err(error) => Ok(failure(request_id, error)),
    }
}

/// 开始一次流式生成。
///
/// 返回 `{accepted}`；分片经侧车事件总线（`op = "ai.stream"`）送达。
/// AI 栈不可用时返回 `accepted:false` **并且**由侧车推一条 `error` 事件 +
/// `done`：只回 `accepted:false` 会让界面永远转圈（这是最容易漏的一条）。
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_stream_start(
    manager: State<'_, Arc<SidecarManager>>,
    request: Value,
) -> Result<Value, String> {
    match manager
        .inner()
        .request(op::AI_STREAM_START, request, AI_INVOKE_TIMEOUT)
        .await
    {
        Ok(value) => Ok(value),
        Err(error) => Ok(serde_json::json!({
            "accepted": false,
            "error": { "code": error.code, "message": error.message },
        })),
    }
}

/// 取消一次流式生成（按 `requestId`）。
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_abort(
    manager: State<'_, Arc<SidecarManager>>,
    request_id: String,
) -> Result<(), String> {
    // 取消是尽力而为：侧车可能已经结束，或本来就没这次请求。
    // 这里**不抛出**失败——取消一个不存在的请求不该让 UI 弹错。
    let _ = manager
        .inner()
        .request(
            op::AI_ABORT,
            serde_json::json!({ "requestId": request_id }),
            Duration::from_secs(30),
        )
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_keeps_the_ai_rpc_response_shape() {
        let value = failure(
            "ai-1".to_string(),
            WireError::unsupported("未找到 Node 运行时"),
        );
        // 渲染层的适配器读的就是这个形状；少一个字段就会退化成"未知错误"
        assert_eq!(value["requestId"], "ai-1");
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "NOT_SUPPORTED");
        assert_eq!(value["error"]["message"], "未找到 Node 运行时");
        assert!(value.get("result").is_none(), "失败响应不该带 result");
    }

    #[test]
    fn request_id_falls_back_to_invalid_marker() {
        // 缺 requestId 的请求必须有一个确定值，否则渲染层无法把响应归给任何一次调用
        assert_eq!(request_id_of(&serde_json::json!({})), "invalid");
        assert_eq!(request_id_of(&serde_json::json!({ "requestId": 7 })), "invalid");
        assert_eq!(
            request_id_of(&serde_json::json!({ "requestId": "ai-9" })),
            "ai-9"
        );
    }
}
