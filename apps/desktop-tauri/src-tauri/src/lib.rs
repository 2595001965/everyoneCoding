//! EveryoneCoding Tauri 2 外壳入口。
//!
//! 职责：装配插件、注册全部 Rust 命令、注入共享状态、管理侧车生命周期。
//! 所有命令命名与 `packages/shell-api` 的 `ShellHost` 方法一一对应（蛇形命名）。
//!
//! ## 双形态功能等价（D-01）是怎么落地的
//!
//! Tauri 外壳是 Rust + 系统 WebView2，**没有 Node 运行时**；而本仓库的业务逻辑
//! （15 个域 + AI 栈 + `@ec/*` 领域内核）全部是 Node 侧 TS。因此业务运行时经
//! **受控侧车**承载（见 `sidecar` 模块注释）：
//!
//! ```text
//! 渲染层 ──► Tauri 桥接层 ──► 本文件的命令 ──► SidecarManager ──NDJSON──► Node 侧车
//! ```
//!
//! Rust 只做生命周期、协议搬运与宿主能力（DPAPI / 外链 / 剪贴板）。
//! 这样"两版功能等价"不是靠两份实现对齐，而是**真的只有一份实现**。

pub mod commands;
pub mod error;
pub mod sidecar;
pub mod state;

use std::sync::Arc;

use tauri::Manager;

use sidecar::protocol::SidecarConfigWire;
use sidecar::SidecarManager;
use state::AppState;

/// 组装侧车启动配置。
///
/// 目录布局与 Electron 形态**逐字对齐**（`<userData>/data|cache|secure|workspace`）：
/// 双形态各自的 `userData` 根不同（Tauri 用 `app_data_dir`，Electron 用 `app.getPath`），
/// 但根之下的结构一致，用户的备份/迁移脚本不必区分形态。
fn build_sidecar_config(app: &tauri::AppHandle) -> SidecarConfigWire {
    let base = app.path().app_data_dir().unwrap_or_else(|_| {
        let fallback = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
        std::path::PathBuf::from(fallback).join("EveryoneCoding")
    });
    SidecarConfigWire {
        data_dir: base.join("data").to_string_lossy().to_string(),
        cache_dir: base.join("cache").to_string_lossy().to_string(),
        secure_dir: base.join("secure").to_string_lossy().to_string(),
        workspace_root: base.join("workspace").to_string_lossy().to_string(),
        user_id: "local-user".to_string(),
        // 与 Electron 形态同一口径：账号服务基址缺省为本机自建服务
        account_base_url: std::env::var("EC_ACCOUNT_BASE_URL").ok(),
    }
}

/// 应用入口。被 `main.rs` 与（将来的）移动端包装共同调用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let manager = SidecarManager::new(handle, build_sidecar_config(app.handle()));
            // 后台预热：侧车装配要跑 SQLite 迁移并初始化 AI 栈，放在窗口出现之后再等
            // 用户去点第一个按钮，体验是"界面卡了一下"。预热失败不改启动结果 ——
            // 能力协商会在 `capabilities()` / `domain.describe()` 里如实上报。
            let warm = manager.clone();
            tauri::async_runtime::spawn(async move {
                let _ = warm.ensure_ready().await;
            });
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 文件系统
            commands::fs::fs_read_text,
            commands::fs::fs_read_binary,
            commands::fs::fs_write_atomic,
            commands::fs::fs_stat,
            commands::fs::fs_readdir,
            commands::fs::fs_mkdir,
            commands::fs::fs_remove,
            commands::fs::fs_copy,
            commands::fs::fs_rename,
            commands::fs::fs_exists,
            commands::fs::fs_watch,
            commands::fs::fs_unwatch,
            // 对话框
            commands::dialog::dialog_open_file,
            commands::dialog::dialog_open_directory,
            commands::dialog::dialog_save_file,
            commands::dialog::dialog_show_message,
            commands::dialog::dialog_confirm,
            // 进程
            commands::process::process_spawn,
            commands::process::process_write,
            commands::process::process_kill,
            commands::process::process_list,
            commands::process::process_kill_all,
            // 安全存储
            commands::secure_store::secure_store_set,
            commands::secure_store::secure_store_get,
            commands::secure_store::secure_store_delete,
            commands::secure_store::secure_store_has,
            commands::secure_store::secure_store_list_keys,
            // 窗口
            commands::window::window_set_title,
            commands::window::window_minimize,
            commands::window::window_maximize,
            commands::window::window_unmaximize,
            commands::window::window_is_maximized,
            commands::window::window_set_fullscreen,
            commands::window::window_is_fullscreen,
            commands::window::window_set_size,
            commands::window::window_get_size,
            commands::window::window_center,
            commands::window::window_focus,
            commands::window::window_close,
            // 更新
            commands::updater::updater_check,
            commands::updater::updater_download_and_install,
            commands::updater::updater_subscribe,
            commands::updater::updater_unsubscribe,
            // 应用信息
            commands::app_info::app_info_get,
            commands::app_info::app_info_get_data_dir,
            commands::app_info::app_info_set_workspace_root,
            // 剪贴板
            commands::clipboard::clipboard_read_text,
            commands::clipboard::clipboard_write_text,
            commands::clipboard::clipboard_clear,
            // 受限网络
            commands::net::net_set_allowed_hosts,
            commands::net::net_is_host_allowed,
            commands::net::net_fetch,
            // 领域端口（经侧车承载真实业务运行时）
            commands::domain::domain_invoke,
            commands::domain::domain_describe,
            commands::domain::sidecar_status,
            commands::domain::sidecar_subscribe,
            commands::domain::sidecar_unsubscribe,
            // AI 控制（同上，走侧车里的真实 AI 栈）
            commands::ai::ai_invoke,
            commands::ai::ai_stream_start,
            commands::ai::ai_abort,
            // 外部链接
            commands::external::open_external,
            // 运行环境探测
            commands::webview2::webview2_check,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("Tauri 应用启动失败");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            // 退出前**必须**收尾侧车：它自己 spawn 的预览后端（`npm run dev` 之类）
            // 会变成孤儿进程，占住端口与工程目录；SQLite 的 WAL 锁也会留在那里，
            // 用户看到的现象是"下次启动报数据目录被占用"。
            if let Some(manager) = handle.try_state::<Arc<SidecarManager>>() {
                let manager = manager.inner().clone();
                tauri::async_runtime::block_on(async move {
                    manager.shutdown().await;
                });
            }
        }
    });
}
