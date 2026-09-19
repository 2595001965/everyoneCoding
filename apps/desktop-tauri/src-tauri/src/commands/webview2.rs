//! WebView2 运行环境探测命令。
//!
//! 通过 Windows 注册表判断 WebView2 运行时是否已安装（EdgeUpdate 客户端键）。
//! 渲染层 `webview2-check.ts` 调用本命令，缺失时引导用户安装，避免白屏。

use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ,
};

/// 探测结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebView2Check {
    pub ok: bool,
    pub guide_url: String,
}

/// WebView2 运行时安装引导地址（Evergreen 独立安装包）。
const WEBVIEW2_GUIDE_URL: &str =
    "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

/// 检查注册表中是否存在 WebView2 客户端键。
fn registry_has_webview2() -> bool {
    for hkey in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let subkey = windows::core::HSTRING::from(
            "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8E18-1CDC1A920E41}",
        );
        let mut h = windows::Win32::System::Registry::HKEY::default();
        let res = unsafe {
            RegOpenKeyExW(hkey, PCWSTR::from(&subkey), 0, KEY_READ, &mut h)
        };
        if res.is_ok() {
            unsafe {
                let _ = RegCloseKey(h);
            }
            return true;
        }
    }
    false
}

/// 探测 WebView2 是否已就绪。
#[tauri::command]
pub fn webview2_check() -> WebView2Check {
    WebView2Check {
        ok: registry_has_webview2(),
        guide_url: WEBVIEW2_GUIDE_URL.to_string(),
    }
}
