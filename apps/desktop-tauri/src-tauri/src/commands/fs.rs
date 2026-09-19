//! 文件系统命令：文本/二进制读写、原子写、stat、readdir、mkdir、remove、copy、rename、exists、watch。
//!
//! 原子写是核心能力：`writeAtomic` 必须走「临时文件 → fsync → rename 覆盖」，保证进程崩溃时不留半截文件。
//! 文件监听（watch）通过独立轮询线程 + Tauri channel 推送事件实现（轻量、无额外 crate 依赖）。

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::CommandError;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// 返回值结构（camelCase 与 TS 对齐）
// ---------------------------------------------------------------------------

/// `fs_stat` 返回值，对应 TS `FsStat`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    pub path: String,
    pub size: u64,
    pub is_file: bool,
    pub is_directory: bool,
    pub mtime_ms: i64,
    pub ctime_ms: i64,
    pub readonly: bool,
}

/// `fs_readdir` 返回值，对应 TS `FsDirent`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsDirent {
    pub name: String,
    pub path: String,
    pub is_file: bool,
    pub is_directory: bool,
}

/// watch 事件（通过 channel 推送），对应 TS `FsWatchEvent`。
#[derive(Debug, Clone, Serialize)]
pub struct FsWatchEventWire {
    #[serde(rename = "type")]
    pub event_type: String,
    pub path: String,
}

/// watch 句柄：停止标志 + 线程句柄，供 `fs_unwatch` 终止轮询。
pub struct WatcherHandle {
    pub stop: std::sync::Arc<AtomicBool>,
    pub handle: Option<thread::JoinHandle<()>>,
}

impl WatcherHandle {
    /// 请求停止并回收线程。
    pub fn close(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/// 把 `std::fs` 的 `Metadata` 转换为 `FsStat`。
fn metadata_to_stat(path: &Path, meta: &fs::Metadata) -> FsStat {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let ctime = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(mtime);
    FsStat {
        path: path.to_string_lossy().to_string(),
        size: meta.len(),
        is_file: meta.is_file(),
        is_directory: meta.is_dir(),
        mtime_ms: mtime,
        ctime_ms: ctime,
        readonly: meta.permissions().readonly(),
    }
}

/// 计算原子写用的临时文件路径（与目标同目录、同名加 `.tmp` 后缀）。
fn temp_path_for(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file.tmp".to_string());
    target.with_file_name(format!("{name}.tmp"))
}

/// 原子写：写临时文件 → fsync → rename 覆盖。
fn atomic_write(target: &Path, data: &[u8], create_backup: bool) -> Result<(), CommandError> {
    if target.is_dir() {
        return Err(CommandError::invalid_argument(
            "目标是目录，不能写入文件（请使用 writeAtomic 写入文件路径）",
        ));
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    if create_backup && target.exists() {
        let bak = target.with_file_name(format!(
            "{}.bak",
            target.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()
        ));
        fs::copy(target, &bak)?;
    }
    let tmp = temp_path_for(target);
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        CommandError::io_error(format!("rename 覆盖失败: {e}"))
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 读取文本文件。encoding 仅影响返回（当前统一按 UTF-8 返回字符串）。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_read_text(path: String, encoding: Option<String>) -> Result<String, CommandError> {
    let _ = encoding; // 二进制/编码细节在桥接层处理，Rust 侧统一 UTF-8。
    let mut buf = String::new();
    let mut file = File::open(&path)?;
    file.read_to_string(&mut buf)?;
    Ok(buf)
}

/// 读取二进制文件，返回字节数组（JSON 中序列化为数字数组）。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_read_binary(path: String) -> Result<Vec<u8>, CommandError> {
    let mut buf = Vec::new();
    let mut file = File::open(&path)?;
    file.read_to_end(&mut buf)?;
    Ok(buf)
}

/// 原子写：写入字符串或二进制数据。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_write_atomic(
    path: String,
    data: Vec<u8>,
    create_backup: Option<bool>,
) -> Result<(), CommandError> {
    atomic_write(Path::new(&path), &data, create_backup.unwrap_or(false))
}

/// 获取文件/目录元信息；不存在返回 null。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_stat(path: String) -> Result<Option<FsStat>, CommandError> {
    let p = Path::new(&path);
    match fs::metadata(p) {
        Ok(meta) => Ok(Some(metadata_to_stat(p, &meta))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CommandError::from(e)),
    }
}

/// 列出目录内容。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_readdir(path: String) -> Result<Vec<FsDirent>, CommandError> {
    let p = Path::new(&path);
    let mut out = Vec::new();
    for entry in fs::read_dir(p)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        let name = entry.file_name().to_string_lossy().to_string();
        out.push(FsDirent {
            name: name.clone(),
            path: entry.path().to_string_lossy().to_string(),
            is_file: meta.is_file(),
            is_directory: meta.is_dir(),
        });
    }
    Ok(out)
}

