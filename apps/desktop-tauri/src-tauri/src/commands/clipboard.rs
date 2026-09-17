//! 剪贴板命令：读文本、写文本、清空。
//!
//! 使用 `tauri-plugin-clipboard-manager` 提供的 `ClipboardExt`。

use tauri::{AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::error::CommandError;
use crate::state::AppState;

/// 读取剪贴板文本。
#[tauri::command(rename_all = "snake_case")]
pub fn clipboard_read_text(app: AppHandle) -> Result<String, CommandError> {
    app.clipboard()
        .read_text()
        .map_err(|e| CommandError::io_error(format!("读取剪贴板失败: {e}")))
}

/// 写入剪贴板文本。
#[tauri::command(rename_all = "snake_case")]
pub fn clipboard_write_text(app: AppHandle, text: String) -> Result<(), CommandError> {
    app.clipboard()
        .write_text(text)
        .map_err(|e| CommandError::io_error(format!("写入剪贴板失败: {e}")))
}

/// 清空剪贴板。
#[tauri::command(rename_all = "snake_case")]
pub fn clipboard_clear(app: AppHandle, _state: State<'_, AppState>) -> Result<(), CommandError> {
    app.clipboard()
        .clear()
        .map_err(|e| CommandError::io_error(format!("清空剪贴板失败: {e}")))
}
