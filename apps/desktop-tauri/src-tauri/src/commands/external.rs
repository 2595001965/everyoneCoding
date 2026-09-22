//! 外部链接打开命令：使用系统默认程序（浏览器/邮件客户端）打开 URL。

use std::process::Command;

use crate::error::CommandError;

/// 仅放行 `http(s)://` 与 `mailto:` —— 其余 scheme 一律拒绝。
///
/// 抽成独立函数的原因：侧车的宿主能力（`shell.openExternal`）与渲染层直连的
/// 命令必须**同一套校验**。侧车那边收到的是 Node 侧请求，若各写一份白名单，
/// 迟早出现"命令被拦、侧车能开"的越权缝隙。
fn assert_safe_scheme(url: &str) -> Result<(), CommandError> {
    let allowed = url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("mailto:");
    if !allowed {
        return Err(CommandError::invalid_argument(
            "openExternal 仅支持 http/https/mailto 链接",
        ));
    }
    Ok(())
}

/// 用系统默认程序打开 URL（校验后调用）。
pub(crate) fn open_external_url(url: &str) -> Result<(), CommandError> {
    assert_safe_scheme(url)?;
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map_err(|e| CommandError::io_error(e.to_string()))?;
    Ok(())
}

/// 使用系统默认程序打开外部 URL（如浏览器）。
///
/// 仅放行 `http(s)://` 与 `mailto:` 等安全 scheme，避免 cmd 注入。
#[tauri::command(rename_all = "snake_case")]
pub fn open_external(url: String) -> Result<(), CommandError> {
    open_external_url(&url)
}
