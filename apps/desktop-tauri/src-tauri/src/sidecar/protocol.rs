//! 侧车协议（Rust 侧）：帧定义、序列化与兼容判定。
//!
//! 与 TS 侧 `apps/desktop-electron/src/sidecar/protocol.ts` **成对维护**：
//! 字段名、判别值、op 名称、能力名必须逐字一致。
//! 本模块的单元测试直接对**真实 JSON 文本**做序列化/反序列化断言 ——
//! 这样任何一侧改了字段名都会在 `cargo test` 阶段就红，
//! 而不是等到实机启动时表现为"侧车收到 welcome 之后一直不动"。
//!
//! 为什么字段名是 camelCase：帧载荷直接就是渲染层契约里的 `DomainRpcRequest`
//! 等对象（可结构化克隆的 JSON），中间再套一层 snake_case 转换只会制造第三种命名。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 协议主版本。宿主与侧车必须一致，否则拒绝服务（不做"尽力而为"的一半协议）。
pub const PROTOCOL_VERSION: u32 = 1;

/// 侧车运行时标识（与 TS `SIDECAR_RUNTIME_ID` 一致）
pub const SIDECAR_RUNTIME_ID: &str = "everyone-coding-sidecar";

/// 全部域端口（与 TS `DOMAIN_KINDS` 逐字一致，顺序也一致）。
///
/// 为什么宿主也要有一份：`describe()` 在侧车不可用时要**列出全部 15 个域并逐个给出
/// 同一原因**，渲染层才能对每个页面给出如实的装配引导。返回空数组会让页面
/// 停在"什么都没有"的状态，比"明确告诉你为什么不可用"更差。
pub const DOMAIN_KINDS: [&str; 15] = [
    "workspace",
    "docs",
    "auth",
    "settings",
    "memory",
    "pipeline",
    "git",
    "preview",
    "rename",
    "package",
    "usage",
    "ai-context",
    "code",
    "nav",
    "designer",
];

/// 在 Electron 形态下有**同步签名端口**、而 Tauri 形态不暴露的域。
///
/// Tauri 的渲染层没有同步 IPC 原语（`invoke` 只有异步形态）。用异步往返假装同步会
/// 读到上一拍的数据，属于伪造，因此如实不暴露；本常量用于把原因写进能力矩阵与 UI 引导。
pub const SYNC_PORT_DOMAINS: [&str; 2] = ["memory", "pipeline"];

/// 宿主必须实现的能力名（与 TS `HOST_CAPABILITIES` 一致）
pub mod capability {
    /// 用宿主侧 DPAPI 加密（返回 `{ cipherBase64 }`）
    pub const SECURE_ENCRYPT: &str = "secure.encrypt";
    /// 用宿主侧 DPAPI 解密（返回 `{ plainText }`）
    pub const SECURE_DECRYPT: &str = "secure.decrypt";
    /// 系统浏览器打开链接
    pub const SHELL_OPEN_EXTERNAL: &str = "shell.openExternal";
    /// 写系统剪贴板
    pub const CLIPBOARD_WRITE_TEXT: &str = "clipboard.writeText";
    /// 查询 DPAPI 可用性（仅诊断用；装配期用的是 `welcome.secureStore`）
    pub const SECURE_AVAILABLE: &str = "secure.available";
}

/// 侧车事件信封（侧车 → 宿主 → 渲染层）。
///
/// 用一个信封承载全部事件（域事件 / AI 流式分片 / 日志），由桥接层按 `op` 分流：
/// 三种事件在时序上互相纠缠（同一次调用的进度与结果），分通道会出现
/// "事件先到、订阅还没建立"的竞态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventEnvelopeWire {
    /// 见 `event` 模块的常量
    pub op: String,
    /// 事件载荷，形状由 `op` 决定（域事件为 `DomainEvent`，AI 分片为 `{requestId, event}`）
    pub payload: Value,
}

impl EventEnvelopeWire {
    pub fn new(op: &str, payload: Value) -> Self {
        Self {
            op: op.to_string(),
            payload,
        }
    }
}

/// 侧车请求的 op 名（与 TS `SIDECAR_OPS` 一致）
pub mod op {
    pub const PING: &str = "ping";
    pub const DOMAIN_DESCRIBE: &str = "domain.describe";
    pub const DOMAIN_INVOKE: &str = "domain.invoke";
    pub const AI_INVOKE: &str = "ai.invoke";
    pub const AI_STREAM_START: &str = "ai.stream.start";
    pub const AI_ABORT: &str = "ai.abort";
    pub const SHUTDOWN: &str = "shutdown";
}

/// 侧车事件名（与 TS `SIDECAR_EVENTS` 一致）
pub mod event {
    pub const DOMAIN_EVENT: &str = "domain.event";
    pub const AI_STREAM: &str = "ai.stream";
    pub const LOG: &str = "log";
}

