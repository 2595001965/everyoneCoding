//! EveryoneCoding Tauri 2 外壳入口。
//!
//! 职责：装配插件、注册全部 Rust 命令、注入共享状态。
//! 所有命令命名与 `packages/shell-api` 的 `ShellHost` 方法一一对应（蛇形命名）。

pub mod commands;
pub mod error;
pub mod state;

use state::AppState;

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
            // AI 控制（Rust 栈未接入时显式降级）
            commands::ai::ai_invoke,
            commands::ai::ai_stream_start,
            commands::ai::ai_abort,
            // 外部链接
            commands::external::open_external,
            // 运行环境探测
            commands::webview2::webview2_check,
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
