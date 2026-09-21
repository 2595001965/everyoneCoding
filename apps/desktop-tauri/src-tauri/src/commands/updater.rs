//! 自动更新命令：检查更新、下载并安装、进度订阅。
//!
//! 基于 `tauri-plugin-updater`。更新端点与公钥在 `tauri.conf.json` 中配置（占位，需替换）。

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

use crate::error::CommandError;
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

/// 检查是否有可用更新。无可用更新返回 null。
#[tauri::command(rename_all = "snake_case")]
pub async fn updater_check(app: AppHandle) -> Result<Option<UpdateInfoWire>, CommandError> {
    let updater = app
        .updater()
        .map_err(|e| CommandError::unknown(format!("updater 初始化失败: {e}")))?;
    let update = updater
        .check()
        .await
        .map_err(|e| CommandError::unknown(format!("check 失败: {e}")))?;
    match update {
        Some(u) => Ok(Some(UpdateInfoWire {
            version: u.version.to_string(),
            notes: u.body,
            release_date: u.date.map(|d| {
                d.format(&time::format_description::well_known::Rfc3339)
                    .unwrap_or_default()
            }),
        })),
        None => Ok(None),
    }
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

/// 检查、下载并安装更新。进度通过已订阅的 channel 推送。
#[tauri::command(rename_all = "snake_case")]
pub async fn updater_download_and_install(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let updater = app
        .updater()
        .map_err(|e| CommandError::unknown(format!("updater 初始化失败: {e}")))?;
    let update = updater
        .check()
        .await
        .map_err(|e| CommandError::unknown(format!("check 失败: {e}")))?;

    let update = match update {
        Some(u) => u,
        None => return Ok(()),
    };

    // 推送 available
    broadcast(
        &state,
        UpdateProgressEvent {
            phase: "available".into(),
            percent: None,
            message: Some(format!("发现新版本 {}", update.version)),
        },
    )
    .await;

    // 在 .await 之前快照订阅列表，供同步进度回调推送（回调内无法再次 .await state）。
    let subs = state.updater_subs.lock().await.clone();

    update
        .download_and_install(
            {
                let subs = subs.clone();
                move |chunk_len, content_len| {
                    let percent = content_len.map(|c| {
                        if c == 0 {
                            0u8
                        } else {
                            ((chunk_len as f64 / c as f64) * 100.0).min(100.0) as u8
                        }
                    });
                    for ch in subs.values() {
                        let _ = ch.send(UpdateProgressEvent {
                            phase: "downloading".into(),
                            percent,
                            message: None,
                        });
                    }
                }
            },
            {
                let subs = subs.clone();
                move || {
                    for ch in subs.values() {
                        let _ = ch.send(UpdateProgressEvent {
                            phase: "installing".into(),
                            percent: Some(100),
                            message: None,
                        });
                    }
                }
            },
        )
        .await
        .map_err(|e| CommandError::unknown(format!("下载/安装失败: {e}")))?;

    // 推送 done
    for ch in subs.values() {
        let _ = ch.send(UpdateProgressEvent {
            phase: "done".into(),
            percent: Some(100),
            message: None,
        });
    }
    Ok(())
}

/// 向所有订阅推送一条进度事件。
async fn broadcast(state: &State<'_, AppState>, event: UpdateProgressEvent) {
    let subs = state.updater_subs.lock().await.clone();
    for ch in subs.values() {
        let _ = ch.send(event.clone());
    }
}