/// 可跨帧传递的错误（与 TS `WireError` 一致）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireError {
    pub code: String,
    pub message: String,
    /// 是否可重试（渲染层的 `DomainRpcError.retryable` 直接消费它）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

impl WireError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable: None,
        }
    }

    /// 不可重试的错误（配置缺失 / 能力不支持：重试一万次结果一样）
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: "NOT_SUPPORTED".to_string(),
            message: message.into(),
            retryable: Some(false),
        }
    }
}

/// 单个域的可用性（与 TS `WireDomainDescriptor` 一致）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainDescriptorWire {
    pub kind: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// AI 栈可用性（`ready` 帧携带）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiAvailabilityWire {
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 侧车启动配置（宿主 → 侧车，`welcome` 帧）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarConfigWire {
    pub data_dir: String,
    pub cache_dir: String,
    pub secure_dir: String,
    pub workspace_root: String,
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_base_url: Option<String>,
}

/* ------------------------------ 宿主 → 侧车 ------------------------------ */

/// `welcome` 帧：协商结果 + 宿主能提供的能力 + 运行时配置
#[derive(Debug, Clone, Serialize)]
pub struct WelcomeFrame {
    pub t: &'static str,
    pub protocol: u32,
    /// 宿主侧 DPAPI（Windows 用户上下文）是否可用。
    /// 为 false 时侧车**不得**装配 auth 域或把 AI Key 落盘（宁可不可用，不可落明文）。
    #[serde(rename = "secureStore")]
    pub secure_store: bool,
    pub config: SidecarConfigWire,
}

impl WelcomeFrame {
    pub fn new(secure_store: bool, config: SidecarConfigWire) -> Self {
        Self {
            t: "welcome",
            protocol: PROTOCOL_VERSION,
            secure_store,
            config,
        }
    }
}

/// `req` 帧：一次调用
#[derive(Debug, Clone, Serialize)]
pub struct RequestFrame<'a> {
    pub t: &'static str,
    pub id: &'a str,
    pub op: &'a str,
    pub payload: serde_json::Value,
}

impl<'a> RequestFrame<'a> {
    pub fn new(id: &'a str, op: &'a str, payload: serde_json::Value) -> Self {
        Self {
            t: "req",
            id,
            op,
            payload,
        }
    }
}

/// `hostres` 帧：宿主能力调用应答
#[derive(Debug, Clone, Serialize)]
pub struct HostResultFrame {
    pub t: &'static str,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<WireError>,
}

impl HostResultFrame {
    pub fn ok(id: String, result: Option<Value>) -> Self {
        Self {
            t: "hostres",
            id,
            ok: true,
            result,
            error: None,
        }
    }

