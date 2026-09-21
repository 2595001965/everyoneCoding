//! 进程内共享状态：子进程表、网络白名单、工作区根、更新订阅、文件监听句柄。
//!
//! 使用 `tokio::sync::Mutex` 以允许在异步命令中 `.await`；计数器等无锁结构用 atomic。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::Mutex;
use tauri::ipc::Channel;

use crate::commands::fs::WatcherHandle;
use crate::commands::net::AllowedHosts;
use crate::commands::process::RunningProcess;
use crate::commands::updater::UpdateProgressEvent;

/// 全局共享状态，由 Tauri 注入（`tauri::State`）。
pub struct AppState {
    /// 子进程 id 自增序列。
    pub process_seq: AtomicU64,
    /// 运行中的子进程表（key = 进程 id）。
    pub processes: Mutex<HashMap<String, RunningProcess>>,
    /// 受限网络允许的 host 白名单。
    pub allowed_hosts: Mutex<AllowedHosts>,
    /// 当前工作区根目录（未设置时为 None）。
    pub workspace_root: Mutex<Option<String>>,
    /// 更新进度订阅（key = 订阅 id）。
    pub updater_subs: Mutex<HashMap<String, Channel<UpdateProgressEvent>>>,
    /// 文件监听句柄表（key = 监听 id）。
    pub watchers: Mutex<HashMap<String, WatcherHandle>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            process_seq: AtomicU64::new(1),
            processes: Mutex::new(HashMap::new()),
            allowed_hosts: Mutex::new(AllowedHosts::default()),
            workspace_root: Mutex::new(None),
            updater_subs: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

impl AppState {
    /// 分配下一个进程 id。
    pub fn next_process_id(&self) -> String {
        let n = self.process_seq.fetch_add(1, Ordering::SeqCst) + 1;
        format!("proc-{n}")
    }

    /// 分配下一个监听 id。
    pub fn next_watcher_id(&self) -> String {
        let n = self.process_seq.fetch_add(1, Ordering::SeqCst) + 1;
        format!("watch-{n}")
    }
}
