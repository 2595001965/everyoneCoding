//! 路径工具（Rust 侧，纯计算，仅被其它命令内部复用，不注册为 Tauri 命令）。
//!
//! 注意：`PathApi` 的同步实现位于 TS 桥接层（`bridge.ts`），因为渲染层要求路径能力同步返回。
//! 本文件的职责是提供跨平台的路径规范化与越界检测，供 `fs` 等命令做安全校验。

/// 按分隔符拆分路径，忽略空段。同时兼容 `\` 与 `/`。
pub fn split(p: &str) -> Vec<String> {
    p.split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// 规范化路径：统一分隔符、折叠多余分隔符、去掉尾部分隔符。
pub fn normalize(p: &str) -> String {
    let raw = p.replace('\\', "/");
    let mut out: Vec<String> = Vec::new();
    for seg in raw.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            out.pop();
        } else {
            out.push(seg.to_string());
        }
    }
    let joined = out.join("/");
    if raw.starts_with('/') || raw.starts_with("//") {
        format!("/{joined}")
    } else if let Some(rest) = raw.strip_prefix("//") {
        format!("//{rest}")
    } else {
        joined
    }
}

/// 是否为绝对路径（Windows 盘符 / UNC / 类 Unix 根）。
pub fn is_absolute(p: &str) -> bool {
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return true;
    }
    p.starts_with("//") || p.starts_with('/') || p.starts_with("\\\\")
}

/// 判断 child 是否位于 parent 目录之内（含自身）。
pub fn is_within(parent: &str, child: &str) -> bool {
    let p = normalize(parent);
    let c = normalize(child);
    if c == p {
        return true;
    }
    if p.is_empty() {
        return true;
    }
    c == format!("{p}/") || c.starts_with(&format!("{p}/"))
}
