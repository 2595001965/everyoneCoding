//! Rust 侧统一错误类型。
//!
//! 所有命令返回 `Result<T, CommandError>`。序列化形态为 `{ "code": string, "message": string }`，
//! 与 `packages/shell-api` 的 `ShellErrorCode` 一一对应，TS 桥接层据此还原为 `ShellError`。

use serde::Serialize;

/// 与 TS `ShellErrorCode` 对齐的错误码常量。
pub mod code {
    pub const NOT_FOUND: &str = "NOT_FOUND";
    pub const ALREADY_EXISTS: &str = "ALREADY_EXISTS";
    pub const PERMISSION_DENIED: &str = "PERMISSION_DENIED";
    pub const INVALID_ARGUMENT: &str = "INVALID_ARGUMENT";
    pub const PATH_ESCAPE: &str = "PATH_ESCAPE";
    pub const IO_ERROR: &str = "IO_ERROR";
    pub const TIMEOUT: &str = "TIMEOUT";
    pub const CANCELLED: &str = "CANCELLED";
    pub const DECRYPT_FAILED: &str = "DECRYPT_FAILED";
    pub const ENCRYPT_FAILED: &str = "ENCRYPT_FAILED";
    pub const PROCESS_SPAWN_FAILED: &str = "PROCESS_SPAWN_FAILED";
    pub const PROCESS_KILLED: &str = "PROCESS_KILLED";
    pub const NET_BLOCKED: &str = "NET_BLOCKED";
    pub const NET_ERROR: &str = "NET_ERROR";
    pub const NOT_SUPPORTED: &str = "NOT_SUPPORTED";
    pub const UNKNOWN: &str = "UNKNOWN";
}

/// 命令错误：序列化为 `{ code, message }`，TS 桥接层还原为 `ShellError`。
#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    /// 通用构造器。
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(code::NOT_FOUND, message)
    }
    pub fn already_exists(message: impl Into<String>) -> Self {
        Self::new(code::ALREADY_EXISTS, message)
    }
    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self::new(code::PERMISSION_DENIED, message)
    }
    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(code::INVALID_ARGUMENT, message)
    }
    pub fn path_escape(message: impl Into<String>) -> Self {
        Self::new(code::PATH_ESCAPE, message)
    }
    pub fn io_error(message: impl Into<String>) -> Self {
        Self::new(code::IO_ERROR, message)
    }
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(code::TIMEOUT, message)
    }
    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(code::CANCELLED, message)
    }
    pub fn decrypt_failed(message: impl Into<String>) -> Self {
        Self::new(code::DECRYPT_FAILED, message)
    }
    pub fn encrypt_failed(message: impl Into<String>) -> Self {
        Self::new(code::ENCRYPT_FAILED, message)
    }
    pub fn process_spawn_failed(message: impl Into<String>) -> Self {
        Self::new(code::PROCESS_SPAWN_FAILED, message)
    }
    pub fn process_killed(message: impl Into<String>) -> Self {
        Self::new(code::PROCESS_KILLED, message)
    }
    pub fn net_blocked(message: impl Into<String>) -> Self {
        Self::new(code::NET_BLOCKED, message)
    }
    pub fn net_error(message: impl Into<String>) -> Self {
        Self::new(code::NET_ERROR, message)
    }
    pub fn not_supported(message: impl Into<String>) -> Self {
        Self::new(code::NOT_SUPPORTED, message)
    }
    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(code::UNKNOWN, message)
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

/// 把 `std::io::Error` 规整为命令错误。
/// ENOENT 系列 → NOT_FOUND；EACCES/EPERM → PERMISSION_DENIED；EEXIST → ALREADY_EXISTS。
impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => CommandError::not_found(e.to_string()),
            std::io::ErrorKind::PermissionDenied => CommandError::permission_denied(e.to_string()),
            std::io::ErrorKind::AlreadyExists => CommandError::already_exists(e.to_string()),
            std::io::ErrorKind::TimedOut => CommandError::timeout(e.to_string()),
            _ => CommandError::io_error(e.to_string()),
        }
    }
}

/// 把任意错误（如 reqwest、插件错误）规整为命令错误。
pub fn to_command_error(e: impl std::fmt::Display) -> CommandError {
    CommandError::unknown(e.to_string())
}
