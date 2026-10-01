//! 自动更新命令（FR-SET-05）：检查、下载校验、安装重启、进度订阅。
//!
//! 基于 `tauri-plugin-updater`。端点与 minisign 公钥在 `tauri.conf.json` 的 `plugins.updater` 配置；
//! 运行时可用 `EC_UPDATE_URL` 覆盖端点（本地静态源演练 / 企业内网镜像），**公钥不可覆盖**——
//! 换了源也只能装我们私钥签过的包。
//!
//! 与 Electron 形态同一契约（`@ec/shell-api` 的 `UpdaterApi`）：
//! - `updater_download` 只下载 + minisign 验签，字节暂存在 `AppState.pending_update`；
//! - `updater_install_and_restart` 才交给 NSIS 安装器（Windows 上插件会 `exit(0)`，
//!   安装器以 `/P /R` 被动模式装完后重新拉起应用）。
//!
//! 拆两步的原因：渲染层的 `UpdateService` 必须在进程退出**之前**把"待确认"台账落盘，
//! 否则新版本启动即崩时无从回滚。
//!
//! 错误一律带 `UPDATE_<KIND>:` 前缀（与 `@ec/core` 的 `classifyUpdateError` 对齐）。

use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Url};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::error::CommandError;
use crate::sidecar::SidecarManager;
use crate::state::AppState;

/// 更新信息（与 TS `UpdateInfo` 对齐）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfoWire {
    pub version: String,
    pub notes: Option<String>,
    pub release_date: Option<String>,
}

/// 更新进度事件（经 channel 推送），与 TS `UpdateProgress` 对齐。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 已下载并通过验签、等待安装的更新包。
pub struct PendingUpdate {
    pub update: Update,
    pub bytes: Vec<u8>,
}

/// 插件错误 → `UPDATE_<KIND>: 原因`。
fn classify(error: &tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error as E;
    match error {
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => "SIGNATURE",
        E::InvalidUpdaterFormat | E::BinaryNotFoundInArchive => "INTEGRITY",
        E::EmptyEndpoints
        | E::InsecureTransportProtocol
        | E::TargetNotFound(_)
        | E::TargetsNotFound(_) => "NOT_CONFIGURED",
        E::Reqwest(inner) => {
            let text = inner.to_string().to_lowercase();
            if inner.is_connect() && (text.contains("dns") || text.contains("resolve")) {
                "OFFLINE"
            } else {
                "NETWORK"
            }
        }
        E::Network(_) | E::ReleaseNotFound => "NETWORK",
        _ => "UNKNOWN",
    }
}

fn tagged(stage: &str, error: tauri_plugin_updater::Error) -> CommandError {
    // reqwest 的 Display 只有一层，真正原因（连接被重置 / 报文不完整）在 source 链里
    let mut detail = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(inner) = source {
        detail.push_str(&format!(": {inner}"));
        source = inner.source();
    }
    CommandError::unknown(format!(
        "UPDATE_{}: {stage}失败: {detail}",
        classify(&error)
    ))
}

/// 构建更新器：`EC_UPDATE_URL` 存在时覆盖端点（插件仍按配置校验 https）。
fn build_updater(app: &AppHandle) -> Result<Updater, CommandError> {
    let mut builder = app.updater_builder();
    if let Ok(raw) = std::env::var("EC_UPDATE_URL") {
        let raw = raw.trim();
        if !raw.is_empty() {
            let url = Url::parse(raw).map_err(|e| {
                CommandError::unknown(format!(
                    "UPDATE_NOT_CONFIGURED: EC_UPDATE_URL 不是合法 URL: {e}"
                ))
            })?;
            builder = builder
                .endpoints(vec![url])
                .map_err(|e| tagged("配置更新源", e))?;
        }
    }
    builder.build().map_err(|e| tagged("初始化更新器", e))
}

fn wire(update: &Update) -> UpdateInfoWire {
    UpdateInfoWire {
        version: update.version.to_string(),
        notes: update.body.clone(),
        release_date: update.date.map(|d| {
            d.format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default()
        }),
    }
}

async fn check_update(app: &AppHandle) -> Result<Option<Update>, CommandError> {
    build_updater(app)?
        .check()
        .await
        .map_err(|e| tagged("检查更新", e))
}

/// 检查是否有可用更新。无可用更新返回 null。
#[tauri::command(rename_all = "snake_case")]
pub async fn updater_check(app: AppHandle) -> Result<Option<UpdateInfoWire>, CommandError> {
    Ok(check_update(&app).await?.as_ref().map(wire))
}

