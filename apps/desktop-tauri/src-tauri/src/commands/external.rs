//! 外部链接打开命令：使用系统默认程序（浏览器/邮件客户端）打开 URL。

use std::process::Command;

use crate::error::CommandError;

/// 使用系统默认程序打开外部 URL（如浏览器）。
///
/// 仅放行 `http(s)://` 与 `mailto:` 等安全 scheme，避免 cmd 注入。
#[tauri::command(rename_all = "snake_case")]
pub fn open_external(url: String) -> Result<(), CommandError> {
    let allowed = url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("mailto:");
    if !allowed {
        return Err(CommandError::invalid_argument(
            "openExternal 仅支持 http/https/mailto 链接",
        ));
    }
    Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map_err(CommandError::io_error)?;
    Ok(())
}
