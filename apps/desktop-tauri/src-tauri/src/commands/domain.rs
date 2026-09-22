//! 领域端口命令：把侧车（Node 业务运行时）的域 RPC 接到渲染层。
//!
//! 与 Electron 形态的对应关系：
//!
//! | Electron | Tauri |
//! | --- | --- |
//! | `ipc/domain.ts` 的 `ec:domain:invoke` | `domain_invoke` |
//! | `host.describe()` | `domain_describe` |
//! | `host.events` 常驻订阅 | `sidecar_subscribe` / `sidecar_unsubscribe` |
//!
//! ## 契约纪律（与 Electron 一字不差）
//!
//! 1. **一定返回 `DomainRpcResponse` 形状**：`{requestId, ok, result?, error?}`。
//!    侧车不可用时**合成**一份 `ok:false` + 真实 `error.message` 的响应，
//!    而不是让 `invoke` 抛错 —— 渲染层的适配器读的是这个形状，
//!    抛错会让它走另一条（非预期）错误路径。
//! 2. **不做方法白名单的第二次维护**：白名单在 TS 的 `shell-api`（`isDomainRpcMethod`）
//!    与侧车的域运行时里各有一道，这里只做搬运。在 Rust 里再抄一份白名单，
//!    就是第三个会漂移的副本。
//! 3. **伪造成功是禁线**：任何失败都必须带上可读的原因（含"该装什么"）。

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use crate::sidecar::protocol::EventEnvelopeWire;
use crate::sidecar::{SidecarManager, SidecarReadiness};

/// 侧车诊断信息（设置页 / 排障用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatusWire {
    pub ready: SidecarReadiness,
    /// 侧车入口与 Node 运行时的位置；不可用时给出原因
    pub location: String,
    pub protocol: u32,
}

/// 发起一次域调用。
#[tauri::command(rename_all = "snake_case")]
pub async fn domain_invoke(
    manager: State<'_, Arc<SidecarManager>>,
    request: Value,
) -> Result<Value, String> {
    Ok(manager.inner().invoke_domain(request).await)
}

/// 各域装配状态。
///
/// 侧车不可用时返回**全部域 + 同一原因**（见 `SidecarReadiness::unavailable`）：
/// 渲染层据此决定不注入任何端口，并在对应页面显示为什么。
#[tauri::command(rename_all = "snake_case")]
pub async fn domain_describe(
    manager: State<'_, Arc<SidecarManager>>,
) -> Result<Vec<crate::sidecar::protocol::DomainDescriptorWire>, String> {
    Ok(manager.inner().describe().await.domains)
}

/// 侧车整体状态（能力协商 + 诊断）。
#[tauri::command(rename_all = "snake_case")]
pub async fn sidecar_status(manager: State<'_, Arc<SidecarManager>>) -> Result<SidecarStatusWire, String> {
    let ready = manager.inner().readiness().await;
    let location = manager
        .inner()
        .location_debug()
        .unwrap_or_else(|reason| format!("不可用：{reason}"));
    Ok(SidecarStatusWire {
        ready,
        location,
        protocol: crate::sidecar::protocol::PROTOCOL_VERSION,
    })
}

/// 订阅侧车事件（域事件 / AI 流式分片 / 日志）。
///
/// 返回订阅 id，渲染层在端口卸载时用 `sidecar_unsubscribe` 退订。
/// **必须退订**：订阅表有上限（`MAX_SUBSCRIBERS`），泄漏的订阅会让后续
/// 订阅全部失败 —— 那是"用久了才出现的怪问题"。
#[tauri::command(rename_all = "snake_case")]
pub async fn sidecar_subscribe(
    manager: State<'_, Arc<SidecarManager>>,
    channel: Channel<EventEnvelopeWire>,
) -> Result<String, String> {
    manager.inner().subscribe(channel).await
}

/// 退订侧车事件。
#[tauri::command(rename_all = "snake_case")]
pub async fn sidecar_unsubscribe(
    manager: State<'_, Arc<SidecarManager>>,
    sub_id: String,
) -> Result<(), String> {
    manager.inner().unsubscribe(&sub_id).await;
    Ok(())
}
