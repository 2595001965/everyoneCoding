//! 安全存储命令：基于 Windows DPAPI（CryptProtectData / CryptUnprotectData）的密钥保管。
//!
//! 数据按命名空间落盘到 `%APPDATA%\EveryoneCoding\secure\<ns>.dat`，文件内为
//! `key -> 密文(Vec<u8>)` 的 JSON 映射。按当前用户上下文加密（不使用 LOCAL_MACHINE 标志），
//! 因此切换 Windows 用户或数据损坏时解密会失败（对应 DECRYPT_FAILED）。

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::CommandError;
use crate::state::AppState;

/// 密钥命名空间（与 TS `SecureNamespace` 对齐）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecureNamespace {
    AiKey,
    OAuthToken,
    GitCredential,
    AppSecret,
}

impl SecureNamespace {
    /// 命名空间对应的文件名（不含扩展名）。
    pub fn file_name(&self) -> &'static str {
        match self {
            SecureNamespace::AiKey => "ai-key",
            SecureNamespace::OAuthToken => "oauth-token",
            SecureNamespace::GitCredential => "git-credential",
            SecureNamespace::AppSecret => "app-secret",
        }
    }
}

/// 串行化安全存储文件读写，避免并发写丢失。
static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn store_lock() -> &'static Mutex<()> {
    STORE_LOCK.get_or_init(|| Mutex::new(()))
}

/// 安全存储目录：`%APPDATA%\EveryoneCoding\secure`。
fn store_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("EveryoneCoding").join("secure")
}

/// 命名空间对应的数据文件路径。
fn store_file(ns: SecureNamespace) -> PathBuf {
    store_dir().join(format!("{}.dat", ns.file_name()))
}

/// DPAPI 加密（当前用户上下文）。
fn dpapi_encrypt(plain: &[u8]) -> Result<Vec<u8>, CommandError> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let res = unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };
    if let Err(e) = res {
        return Err(CommandError::encrypt_failed(e.to_string()));
    }
    let slice = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) };
    let result = slice.to_vec();
    unsafe {
        let _ = LocalFree(HLOCAL(out.pbData as *mut core::ffi::c_void));
    }
    Ok(result)
}

/// DPAPI 解密（当前用户上下文）。
fn dpapi_decrypt(cipher: &[u8]) -> Result<Vec<u8>, CommandError> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let res = unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };
    if let Err(e) = res {
        return Err(CommandError::decrypt_failed(e.to_string()));
    }
    let slice = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) };
    let result = slice.to_vec();
    unsafe {
        let _ = LocalFree(HLOCAL(out.pbData as *mut core::ffi::c_void));
    }
    Ok(result)
}

/// 读取命名空间下的全部 key→密文 映射。
fn load_map(ns: SecureNamespace) -> HashMap<String, Vec<u8>> {
    let path = store_file(ns);
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// 把 serde_json / io 错误统一规整为命令错误（带上下文前缀）。
fn store_io_error(what: &str) -> impl Fn(std::io::Error) -> CommandError + '_ {
    move |e| CommandError::io_error(format!("{what}: {e}"))
}

/// 持久化 key→密文 映射（临时文件 + 重命名，避免半截写入）。
fn save_map(ns: SecureNamespace, map: &HashMap<String, Vec<u8>>) -> Result<(), CommandError> {
    let path = store_file(ns);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(store_io_error("创建安全存储目录失败"))?;
    }
    let tmp = path.with_file_name(format!("{}.tmp", ns.file_name()));
    {
        let json = serde_json::to_vec(map)
            .map_err(|e| CommandError::encrypt_failed(format!("序列化安全存储失败: {e}")))?;
        let mut f = fs::File::create(&tmp).map_err(store_io_error("创建临时文件失败"))?;
        f.write_all(&json).map_err(store_io_error("写入临时文件失败"))?;
        f.sync_all().map_err(store_io_error("刷盘失败"))?;
    }
    fs::rename(&tmp, &path).map_err(store_io_error("替换安全存储文件失败"))?;
    Ok(())
}

/// 写入密钥。
#[tauri::command(rename_all = "snake_case")]
pub fn secure_store_set(
    namespace: SecureNamespace,
    key: String,
    value: String,
    _state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let _guard = store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut map = load_map(namespace);
    let cipher = dpapi_encrypt(value.as_bytes())?;
    map.insert(key, cipher);
    save_map(namespace, &map)
}

/// 读取密钥，不存在返回 null。
#[tauri::command(rename_all = "snake_case")]
pub fn secure_store_get(
    namespace: SecureNamespace,
    key: String,
    _state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    let _guard = store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let map = load_map(namespace);
    match map.get(&key) {
        Some(cipher) => {
            let plain = dpapi_decrypt(cipher)?;
            String::from_utf8(plain)
                .map(Some)
                .map_err(|e| CommandError::decrypt_failed(e.to_string()))
        }
        None => Ok(None),
    }
}

/// 删除密钥。
#[tauri::command(rename_all = "snake_case")]
pub fn secure_store_delete(
    namespace: SecureNamespace,
    key: String,
    _state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let _guard = store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut map = load_map(namespace);
    map.remove(&key);
    save_map(namespace, &map)
}

/// 判断密钥是否存在。
#[tauri::command(rename_all = "snake_case")]
pub fn secure_store_has(
    namespace: SecureNamespace,
    key: String,
    _state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let _guard = store_lock().lock().unwrap_or_else(|e| e.into_inner());
    Ok(load_map(namespace).contains_key(&key))
}

/// 列出命名空间下全部 key（不含值）。
#[tauri::command(rename_all = "snake_case")]
pub fn secure_store_list_keys(
    namespace: SecureNamespace,
    _state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    let _guard = store_lock().lock().unwrap_or_else(|e| e.into_inner());
    Ok(load_map(namespace).into_keys().collect())
}
