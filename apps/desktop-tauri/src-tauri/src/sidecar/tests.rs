//! 侧车模块测试。
//!
//! 覆盖四类**只能在宿主侧守住**的东西：
//! 1. **路径安全** —— 侧车可执行文件的解析与校验（越界、`..`、入口名穿越、链接逃逸）；
//! 2. **升级兼容** —— 清单与握手的协议版本校验；
//! 3. **跨语言契约** —— op / capability / event 名与 TS 侧逐字一致；
//! 4. **活体握手**（有条件执行）—— 真的起一个侧车进程，跑完 hello→welcome→ready。
//!
//! 第 4 条只有在产物已构建且本机有 Node 时才执行；缺条件时**显式打印跳过原因**
//! 后返回，而不是伪装成通过 —— 一个永远绿的测试比没有测试更危险。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::protocol::{
    capability, event, op, AiAvailabilityWire, DomainDescriptorWire, SidecarManifest,
    PROTOCOL_VERSION, SIDECAR_RUNTIME_ID,
};
use super::*;

/* ------------------------------ 测试夹具 ------------------------------ */

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("ec-sidecar-rs-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    /// 写一份完整的侧车产物夹具
    fn write_sidecar(&self, protocol: u32, runtime: &str, entry_name: Option<&str>) -> PathBuf {
        let entry_file = entry_name.unwrap_or(SIDECAR_ENTRY_FILE);
        std::fs::write(self.0.join(entry_file), "// 夹具").expect("写入口");
        let manifest = serde_json::json!({
            "protocol": protocol,
            "runtime": runtime,
            "entry": entry_file,
            "hostCapabilities": ["secure.encrypt", "secure.decrypt"],
            "nodeMajor": 22,
            "migrations": "migrations",
        });
        std::fs::write(
            self.0.join(SIDECAR_MANIFEST_FILE),
            serde_json::to_string(&manifest).unwrap(),
        )
        .expect("写清单");
        self.0.join(entry_file)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/* ------------------------------ 路径安全 ------------------------------ */

#[test]
fn is_within_matches_components_not_string_prefixes() {
    let root = Path::new("C:\\root");
    assert!(is_within(root, Path::new("C:\\root")));
    assert!(is_within(root, Path::new("C:\\root\\child\\x.txt")));
    // 关键反例：字符串前缀会把 `C:\root-evil` 误判成在 `C:\root` 内
    assert!(!is_within(root, Path::new("C:\\root-evil")));
    assert!(!is_within(root, Path::new("C:\\other")));
    assert!(!is_within(root, Path::new("D:\\root")));
    // 大小写不敏感（Windows 语义）
    assert!(is_within(root, Path::new("c:\\ROOT\\Child")));
    // 反向不成立：root 不在 child 内
    assert!(!is_within(Path::new("C:\\root\\child"), root));
}

#[test]
fn validate_accepts_a_well_formed_sidecar_product() {
    let temp = TempDir::new("ok");
    temp.write_sidecar(PROTOCOL_VERSION, SIDECAR_RUNTIME_ID, None);
    let (manifest, entry) = validate_sidecar_dir(temp.path()).expect("合法产物必须通过校验");
    assert_eq!(manifest.protocol, PROTOCOL_VERSION);
    assert_eq!(entry.file_name().unwrap().to_string_lossy(), SIDECAR_ENTRY_FILE);
    assert!(entry.is_absolute(), "校验后必须给出规范化绝对路径");
}

#[test]
fn validate_rejects_directory_with_parent_traversal() {
    let temp = TempDir::new("parent-dir");
    temp.write_sidecar(PROTOCOL_VERSION, SIDECAR_RUNTIME_ID, None);
    let sneaky = temp.path().join("..").join("anything");
    let error = validate_sidecar_dir(&sneaky).expect_err("含 .. 的目录必须被拒");
    assert!(error.contains(".."), "错误应指出原因：{error}");
}

#[test]
fn validate_rejects_entry_name_traversal_from_manifest() {
    let temp = TempDir::new("entry-escape");
    // 清单是外部文件：它说入口在哪不算，必须由宿主复核
    temp.write_sidecar(PROTOCOL_VERSION, SIDECAR_RUNTIME_ID, Some("..\\evil.exe"));
    // 入口名含分隔符与 ..；即便文件存在也必须拒绝
    std::fs::write(temp.path().join("evil.exe"), "x").ok();
    let error = validate_sidecar_dir(temp.path()).expect_err("穿越型入口名必须被拒");
    assert!(
        error.contains("入口名") || error.contains("越出") || error.contains("不存在"),
        "错误应指出原因：{error}"
    );
}

#[test]
fn validate_rejects_foreign_runtime_and_protocol_mismatch() {
    let foreign = TempDir::new("foreign");
    foreign.write_sidecar(PROTOCOL_VERSION, "someone-elses-runtime", None);
    let error = validate_sidecar_dir(foreign.path()).expect_err("runtime 不匹配必须被拒");
    assert!(error.contains("runtime"), "错误应指出原因：{error}");

    let versioned = TempDir::new("version");
    versioned.write_sidecar(PROTOCOL_VERSION + 1, SIDECAR_RUNTIME_ID, None);
    let error = validate_sidecar_dir(versioned.path()).expect_err("协议不兼容必须被拒");
    assert!(
        error.contains("协议不兼容"),
        "错误应给出可操作指引：{error}"
    );
    assert!(
        error.contains("build:sidecar"),
        "错误应告诉用户怎么修：{error}"
    );
}

#[test]
fn validate_reports_missing_manifest_and_missing_entry() {
    let empty = TempDir::new("empty");
    let error = validate_sidecar_dir(empty.path()).expect_err("缺清单必须被拒");
    assert!(error.contains("读取侧车清单失败"), "错误应指出原因：{error}");

    let no_entry = TempDir::new("no-entry");
    std::fs::write(
        no_entry.path().join(SIDECAR_MANIFEST_FILE),
        serde_json::to_string(&serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "runtime": SIDECAR_RUNTIME_ID,
            "entry": SIDECAR_ENTRY_FILE,
        }))
        .unwrap(),
    )
    .unwrap();
    let error = validate_sidecar_dir(no_entry.path()).expect_err("缺入口必须被拒");
    assert!(error.contains("入口不存在"), "错误应指出原因：{error}");
}