/// 下载更新包并 minisign 验签（不安装）。无可用更新返回 null。
#[tauri::command(rename_all = "snake_case")]
pub async fn updater_download(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<UpdateInfoWire>, CommandError> {
    broadcast(&state, "checking", None, None).await;
    let Some(update) = check_update(&app).await? else {
        return Ok(None);
    };
    broadcast(
        &state,
        "available",
        None,
        Some(format!("发现新版本 {}", update.version)),
    )
    .await;

    // 在 .await 之前快照订阅列表，供同步进度回调推送（回调内无法再次 .await state）。
    let subs = state.updater_subs.lock().await.clone();
    let mut received: u64 = 0;
    let mut last_percent: Option<u8> = None;
    let bytes = update
        .download(
            |chunk_len, content_len| {
                // 插件每次回调给的是**本块**长度，百分比要按累计量算
                received += chunk_len as u64;
                let percent = content_len
                    .filter(|total| *total > 0)
                    .map(|total| ((received as f64 / total as f64) * 100.0).min(100.0) as u8);
                if percent.is_some() && percent == last_percent {
                    return;
                }
                last_percent = percent;
                for ch in subs.values() {
                    let _ = ch.send(UpdateProgressEvent {
                        phase: "downloading".into(),
                        percent,
                        message: None,
                    });
                }
            },
            || {},
        )
        .await
        .map_err(|e| tagged("下载 / 验签", e))?;

    let info = wire(&update);
    *state.pending_update.lock().await = Some(PendingUpdate { update, bytes });
    broadcast(
        &state,
        "downloading",
        Some(100),
        Some(format!("{} 已下载并通过签名校验", info.version)),
    )
    .await;
    Ok(Some(info))
}

/// 安装已下载的更新并重启应用。Windows 上成功时本进程随即退出，不会返回。
#[tauri::command(rename_all = "snake_case")]
pub async fn updater_install_and_restart(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let pending = state.pending_update.lock().await.take().ok_or_else(|| {
        CommandError::unknown("UPDATE_INSTALL: 没有已下载并通过验签的更新".to_string())
    })?;
    broadcast(&state, "installing", Some(100), None).await;

    // 安装器接管前收尾侧车：插件在 Windows 上直接 exit(0)，不会走 RunEvent::Exit，
    // 侧车（及其子进程）会成为孤儿并占住安装目录里的文件，安装器替换会失败。
    //
    // 必须在这里 `.await`，**不能**放进插件的 `on_before_exit` 钩子里 `block_on`：钩子在本命令的
    // 异步上下文里同步调用，`block_on` 会 panic（runtime 内不能再起 runtime）。实测后果更隐蔽：
    // panic 让 IPC 自定义协议请求断开，Tauri 前端随即改走 postMessage **把同一命令重发一遍**，
    // 第二次拿不到待装包，界面只看到"没有已下载的更新"。
    // 代价：安装器若没能拉起，侧车已停，域能力要等重启应用才恢复（界面如实报安装失败）。
    if let Some(manager) = app.try_state::<Arc<SidecarManager>>() {
        manager.inner().clone().shutdown().await;
    }

    // install() 同步阻塞（写临时文件 + ShellExecute + exit），放到阻塞线程里跑，不占异步 worker
    tauri::async_runtime::spawn_blocking(move || pending.update.install(&pending.bytes))
        .await
        .map_err(|e| CommandError::unknown(format!("UPDATE_INSTALL: 安装线程异常: {e}")))?
        .map_err(|e| CommandError::unknown(format!("UPDATE_INSTALL: 安装器启动失败: {e}")))?;
    // 非 Windows 平台插件不退出进程：由调用方自行重启
    Ok(())
}

/// 兼容旧调用方：下载校验 + 安装重启。
#[tauri::command(rename_all = "snake_case")]
pub async fn updater_download_and_install(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    if updater_download(app.clone(), state.clone())
        .await?
        .is_some()
    {
        updater_install_and_restart(app, state).await?;
    }
    Ok(())
}

/// 订阅更新进度。返回订阅 id，供 `updater_unsubscribe` 取消。
#[tauri::command(rename_all = "snake_case")]
pub async fn updater_subscribe(
    channel: Channel<UpdateProgressEvent>,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    let id = format!(
        "sub-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    state.updater_subs.lock().await.insert(id.clone(), channel);
    Ok(id)
}

/// 取消更新进度订阅。
#[tauri::command(rename_all = "snake_case")]
pub async fn updater_unsubscribe(
    sub_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    state.updater_subs.lock().await.remove(&sub_id);
    Ok(())
}

/// 向所有订阅推送一条进度事件。
async fn broadcast(
    state: &State<'_, AppState>,
    phase: &str,
    percent: Option<u8>,
    message: Option<String>,
) {
    let subs = state.updater_subs.lock().await.clone();
    for ch in subs.values() {
        let _ = ch.send(UpdateProgressEvent {
            phase: phase.to_string(),
            percent,
            message: message.clone(),
        });
    }
}