    pub fn failed(id: String, error: WireError) -> Self {
        Self {
            t: "hostres",
            id,
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

/* ------------------------------ 侧车 → 宿主 ------------------------------ */

/// `hello` 帧：侧车自报协议版本与运行时信息
#[derive(Debug, Clone, Deserialize)]
pub struct HelloFrame {
    pub protocol: u32,
    #[serde(default)]
    pub runtime: String,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub features: Vec<String>,
}

/// `ready` 帧：运行时装配完毕
#[derive(Debug, Clone, Deserialize)]
pub struct ReadyFrame {
    pub protocol: u32,
    #[serde(default)]
    pub domains: Vec<DomainDescriptorWire>,
    #[serde(default, rename = "syncDomains")]
    pub sync_domains: Vec<String>,
    pub ai: AiAvailabilityWire,
}

/// `bye` 帧：侧车终止
#[derive(Debug, Clone, Deserialize)]
pub struct ByeFrame {
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub code: i32,
}

/// 入站帧总表。
///
/// 用**内部标签枚举**而不是"一个大 struct + 到处 Option"：判别字段 `t` 由 serde
/// 直接做分发，漏处理某个帧类型会在 `match` 上暴露成编译期穷尽性错误。
/// 未知帧（将来的宿主/侧车组合）落进 `Unknown` 并被忽略 —— 加字段是向后兼容的，
/// 而崩在未知帧上不是。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t")]
pub enum Inbound {
    #[serde(rename = "hello")]
    Hello(HelloFrame),
    #[serde(rename = "ready")]
    Ready(Box<ReadyFrame>),
    #[serde(rename = "res")]
    Res {
        id: String,
        ok: bool,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error: Option<WireError>,
    },
    #[serde(rename = "evt")]
    Evt { op: String, payload: Value },
    #[serde(rename = "host")]
    Host {
        id: String,
        capability: String,
        payload: Value,
    },
    #[serde(rename = "bye")]
    Bye(ByeFrame),
    #[serde(other)]
    Unknown,
}

/// 协议兼容判定：主版本必须完全相等。
///
/// **不提供"尽力而为"的降级**：半懂的协议会把"方法缺失"表现成随机业务错误，
/// 排障成本远高于直接拒绝启动。
pub fn is_protocol_compatible(host: u32, sidecar: u32) -> bool {
    host == sidecar
}

/// 侧车产物清单（`sidecar-manifest.json`，由 `scripts/build-sidecar.mjs` 生成）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarManifest {
    pub protocol: u32,
    #[serde(default)]
    pub runtime: String,
    #[serde(default)]
    pub entry: String,
    #[serde(default)]
    pub host_capabilities: Vec<String>,
    #[serde(default)]
    pub node_major: u32,
    #[serde(default)]
    pub migrations: Option<String>,
}

/// 解析清单；内容非法时返回带原因的错误字符串。
pub fn parse_manifest(text: &str) -> Result<SidecarManifest, String> {
    serde_json::from_str::<SidecarManifest>(text)
        .map_err(|e| format!("侧车清单不是合法 JSON：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn welcome_frame_uses_camel_case_keys_expected_by_sidecar() {
        let frame = WelcomeFrame::new(
            true,
            SidecarConfigWire {
                data_dir: "C:/data".into(),
                cache_dir: "C:/cache".into(),
                secure_dir: "C:/secure".into(),
                workspace_root: "C:/ws".into(),
                user_id: "local-user".into(),
                account_base_url: None,
            },
        );
        let json = serde_json::to_value(&frame).expect("welcome 必须可序列化");
        assert_eq!(json["t"], "welcome");
        assert_eq!(json["protocol"], PROTOCOL_VERSION);
        // 侧车读的是 `secureStore`；写成 secure_store 会让它永远认为 DPAPI 不可用
        assert_eq!(json["secureStore"], true);
        assert!(json.get("secure_store").is_none());
        assert_eq!(json["config"]["dataDir"], "C:/data");
        assert_eq!(json["config"]["workspaceRoot"], "C:/ws");
        assert_eq!(json["config"]["userId"], "local-user");
        // 未配置时不出现该键（缺省 vs null 对侧车是两种输入）
        assert!(json["config"].get("accountBaseUrl").is_none());
    }

    #[test]
    fn welcome_includes_account_base_url_when_configured() {
        let frame = WelcomeFrame::new(
            false,
            SidecarConfigWire {
                data_dir: "/d".into(),
                cache_dir: "/c".into(),
                secure_dir: "/s".into(),
                workspace_root: "/w".into(),
                user_id: "u".into(),
                account_base_url: Some("http://127.0.0.1:3000".into()),
            },
        );
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["config"]["accountBaseUrl"], "http://127.0.0.1:3000");
        assert_eq!(json["secureStore"], false);
    }

    #[test]
    fn request_and_host_result_frames_match_protocol() {
        let request = RequestFrame::new(
            "h1",
            op::DOMAIN_INVOKE,
            serde_json::json!({ "requestId": "r1", "domain": "workspace" }),
        );
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["t"], "req");
        assert_eq!(json["op"], "domain.invoke");
        assert_eq!(json["payload"]["requestId"], "r1");

        let ok = serde_json::to_value(HostResultFrame::ok("host-1".into(), Some(serde_json::json!({"cipherBase64": "AA=="})))).unwrap();
        assert_eq!(ok["t"], "hostres");
        assert_eq!(ok["ok"], true);
        assert!(ok.get("error").is_none());

        let failed = serde_json::to_value(HostResultFrame::failed(
            "host-2".into(),
            WireError::new("ENCRYPT_FAILED", "DPAPI 不可用"),
        ))
        .unwrap();
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["error"]["code"], "ENCRYPT_FAILED");
        assert!(failed.get("result").is_none());
    }