#[test]
fn resolve_node_prefers_bundled_binary_over_path() {
    let temp = TempDir::new("node");
    std::fs::write(temp.path().join("node.exe"), "stub").expect("写 node 夹具");
    let node = resolve_node(temp.path()).expect("随包分发的 node 必须被采用");
    assert_eq!(node, temp.path().join("node.exe"));

    // 目录里没有 node.exe 时不应 panic：要么回退到 PATH，要么给出可操作指引
    let bare = TempDir::new("node-bare");
    match resolve_node(bare.path()) {
        Ok(found) => assert!(found.is_file(), "回退结果必须是真实文件"),
        Err(reason) => assert!(
            reason.contains("EC_SIDECAR_NODE"),
            "找不到时必须给出可操作的三种修法：{reason}"
        ),
    }
}

/* ------------------------------ 跨语言契约 ------------------------------ */

#[test]
fn protocol_names_match_the_typescript_side_verbatim() {
    // 逐个钉死。这些字符串任何一处写错，症状都是"实机启动后侧车不动"，
    // 而那种故障在单侧单测里看不出来。
    assert_eq!(capability::SECURE_ENCRYPT, "secure.encrypt");
    assert_eq!(capability::SECURE_DECRYPT, "secure.decrypt");
    assert_eq!(capability::SHELL_OPEN_EXTERNAL, "shell.openExternal");
    assert_eq!(capability::CLIPBOARD_WRITE_TEXT, "clipboard.writeText");
    assert_eq!(capability::SECURE_AVAILABLE, "secure.available");

    assert_eq!(op::PING, "ping");
    assert_eq!(op::DOMAIN_DESCRIBE, "domain.describe");
    assert_eq!(op::DOMAIN_INVOKE, "domain.invoke");
    assert_eq!(op::AI_INVOKE, "ai.invoke");
    assert_eq!(op::AI_STREAM_START, "ai.stream.start");
    assert_eq!(op::AI_ABORT, "ai.abort");
    assert_eq!(op::SHUTDOWN, "shutdown");

    assert_eq!(event::DOMAIN_EVENT, "domain.event");
    assert_eq!(event::AI_STREAM, "ai.stream");
    assert_eq!(event::LOG, "log");

    assert_eq!(SIDECAR_RUNTIME_ID, "everyone-coding-sidecar");
    assert_eq!(SIDECAR_ENTRY_FILE, "everyone-coding-sidecar.cjs");
    assert_eq!(SIDECAR_MANIFEST_FILE, "sidecar-manifest.json");
}

