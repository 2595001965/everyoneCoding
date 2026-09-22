//! 命令模块汇总。
//!
//! 注意：`path` 为纯计算能力，其同步实现在 TS 桥接层（`bridge.ts`），故此处不注册 path 命令；
//! 但 `path.rs` 提供的规范化/越界检测被 `fs` 等命令内部复用。

pub mod ai;
pub mod app_info;
pub mod clipboard;
pub mod dialog;
pub mod domain;
pub mod external;
pub mod fs;
pub mod net;
pub mod process;
pub mod secure_store;
pub mod updater;
pub mod webview2;
pub mod window;

// path 仅提供内部工具函数，不对外暴露命令。
pub mod path;
