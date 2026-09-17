//! 窗口命令：标题、最小化/最大化、全屏、尺寸、居中、聚焦、关闭。
//!
//! 通过 `AppHandle::get_webview_window("main")` 取得主窗口，调用其同步方法。
//! 命令声明为同步函数，由 Tauri 在主线程执行。

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::CommandError;

/// 窗口尺寸（与 TS `WindowSize` 对齐）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSizeWire {
    pub width: u32,
    pub height: u32,
}

/// 取得主窗口（label = "main"）。
fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, CommandError> {
    app.get_webview_window("main")
        .ok_or_else(|| CommandError::not_found("主窗口未找到（label=main）"))
}

/// 设置窗口标题。
#[tauri::command(rename_all = "snake_case")]
pub fn window_set_title(app: AppHandle, title: String) -> Result<(), CommandError> {
    main_window(&app)?.set_title(&title).map_err(CommandError::io_error)
}

/// 最小化窗口。
#[tauri::command(rename_all = "snake_case")]
pub fn window_minimize(app: AppHandle) -> Result<(), CommandError> {
    main_window(&app)?.minimize().map_err(CommandError::io_error)
}

/// 最大化窗口。
#[tauri::command(rename_all = "snake_case")]
pub fn window_maximize(app: AppHandle) -> Result<(), CommandError> {
    main_window(&app)?.maximize().map_err(CommandError::io_error)
}

/// 取消最大化。
#[tauri::command(rename_all = "snake_case")]
pub fn window_unmaximize(app: AppHandle) -> Result<(), CommandError> {
    main_window(&app)?.unmaximize().map_err(CommandError::io_error)
}

/// 是否最大化。
#[tauri::command(rename_all = "snake_case")]
pub fn window_is_maximized(app: AppHandle) -> Result<bool, CommandError> {
    main_window(&app)?.is_maximized().map_err(CommandError::io_error)
}

/// 设置全屏状态。
#[tauri::command(rename_all = "snake_case")]
pub fn window_set_fullscreen(app: AppHandle, fullscreen: bool) -> Result<(), CommandError> {
    main_window(&app)?
        .set_fullscreen(fullscreen)
        .map_err(CommandError::io_error)
}

/// 是否全屏。
#[tauri::command(rename_all = "snake_case")]
pub fn window_is_fullscreen(app: AppHandle) -> Result<bool, CommandError> {
    main_window(&app)?.is_fullscreen().map_err(CommandError::io_error)
}

/// 设置窗口尺寸（物理像素）。
#[tauri::command(rename_all = "snake_case")]
pub fn window_set_size(app: AppHandle, width: u32, height: u32) -> Result<(), CommandError> {
    main_window(&app)?
        .set_size(tauri::PhysicalSize::new(width, height))
        .map_err(CommandError::io_error)
}

/// 获取窗口尺寸。
#[tauri::command(rename_all = "snake_case")]
pub fn window_get_size(app: AppHandle) -> Result<WindowSizeWire, CommandError> {
    let size = main_window(&app)?.inner_size().map_err(CommandError::io_error)?;
    Ok(WindowSizeWire {
        width: size.width,
        height: size.height,
    })
}

/// 窗口居中。
#[tauri::command(rename_all = "snake_case")]
pub fn window_center(app: AppHandle) -> Result<(), CommandError> {
    main_window(&app)?.center().map_err(CommandError::io_error)
}

/// 聚焦窗口。
#[tauri::command(rename_all = "snake_case")]
pub fn window_focus(app: AppHandle) -> Result<(), CommandError> {
    main_window(&app)?.set_focus().map_err(CommandError::io_error)
}

/// 关闭窗口（应用退出）。
#[tauri::command(rename_all = "snake_case")]
pub fn window_close(app: AppHandle) -> Result<(), CommandError> {
    main_window(&app)?.close().map_err(CommandError::io_error)
}