#[test]
fn manifest_rejects_entry_looking_like_an_absolute_path() {
    let temp = TempDir::new("abs-entry");
    std::fs::write(
        temp.path().join(SIDECAR_MANIFEST_FILE),
        serde_json::to_string(&serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "runtime": SIDECAR_RUNTIME_ID,
            "entry": "C:\\Windows\\System32\\cmd.exe",
        }))
        .unwrap(),
    )
    .unwrap();
    let error = validate_sidecar_dir(temp.path()).expect_err("绝对路径入口必须被拒");
    assert!(error.contains("入口名非法"), "错误应指出原因：{error}");
}

/* ------------------------------ base64 ------------------------------ */

#[test]
fn base64_round_trips_binary_payloads() {
    // DPAPI 密文是任意字节，必须能无损过管道
    let cases: Vec<Vec<u8>> = vec![
        Vec::new(),
        b"a".to_vec(),
        b"ab".to_vec(),
        b"abc".to_vec(),
        (0u8..=255).collect(),
    ];
    for original in cases {
        let encoded = encode_base64(&original);
        assert!(!encoded.contains('\n'), "base64 不得含换行");
        let decoded = decode_base64(&encoded).expect("自产 base64 必须可解");
        assert_eq!(decoded, original, "往返不一致：{encoded}");
    }
    // 与标准实现对齐（RFC 4648 测试向量）
    assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    assert_eq!(encode_base64(b"fo"), "Zm8=");
    assert_eq!(decode_base64("Zm9vYmFy").unwrap(), b"foobar".to_vec());
}

#[test]
fn base64_rejects_malformed_input_instead_of_guessing() {
    // 猜出来的字节会被当成密文送去解密，错误会被延后到"解不开"那一刻
    assert!(decode_base64("Zm9vYmF").is_none(), "长度非 4 的倍数应被拒");
    assert!(decode_base64("****").is_none(), "非法字符应被拒");
    assert!(decode_base64("=Zm8").is_none(), "填充出现在开头应被拒");
    assert!(decode_base64("Z=8=").is_none(), "填充位置非法应被拒");
}

/* ------------------------------ 活体握手（有条件执行） ------------------------------ */

/// 仓库里已构建的侧车产物目录（找得到才跑活体用例）。
fn built_sidecar_dir() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent()?.parent()?;
    let dir = repo_root
        .join("apps")
        .join("desktop-electron")
        .join("dist")
        .join("sidecar");
    if dir.join(SIDECAR_MANIFEST_FILE).is_file() {
        Some(dir)
    } else {
        None
    }
}

