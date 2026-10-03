//! 窗口命令：标题、最小化/最大化、全屏、尺寸、居中、聚焦、关闭。
//!
//! 管理命令作用于调用它的 WebviewWindow；新 Agent 窗口继续共享应用级侧车。

use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::error::CommandError;

/// 窗口尺寸（与 TS `WindowSize` 对齐）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSizeWire {
    pub width: u32,
    pub height: u32,
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Create an independent OS webview. Its domain calls still reach the app's one
/// SidecarManager and therefore the D06/D07 persistent coordinator.
#[tauri::command(rename_all = "snake_case")]
pub fn window_open_agent(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    project_id: String,
    project_name: String,
    session_id: String,
    title: String,
) -> Result<(), CommandError> {
    for (name, value) in [("project_id", &project_id), ("project_name", &project_name), ("session_id", &session_id), ("title", &title)] {
        if value.is_empty() || value.len() > 256 {
            return Err(CommandError::invalid_argument(format!("{name} 必须为 1 至 256 个字符")));
        }
    }
    let sequence = state.window_seq.fetch_add(1, Ordering::SeqCst);
    let route = format!(
        "/agents?projectId={}&projectName={}&sessionId={}",
        percent_encode(&project_id),
        percent_encode(&project_name),
        percent_encode(&session_id),
    );
    let route_script = format!("window.location.hash = {};", serde_json::to_string(&route).unwrap_or_default());
    WebviewWindowBuilder::new(
        &app,
        &format!("agent-{sequence}"),
        WebviewUrl::App("index.html".into()),
    )
    .title(&title)
    .inner_size(1120.0, 760.0)
    .center()
    .initialization_script(&route_script)
    .build()
    .map(|_| ())
    .map_err(|error| CommandError::unknown(format!("创建 Agent 窗口失败：{error}")))
}

/// 设置窗口标题。
#[tauri::command(rename_all = "snake_case")]
pub fn window_set_title(window: WebviewWindow, title: String) -> Result<(), CommandError> {
    window
        .set_title(&title)
        .map_err(|e| CommandError::unknown(e.to_string()))
}

/// 最小化窗口。
#[tauri::command(rename_all = "snake_case")]
pub fn window_minimize(window: WebviewWindow) -> Result<(), CommandError> {
    window
        .minimize()
        .map_err(|e| CommandError::unknown(e.to_string()))
}

/// 最大化窗口。
#[tauri::command(rename_all = "snake_case")]
pub fn window_maximize(window: WebviewWindow) -> Result<(), CommandError> {
    window
        .maximize()
        .map_err(|e| CommandError::unknown(e.to_string()))
}

/// 取消最大化。
#[tauri::command(rename_all = "snake_case")]
pub fn window_unmaximize(window: WebviewWindow) -> Result<(), CommandError> {
    window
        .unmaximize()
        .map_err(|e| CommandError::unknown(e.to_string()))
}

/// 是否最大化。
#[tauri::command(rename_all = "snake_case")]
pub fn window_is_maximized(window: WebviewWindow) -> Result<bool, CommandError> {
    window
        .is_maximized()
        .map_err(|e| CommandError::unknown(e.to_string()))
}

/// 设置全屏状态。
#[tauri::command(rename_all = "snake_case")]
pub fn window_set_fullscreen(window: WebviewWindow, fullscreen: bool) -> Result<(), CommandError> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|e| CommandError::unknown(e.to_string()))
}

/// 是否全屏。
#[tauri::command(rename_all = "snake_case")]
pub fn window_is_fullscreen(window: WebviewWindow) -> Result<bool, CommandError> {
    window
        .is_fullscreen()
        .map_err(|e| CommandError::unknown(e.to_string()))
}

/// 设置窗口尺寸（物理像素）。
#[tauri::command(rename_all = "snake_case")]
pub fn window_set_size(window: WebviewWindow, width: u32, height: u32) -> Result<(), CommandError> {
    window
        .set_size(tauri::PhysicalSize::new(width, height))
        .map_err(|e| CommandError::unknown(e.to_string()))
}

/// 获取窗口尺寸。
#[tauri::command(rename_all = "snake_case")]
pub fn window_get_size(window: WebviewWindow) -> Result<WindowSizeWire, CommandError> {
    let size = window
        .inner_size()
        .map_err(|e| CommandError::unknown(e.to_string()))?;
    Ok(WindowSizeWire {
        width: size.width,
        height: size.height,
    })
}

/// 窗口居中。
#[tauri::command(rename_all = "snake_case")]
pub fn window_center(window: WebviewWindow) -> Result<(), CommandError> {
    window
        .center()
        .map_err(|e| CommandError::unknown(e.to_string()))
}

/// 聚焦窗口。
#[tauri::command(rename_all = "snake_case")]
pub fn window_focus(window: WebviewWindow) -> Result<(), CommandError> {
    window
        .set_focus()
        .map_err(|e| CommandError::unknown(e.to_string()))
}

/// 关闭窗口（应用退出）。
#[tauri::command(rename_all = "snake_case")]
pub fn window_close(window: WebviewWindow) -> Result<(), CommandError> {
    window
        .close()
        .map_err(|e| CommandError::unknown(e.to_string()))
}
