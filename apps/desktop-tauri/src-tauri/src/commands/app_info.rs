//! 应用信息命令：形态、版本、平台、架构、数据目录、工作区根、语言、是否打包。
//!
//! 数据目录优先使用 Tauri 提供的 `app_data_dir`，回退到 `%APPDATA%\EveryoneCoding`。

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::CommandError;
use crate::state::AppState;

/// 应用信息（与 TS `AppInfo` 对齐）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfoWire {
    pub kind: String,
    pub name: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub data_dir: String,
    pub workspace_root: Option<String>,
    pub locale: String,
    pub is_packaged: bool,
}

/// 架构归一化：x86_64→x64，aarch64→arm64，x86→ia32，其余→unknown。
fn detect_arch() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        _ => "unknown",
    }
    .to_string()
}

/// 语言：优先取系统 locale。
fn detect_locale(app: &AppHandle) -> String {
    use tauri_plugin_os::OsExt;
    app.os().locale().unwrap_or_else(|| "en-US".to_string())
}

/// 取得数据目录。
fn data_dir(app: &AppHandle) -> Result<String, CommandError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(CommandError::io_error)
        .unwrap_or_else(|_| {
            let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
            std::path::PathBuf::from(base).join("EveryoneCoding")
        });
    // 确保目录存在，便于上层直接写入。
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.to_string_lossy().to_string())
}

/// 获取完整应用信息。
#[tauri::command(rename_all = "snake_case")]
pub fn app_info_get(app: AppHandle, state: State<'_, AppState>) -> Result<AppInfoWire, CommandError> {
    let data_dir = data_dir(&app)?;
    let workspace_root = state.workspace_root.lock().await.clone();
    Ok(AppInfoWire {
        kind: "tauri".to_string(),
        name: "EveryoneCoding".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: "windows".to_string(),
        arch: detect_arch(),
        data_dir,
        workspace_root,
        locale: detect_locale(&app),
        is_packaged: !cfg!(debug_assertions),
    })
}

/// 仅获取本地数据目录。
#[tauri::command(rename_all = "snake_case")]
pub fn app_info_get_data_dir(app: AppHandle) -> Result<String, CommandError> {
    data_dir(&app)
}

/// 设置当前工作区根目录。
#[tauri::command(rename_all = "snake_case")]
pub fn app_info_set_workspace_root(
    root: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    *state.workspace_root.lock().await = Some(root);
    Ok(())
}