/// 真的起一个侧车进程，用 Rust 侧同一份协议跑完 hello → welcome → ready。
///
/// 这是**唯一**能证明"Rust 与 TS 两套协议实现真的对得上"的测试：
/// 其余用例都只验证单侧。
#[tokio::test]
async fn live_handshake_with_a_real_sidecar_process() {
    let Some(dir) = built_sidecar_dir() else {
        eprintln!(
            "[skip] 未找到侧车产物（apps/desktop-electron/dist/sidecar）；\
             先执行 pnpm --filter @ec/desktop-electron build:sidecar 再跑本用例"
        );
        return;
    };
    let Ok(node) = resolve_node(&dir) else {
        eprintln!("[skip] 本机没有可用的 Node 运行时，跳过侧车活体握手");
        return;
    };
    let (_manifest, entry) = validate_sidecar_dir(&dir).expect("产物应通过校验");

    let temp = TempDir::new("live");
    let mut child = tokio::process::Command::new(&node)
        .arg(&entry)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("侧车进程应能启动");

    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let mut lines = BufReader::new(stdout).lines();

    // 1) hello
    let hello_line = tokio::time::timeout(Duration::from_secs(30), lines.next_line())
        .await
        .expect("hello 超时")
        .expect("读 hello 失败")
        .expect("侧车未输出 hello");
    let hello = match serde_json::from_str::<Inbound>(&hello_line).expect("hello 应可解析") {
        Inbound::Hello(frame) => frame,
        other => panic!("首帧应是 hello，实际 {other:?}"),
    };
    assert!(
        is_protocol_compatible(PROTOCOL_VERSION, hello.protocol),
        "Rust 与 TS 的协议版本漂移了：sidecar={} host={PROTOCOL_VERSION}",
        hello.protocol
    );
    assert_eq!(hello.runtime, SIDECAR_RUNTIME_ID);

    // 2) welcome（secureStore=false：本用例不接宿主能力，验证的是降级路径）
    let welcome = WelcomeFrame::new(
        false,
        SidecarConfigWire {
            data_dir: temp.path().join("data").to_string_lossy().to_string(),
            cache_dir: temp.path().join("cache").to_string_lossy().to_string(),
            secure_dir: temp.path().join("secure").to_string_lossy().to_string(),
            workspace_root: temp.path().join("ws").to_string_lossy().to_string(),
            user_id: "local-user".to_string(),
            account_base_url: None,
        },
    );
    let mut payload = serde_json::to_string(&welcome).unwrap();
    payload.push('\n');
    stdin.write_all(payload.as_bytes()).await.expect("写 welcome");
    stdin.flush().await.expect("刷新 welcome");

    // 3) ready
    let ready_line = tokio::time::timeout(Duration::from_secs(90), lines.next_line())
        .await
        .expect("ready 超时（侧车装配卡住）")
        .expect("读 ready 失败")
        .expect("侧车未输出 ready");
    let ready: ReadyFrame = match serde_json::from_str::<Inbound>(&ready_line).expect("ready 应可解析")
    {
        Inbound::Ready(frame) => *frame,
        other => panic!("第二帧应是 ready，实际 {other:?}"),
    };

    assert_eq!(ready.protocol, PROTOCOL_VERSION);
    assert_eq!(ready.domains.len(), 15, "侧车应上报全部 15 个域");
    // DPAPI 由宿主提供，本例声明不可用 → auth 必须如实不可用并给出原因
    let auth = ready
        .domains
        .iter()
        .find(|item| item.kind == "auth")
        .expect("应包含 auth 域");
    assert!(!auth.available, "宿主未提供 DPAPI 时 auth 域不得谎报可用");
    assert!(auth.reason.is_some(), "不可用必须给出原因");
    assert!(!ready.ai.available, "无密钥环时 AI 栈不得谎报可用");
    // 四基础域里其余三个必须真的可用
    for kind in ["workspace", "docs", "settings"] {
        let entry = ready
            .domains
            .iter()
            .find(|item| item.kind == kind)
            .expect("应包含该域");
        assert!(entry.available, "{kind} 域应可用");
    }

    // 4) shutdown（走协议而不是直接 kill：验证优雅收尾路径）
    let mut stop = serde_json::to_string(&RequestFrame::new("t1", op::SHUTDOWN, Value::Null)).unwrap();
    stop.push('\n');
    stdin.write_all(stop.as_bytes()).await.expect("写 shutdown");
    stdin.flush().await.expect("刷新 shutdown");
    drop(stdin);

    let exit = tokio::time::timeout(Duration::from_secs(30), child.wait())
        .await
        .expect("侧车未按时退出")
        .expect("等待侧车退出失败");
    assert_eq!(exit.code(), Some(0), "协议关闭应以退出码 0 收尾");
}

#[test]
fn readiness_unavailable_helper_is_honest() {
    // 不可用时必须带原因，且 AI 的原因与整体原因一致（否则 UI 两条提示互相矛盾）
    let readiness = SidecarReadiness::unavailable("没有 Node 运行时");
    assert!(!readiness.available);
    assert_eq!(readiness.reason.as_deref(), Some("没有 Node 运行时"));
    assert_eq!(readiness.ai.reason.as_deref(), Some("没有 Node 运行时"));
    // 必须列出全部域并逐个带原因：渲染层靠它给每个页面如实的装配引导
    assert_eq!(readiness.domains.len(), 15);
    assert!(readiness
        .domains
        .iter()
        .all(|item| !item.available && item.reason.is_some()));
    assert_eq!(readiness.sync_domains, vec!["memory", "pipeline"]);
    assert!(serde_json::to_value(&readiness).unwrap()["available"] == Value::Bool(false));
}

#[test]
fn descriptor_wire_omits_absent_reason() {
    let descriptor = DomainDescriptorWire {
        kind: "workspace".into(),
        available: true,
        reason: None,
    };
    let json = serde_json::to_value(&descriptor).unwrap();
    assert_eq!(json["kind"], "workspace");
    assert_eq!(json["available"], true);
    assert!(json.get("reason").is_none(), "可用域不该带 reason 键");

    let manifest = SidecarManifest {
        protocol: PROTOCOL_VERSION,
        runtime: SIDECAR_RUNTIME_ID.into(),
        entry: SIDECAR_ENTRY_FILE.into(),
        host_capabilities: vec![capability::SECURE_ENCRYPT.into()],
        node_major: 22,
        migrations: Some("migrations".into()),
    };
    assert_eq!(manifest.node_major, 22);

    let ai = AiAvailabilityWire {
        available: false,
        reason: Some("无密钥环".into()),
    };
    let json = serde_json::to_value(&ai).unwrap();
    assert_eq!(json["available"], false);
    assert_eq!(json["reason"], "无密钥环");
}
