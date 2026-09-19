//! 对话框命令：文件/目录选择、保存、消息、二次确认。
//!
//! 使用 `tauri-plugin-dialog` 的同步（blocking）API。命令声明为非异步函数，
//! Tauri 会在主线程执行，blocking 调用安全且不死锁异步运行时。

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::CommandError;

/// 打开文件选择对话框（可多选）。返回路径数组，取消时为 null。
#[tauri::command(rename_all = "snake_case")]
pub fn dialog_open_file(
    app: AppHandle,
    title: Option<String>,
    filters: Option<Vec<(String, String)>>,
    multiple: Option<bool>,
) -> Result<Option<Vec<String>>, CommandError> {
    let mut dlg = app.dialog().file();
    if let Some(t) = title {
        dlg = dlg.set_title(t);
    }
    if let Some(filters) = filters {
        for (name, exts) in filters {
            let ext_list: Vec<&str> = exts.split(',').collect();
            dlg = dlg.add_filter(name, &ext_list);
        }
    }
    let picked = if multiple.unwrap_or(false) {
        dlg.blocking_pick_files()
    } else {
        dlg.blocking_pick_file().map(|p| vec![p])
    };
    Ok(picked.map(|paths| {
        paths
            .iter()
            .filter_map(|p| p.clone().into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
            .collect()
    }))
}

/// 打开目录选择对话框。返回目录路径，取消时为 null。
#[tauri::command(rename_all = "snake_case")]
pub fn dialog_open_directory(
    app: AppHandle,
    title: Option<String>,
) -> Result<Option<String>, CommandError> {
    let mut dlg = app.dialog().file();
    if let Some(t) = title {
        dlg = dlg.set_title(t);
    }
    Ok(dlg
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

/// 打开保存文件对话框。返回目标路径，取消时为 null。
#[tauri::command(rename_all = "snake_case")]
pub fn dialog_save_file(
    app: AppHandle,
    title: Option<String>,
    filters: Option<Vec<(String, String)>>,
) -> Result<Option<String>, CommandError> {
    let mut dlg = app.dialog().file();
    if let Some(t) = title {
        dlg = dlg.set_title(t);
    }
    if let Some(filters) = filters {
        for (name, exts) in filters {
            let ext_list: Vec<&str> = exts.split(',').collect();
            dlg = dlg.add_filter(name, &ext_list);
        }
    }
    Ok(dlg
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

/// 弹出消息框。返回点击的按钮下标（本实现仅「确定」单按钮，故恒为 0）。
#[tauri::command(rename_all = "snake_case")]
pub fn dialog_show_message(
    app: AppHandle,
    title: String,
    message: String,
) -> Result<u32, CommandError> {
    app.dialog().message(message).title(title).blocking_show();
    Ok(0)
}

/// 语义化二次确认。返回用户是否确认。
#[tauri::command(rename_all = "snake_case")]
pub fn dialog_confirm(
    app: AppHandle,
    title: String,
    message: String,
) -> Result<bool, CommandError> {
    use tauri_plugin_dialog::MessageDialogButtons;
    Ok(app
        .dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show())
}