    #[test]
    fn inbound_parses_real_sidecar_frames() {
        // 逐字取自 TS 侧实际会写出的形状（含 camelCase 字段）
        let hello = serde_json::from_str::<Inbound>(
            r#"{"t":"hello","protocol":1,"minProtocol":1,"runtime":"everyone-coding-sidecar","pid":42,"node":"24.20.0","features":["domain.rpc"]}"#,
        )
        .expect("hello 必须可解析");
        match hello {
            Inbound::Hello(frame) => {
                assert_eq!(frame.protocol, 1);
                assert_eq!(frame.pid, 42);
                assert_eq!(frame.runtime, SIDECAR_RUNTIME_ID);
            }
            other => panic!("应解析为 Hello，实际 {other:?}"),
        }

        let ready = serde_json::from_str::<Inbound>(
            r#"{"t":"ready","protocol":1,"domains":[{"kind":"workspace","available":true},{"kind":"auth","available":false,"reason":"DPAPI 不可用"}],"syncDomains":["memory","pipeline"],"ai":{"available":false,"reason":"无密钥环"}}"#,
        )
        .expect("ready 必须可解析");
        match ready {
            Inbound::Ready(frame) => {
                assert_eq!(frame.domains.len(), 2);
                assert!(!frame.domains[1].available);
                assert_eq!(frame.sync_domains, vec!["memory", "pipeline"]);
                assert!(!frame.ai.available);
                assert_eq!(frame.ai.reason.as_deref(), Some("无密钥环"));
            }
            other => panic!("应解析为 Ready，实际 {other:?}"),
        }

        let res = serde_json::from_str::<Inbound>(
            r#"{"t":"res","id":"h1","ok":false,"error":{"code":"INVALID_ARGUMENT","message":"未知方法"}}"#,
        )
        .expect("res 必须可解析");
        match res {
            Inbound::Res { id, ok, error, result } => {
                assert_eq!(id, "h1");
                assert!(!ok);
                assert!(result.is_none());
                assert_eq!(error.unwrap().code, "INVALID_ARGUMENT");
            }
            other => panic!("应解析为 Res，实际 {other:?}"),
        }

        let host = serde_json::from_str::<Inbound>(
            r#"{"t":"host","id":"host-1","capability":"secure.decrypt","payload":{"cipherBase64":"AA=="}}"#,
        )
        .expect("host 必须可解析");
        match host {
            Inbound::Host { id, capability, payload } => {
                assert_eq!(id, "host-1");
                assert_eq!(capability, capability::SECURE_DECRYPT);
                assert_eq!(payload["cipherBase64"], "AA==");
            }
            other => panic!("应解析为 Host，实际 {other:?}"),
        }

        let bye = serde_json::from_str::<Inbound>(r#"{"t":"bye","reason":"协议不兼容","code":3}"#)
            .expect("bye 必须可解析");
        match bye {
            Inbound::Bye(frame) => {
                assert_eq!(frame.code, 3);
                assert!(frame.reason.contains("不兼容"));
            }
            other => panic!("应解析为 Bye，实际 {other:?}"),
        }
    }

    #[test]
    fn inbound_ignores_unknown_and_malformed_frames_without_panicking() {
        // 未来宿主/侧车组合来的新帧：必须被忽略而不是让宿主崩掉
        let unknown = serde_json::from_str::<Inbound>(r#"{"t":"metrics","payload":{}}"#)
            .expect("未知帧必须可解析为 Unknown");
        assert!(matches!(unknown, Inbound::Unknown));
        assert!(matches!(
            serde_json::from_str::<Inbound>("not json").unwrap_or(Inbound::Unknown),
            Inbound::Unknown
        ));
    }

    #[test]
    fn protocol_compatibility_requires_exact_major_match() {
        assert!(is_protocol_compatible(PROTOCOL_VERSION, PROTOCOL_VERSION));
        assert!(!is_protocol_compatible(PROTOCOL_VERSION + 1, PROTOCOL_VERSION));
        assert!(!is_protocol_compatible(0, PROTOCOL_VERSION));
    }

    #[test]
    fn domain_kinds_match_the_shared_contract_count() {
        // 与 TS `DOMAIN_KINDS` 同长同序；数量漂移意味着有一侧漏了域
        assert_eq!(DOMAIN_KINDS.len(), 15);
        assert_eq!(DOMAIN_KINDS[0], "workspace");
        assert_eq!(DOMAIN_KINDS[3], "settings");
        assert_eq!(DOMAIN_KINDS[11], "ai-context");
        assert_eq!(DOMAIN_KINDS[14], "designer");
        // 无重复
        let mut sorted = DOMAIN_KINDS;
        sorted.sort_unstable();
        for pair in sorted.windows(2) {
            assert_ne!(pair[0], pair[1], "域标识重复：{}", pair[0]);
        }
        assert_eq!(SYNC_PORT_DOMAINS, ["memory", "pipeline"]);
    }

    #[test]
    fn manifest_parsing_reports_reason_on_bad_input() {
        let manifest = parse_manifest(
            r#"{"protocol":1,"runtime":"everyone-coding-sidecar","entry":"x.cjs","hostCapabilities":["secure.encrypt"],"nodeMajor":22,"migrations":"migrations"}"#,
        )
        .expect("合法清单必须可解析");
        assert_eq!(manifest.protocol, PROTOCOL_VERSION);
        assert_eq!(manifest.node_major, 22);
        assert!(manifest
            .host_capabilities
            .contains(&capability::SECURE_ENCRYPT.to_string()));

        let error = parse_manifest("{ 这不是 json }").expect_err("非法清单必须报错");
        assert!(error.contains("合法 JSON"), "错误信息应指出原因：{error}");
    }
}