/// 创建目录。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_mkdir(path: String, recursive: Option<bool>) -> Result<(), CommandError> {
    let p = Path::new(&path);
    if *recursive.get_or_insert(true) {
        fs::create_dir_all(p)?;
    } else {
        fs::create_dir(p)?;
    }
    Ok(())
}

/// 删除文件或目录。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_remove(path: String, recursive: Option<bool>) -> Result<(), CommandError> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        if recursive.unwrap_or(false) {
            fs::remove_dir_all(p)?;
        } else {
            fs::remove_dir(p)?;
        }
    } else {
        fs::remove_file(p)?;
    }
    Ok(())
}

/// 复制文件。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_copy(source: String, target: String) -> Result<(), CommandError> {
    let src = Path::new(&source);
    let dst = Path::new(&target);
    if let Some(parent) = dst.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::copy(src, dst)?;
    Ok(())
}

/// 重命名/移动文件或目录。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_rename(source: String, target: String) -> Result<(), CommandError> {
    fs::rename(Path::new(&source), Path::new(&target))?;
    Ok(())
}

/// 判断路径是否存在。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_exists(path: String) -> Result<bool, CommandError> {
    Ok(Path::new(&path).exists())
}

/// 监听路径变更（文件或目录），通过 channel 推送 create/modify/remove 事件。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_watch(
    path: String,
    channel: Channel<FsWatchEventWire>,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    let id = state.next_watcher_id();
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();

    let handle = thread::spawn(move || {
        let target = Path::new(&path).to_path_buf();
        let mut last_snapshot: Option<(bool, std::collections::HashMap<String, i64>)> = None;
        while !stop_clone.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(400));
            if stop_clone.load(Ordering::SeqCst) {
                break;
            }
            let meta = fs::metadata(&target);
            match meta {
                Ok(m) if m.is_file() => {
                    let mtime = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    match &last_snapshot {
                        None => {
                            let _ = channel.send(FsWatchEventWire {
                                event_type: "create".into(),
                                path: target.to_string_lossy().to_string(),
                            });
                            last_snapshot =
                                Some((true, std::collections::HashMap::from([(path.clone(), mtime)])));
                        }
                        Some((_, map)) => {
                            let prev = map.get(&path).copied().unwrap_or(mtime);
                            if prev != mtime {
                                let _ = channel.send(FsWatchEventWire {
                                    event_type: "modify".into(),
                                    path: target.to_string_lossy().to_string(),
                                });
                                last_snapshot = Some((
                                    true,
                                    std::collections::HashMap::from([(path.clone(), mtime)]),
                                ));
                            }
                        }
                    }
                }
                Ok(m) if m.is_dir() => {
                    let mut current = std::collections::HashMap::new();
                    let mut events = Vec::new();
                    if let Ok(rd) = fs::read_dir(&target) {
                        for e in rd.flatten() {
                            if let Ok(em) = e.metadata() {
                                let mt = em
                                    .modified()
                                    .ok()
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_millis() as i64)
                                    .unwrap_or(0);
                                current.insert(e.path().to_string_lossy().to_string(), mt);
                            }
                        }
                    }
                    match &last_snapshot {
                        None => {
                            for p in current.keys() {
                                events.push(("create".into(), p.clone()));
                            }
                        }
                        Some((_, prev)) => {
                            for (p, mt) in &current {
                                match prev.get(p) {
                                    None => events.push(("create".into(), p.clone())),
                                    Some(old) if old != mt => events.push(("modify".into(), p.clone())),
                                    _ => {}
                                }
                            }
                            for p in prev.keys() {
                                if !current.contains_key(p) {
                                    events.push(("remove".into(), p.clone()));
                                }
                            }
                        }
                    }
                    for (t, p) in events {
                        let _ = channel.send(FsWatchEventWire { event_type: t, path: p });
                    }
                    last_snapshot = Some((false, current));
                }
                _ => {
                    // 目标消失
                    if last_snapshot.is_some() {
                        let _ = channel.send(FsWatchEventWire {
                            event_type: "remove".into(),
                            path: target.to_string_lossy().to_string(),
                        });
                        last_snapshot = None;
                    }
                }
            }
        }
    });

    state
        .watchers
        .blocking_lock()
        .insert(
            id.clone(),
            WatcherHandle {
                stop,
                handle: Some(handle),
            },
        );
    Ok(id)
}

/// 停止监听并释放线程。
#[tauri::command(rename_all = "snake_case")]
pub fn fs_unwatch(id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    if let Some(mut h) = state.watchers.blocking_lock().remove(&id) {
        h.close();
    }
    Ok(())
}
