//! 受控侧车（sidecar）：把 Node 侧业务运行时挂到 Tauri 外壳上的唯一通道。
//!
//! ## 为什么是侧车，而不是把业务运行时迁进 Rust
//!
//! 本仓库的业务逻辑是 **15 个域 + AI 栈 + `@ec/*` 领域内核 + better-sqlite3**，
//! 全部为 Node 侧 TypeScript。把它们搬进 Rust 意味着**重写第二遍**：
//! 两份实现必然漂移，而 D-01 要求"两版功能等价、同一套领域包"。
//!
//! 因此采用受控侧车：
//!
//! ```text
//! 渲染层 ──shell-api──► Tauri 桥接层 ──invoke──► Rust 命令
//!                                                  │  NDJSON（stdin/stdout）
//!                                                  ▼
//!                                        Node 侧车（本仓库真实的域运行时）
//! ```
//!
//! Rust 只做三件事：**生命周期**（起/停/崩溃回收/升级兼容）、**协议搬运**、
//! **宿主能力**（DPAPI / 打开外链 / 剪贴板——只有外壳能做的事）。
//! 业务逻辑一行都不重复。
//!
//! ## 硬约束（本模块的全部存在意义就是把它们守住）
//!
//! 1. **不伪造成功**：侧车不可用（没有 Node / 协议不兼容 / 装配失败）时，
//!    每个命令都返回带**真实原因**的 `NOT_SUPPORTED`；绝不返回空结果或假数据。
//! 2. **不留孤儿**：宿主退出先发协议 `shutdown`（让侧车杀掉预览后端等子进程），
//!    超时才强杀，强杀走 `taskkill /T` 整棵进程树。
//! 3. **路径安全**：侧车可执行文件必须落在受信目录内、名字与清单一致、
//!    目录不得含 `..`；否则拒绝启动（否则"启动侧车"就退化成"执行任意程序"）。
//! 4. **升级兼容**：清单与运行时握手**两处**都校验协议主版本，不一致直接拒绝服务。

pub mod protocol;

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex};

use protocol::{
    capability, event, is_protocol_compatible, op, AiAvailabilityWire, ByeFrame, DomainDescriptorWire,
    EventEnvelopeWire, HelloFrame, HostResultFrame, Inbound, ReadyFrame, RequestFrame,
    SidecarConfigWire, SidecarManifest, WelcomeFrame, WireError, PROTOCOL_VERSION, SIDECAR_RUNTIME_ID,
};

/// 侧车入口文件名（清单缺省值，也是唯一允许的缺省名）
pub const SIDECAR_ENTRY_FILE: &str = "everyone-coding-sidecar.cjs";
/// 侧车清单文件名
pub const SIDECAR_MANIFEST_FILE: &str = "sidecar-manifest.json";

/// 握手 + 装配的总超时。装配要跑 SQLite 迁移并初始化 AI 栈，首次启动可能偏慢；
/// 但**必须有上限**——否则侧车卡住时宿主会永远停在"正在启动"。
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
/// 单次域/AI 调用的默认超时。
///
/// 刻意放得很宽：真实业务里有克隆仓库、跑生成队列这类分钟级动作，
/// 而超时**不会**取消侧车里正在跑的工作（协议层没有取消语义），
/// 收紧它只会制造"UI 报超时、后台还在干活"的错位。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
/// 关闭时的优雅等待上限
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);
/// 崩溃后允许的自动重启次数（超过就如实报不可用，避免无限重启打转）
const MAX_RESTARTS: u32 = 3;
/// 单个订阅者的事件队列上限由 Channel 内部处理；这里只限制订阅者数量
const MAX_SUBSCRIBERS: usize = 32;

/* ------------------------------ 对外结果类型 ------------------------------ */

/// 侧车整体可用性（`capabilities()` 与 `domain_describe` 共用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarReadiness {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub domains: Vec<DomainDescriptorWire>,
    /// 在 Electron 形态下有同步口、而 Tauri 形态不暴露的域（同步 IPC 原语缺失）
    pub sync_domains: Vec<String>,
    pub ai: AiAvailabilityWire,
}

impl SidecarReadiness {
    fn unavailable(reason: impl Into<String>) -> Self {
        let message = reason.into();
        Self {
            available: false,
            // 侧车不可用时**列出全部域并逐个给出同一原因**：渲染层据此对每个页面
            // 给出如实的装配引导。返回空数组会让页面卡在"什么都没有"，
            // 用户既不知道坏在哪、也不知道该怎么办。
            domains: protocol::DOMAIN_KINDS
                .iter()
                .map(|kind| DomainDescriptorWire {
                    kind: (*kind).to_string(),
                    available: false,
                    reason: Some(message.clone()),
                })
                .collect(),
            sync_domains: protocol::SYNC_PORT_DOMAINS
                .iter()
                .map(|kind| (*kind).to_string())
                .collect(),
            ai: AiAvailabilityWire {
                available: false,
                reason: Some(message.clone()),
            },
            reason: Some(message),
        }
    }
}

/// 侧车位置解析结果
#[derive(Debug, Clone)]
pub struct SidecarLocation {
    pub sidecar_dir: PathBuf,
    pub entry: PathBuf,
    pub node: PathBuf,
    pub manifest: SidecarManifest,
    pub migrations_dir: Option<PathBuf>,
}

/* ------------------------------ 路径安全 ------------------------------ */

fn component_eq(a: &Component<'_>, b: &Component<'_>) -> bool {
    // Windows 路径大小写不敏感；逐段比较而不是比较字符串前缀，
    // 这样 `C:\root-evil` 不会被误判成 `C:\root` 的子路径。
    a.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
}

/// `child` 是否落在 `root` 之内（含 root 自身）。
pub fn is_within(root: &Path, child: &Path) -> bool {
    let mut root_parts = root.components();
    let mut child_parts = child.components();
    loop {
        match (root_parts.next(), child_parts.next()) {
            (None, _) => return true,
            (Some(expected), Some(actual)) => {
                if !component_eq(&expected, &actual) {
                    return false;
                }
            }
            (Some(_), None) => return false,
        }
    }
}

/// 校验侧车目录，返回清单与规范化后的入口路径。
///
/// 四道关（缺任何一道，"启动侧车"就退化成"执行任意程序"）：
/// 1. 目录本身不含 `..` 片段；
/// 2. 清单存在且可解析、`runtime` 与本仓库一致、协议版本兼容；
/// 3. 入口文件名不含路径分隔符与 `..`（清单是外部文件，不可信）；
/// 4. 入口规范化后必须仍在目录内，且文件名与清单声明**逐字一致**。
pub fn validate_sidecar_dir(dir: &Path) -> Result<(SidecarManifest, PathBuf), String> {
    if dir
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(format!("侧车目录含 `..` 片段，已拒绝：{}", dir.display()));
    }

    let manifest_path = dir.join(SIDECAR_MANIFEST_FILE);
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("读取侧车清单失败（{}）：{e}", manifest_path.display()))?;
    let manifest = protocol::parse_manifest(&text)?;

    if manifest.runtime != SIDECAR_RUNTIME_ID {
        return Err(format!(
            "侧车清单的 runtime 不是 {SIDECAR_RUNTIME_ID}（实际 {}），已拒绝启动",
            manifest.runtime
        ));
    }
    if !is_protocol_compatible(PROTOCOL_VERSION, manifest.protocol) {
        // 升级不兼容必须**在启动前**报出来：等握完手再炸，用户看到的是"点了没反应"
        return Err(format!(
            "侧车产物与新外壳协议不兼容：产物 protocol={}，外壳支持 {}。请重新构建侧车（pnpm --filter @ec/desktop-electron build:sidecar）",
            manifest.protocol, PROTOCOL_VERSION
        ));
    }

    let entry_name = if manifest.entry.is_empty() {
        SIDECAR_ENTRY_FILE.to_string()
    } else {
        manifest.entry.clone()
    };
    if entry_name.contains('/') || entry_name.contains('\\') || entry_name.contains("..") {
        return Err(format!("侧车清单里的入口名非法：{entry_name}"));
    }

    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("侧车目录不可访问（{}）：{e}", dir.display()))?;
    let entry = dir.join(&entry_name);
    let canonical_entry = entry
        .canonicalize()
        .map_err(|e| format!("侧车入口不存在（{}）：{e}", entry.display()))?;

    if !is_within(&canonical_dir, &canonical_entry) {
        return Err(format!(
            "侧车入口越出受信目录，已拒绝：{} 不在 {} 内",
            canonical_entry.display(),
            canonical_dir.display()
        ));
    }
    if canonical_entry.file_name().map(|name| name.to_string_lossy().to_string())
        != Some(entry_name.clone())
    {
        return Err("侧车入口经规范化后名字发生变化（疑似链接逃逸），已拒绝".to_string());
    }

    Ok((manifest, canonical_entry))
}

/// 在 PATH 中查找可执行文件（不依赖额外 crate）。
fn find_on_path(file_name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 解析 Node 运行时。
///
/// 三级回退：显式环境变量 → 随侧车目录分发 → PATH。
/// 都找不到时**给出可操作的指引**：侧车承载全部业务运行时，缺它的症状是
/// "域端口与 AI 栈全不可用"，报一句"找不到 node"用户无从下手。
pub fn resolve_node(sidecar_dir: &Path) -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("EC_SIDECAR_NODE") {
        let path = PathBuf::from(explicit);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!(
                "EC_SIDECAR_NODE 指向的文件不存在：{}（请修正该环境变量或删除它）",
                path.display()
            ))
        };
    }

    let bundled = sidecar_dir.join("node.exe");
    if bundled.is_file() {
        return Ok(bundled);
    }

    if let Some(found) = find_on_path("node.exe").or_else(|| find_on_path("node")) {
        return Ok(found);
    }

    Err(
        "未找到 Node 运行时：侧车承载全部业务运行时（域端口与 AI 栈），缺它时这两项均不可用。\
         请把 node.exe 放到侧车目录，或设置 EC_SIDECAR_NODE，或把 node 加入 PATH。"
            .to_string(),
    )
}

/// 侧车目录候选（按优先级）。
fn sidecar_dir_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(explicit) = std::env::var_os("EC_SIDECAR_DIR") {
        candidates.push(PathBuf::from(explicit));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("sidecar"));
    }
    // 开发期：产物在仓库里（`apps/desktop-electron/dist/sidecar`）。
    // 以可执行文件目录与工作目录为起点向上探测，避免把仓库层级写死。
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            starts.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for start in starts {
        let mut dir = start;
        for _ in 0..8 {
            candidates.push(dir.join("apps").join("desktop-electron").join("dist").join("sidecar"));
            candidates.push(dir.join("sidecar"));
            let parent = dir.parent().map(Path::to_path_buf);
            match parent {
                Some(next) if next != dir => dir = next,
                _ => break,
            }
        }
    }
    candidates
}

/// 解析侧车位置：逐个候选尝试，命中即用；全失败时把**每个候选的失败原因**都带回去。
pub fn resolve_sidecar(app: &AppHandle) -> Result<SidecarLocation, String> {
    let mut attempts: Vec<String> = Vec::new();
    for dir in sidecar_dir_candidates(app) {
        if !dir.join(SIDECAR_MANIFEST_FILE).is_file() {
            continue;
        }
        match validate_sidecar_dir(&dir) {
            Ok((manifest, entry)) => {
                let node = resolve_node(&dir)?;
                let migrations_dir = manifest
                    .migrations
                    .as_ref()
                    .map(|name| dir.join(name))
                    .filter(|path| path.join("0001_init.sql").is_file());
                return Ok(SidecarLocation {
                    sidecar_dir: dir,
                    entry,
                    node,
                    manifest,
                    migrations_dir,
                });
            }
            Err(reason) => attempts.push(reason),
        }
    }
    if attempts.is_empty() {
        return Err(
            "未找到侧车产物：需要先构建（pnpm --filter @ec/desktop-electron build:sidecar），\
             或用 EC_SIDECAR_DIR 指向产物目录"
                .to_string(),
        );
    }
    Err(format!("侧车产物校验失败：{}", attempts.join("；")))
}

/* ------------------------------ 生命周期状态 ------------------------------ */

#[derive(Debug)]
enum Phase {
    Idle,
    Starting,
    Ready(Box<ReadyFrame>),
    Stopped(String),
}

struct Inner {
    phase: Phase,
    child: Option<Child>,
    pending: HashMap<String, oneshot::Sender<Result<Value, WireError>>>,
    ready_tx: Option<oneshot::Sender<Result<ReadyFrame, WireError>>>,
    restarts: u32,
    /// 侧车最近一次报上来的终止原因（用于区分"计划内关闭"与"崩溃"）
    last_bye: Option<ByeFrame>,
}

/// 侧车管理器。
///
/// 生命周期：惰性启动（首次调用时拉起）→ 就绪后长驻 → 崩溃后有限重启 →
/// 宿主退出时优雅收尾。
pub struct SidecarManager {
    app: AppHandle,
    /// 位置解析结果。`Err` = **配置性**不可用（没构建 / 没 Node / 协议不兼容），
    /// 这类失败重试无意义，因此不进重启计数。
    location: Result<SidecarLocation, String>,
    config: SidecarConfigWire,
    inner: Mutex<Inner>,
    /// stdin 独立成锁：写管道可能阻塞（侧车未及时读），
    /// 与 `inner` 分开才不会把响应投递一起卡住。
    stdin: Mutex<Option<ChildStdin>>,
    /// 串行化"启动/停止"这两段生命周期动作，避免并发首次调用拉起两个侧车。
    lifecycle: Mutex<()>,
    subscribers: Mutex<HashMap<String, Channel<EventEnvelopeWire>>>,
    seq: AtomicU64,
}

impl SidecarManager {
    pub fn new(app: AppHandle, config: SidecarConfigWire) -> Arc<Self> {
        let location = resolve_sidecar(&app);
        Arc::new(Self {
            app,
            location,
            config,
            inner: Mutex::new(Inner {
                phase: Phase::Idle,
                child: None,
                pending: HashMap::new(),
                ready_tx: None,
                restarts: 0,
                last_bye: None,
            }),
            stdin: Mutex::new(None),
            lifecycle: Mutex::new(()),
            subscribers: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(1),
        })
    }

    /// 侧车位置（诊断用；不触发启动）
    pub fn location_debug(&self) -> Result<String, String> {
        self.location
            .as_ref()
            .map(|location| {
                format!(
                    "entry={} node={} protocol={}",
                    location.entry.display(),
                    location.node.display(),
                    location.manifest.protocol
                )
            })
            .map_err(Clone::clone)
    }

    /// 宿主侧 DPAPI 是否可用。
    ///
    /// 用**真实加解密一次探针**判定而不是猜环境：`createSecureFileStorage` 那套
    /// TS 代码以 `isEncryptionAvailable()` 的同步返回值决定"装不装 auth 域"，
    /// 探针失败却报 true 会让它随后在写密钥时才炸——那是启动期看不到的故障。
    fn secure_store_available(&self) -> bool {
        static PROBE: OnceLock<bool> = OnceLock::new();
        *PROBE.get_or_init(|| {
            crate::commands::secure_store::dpapi_encrypt_bytes(b"everyonecoding-dpapi-probe").is_ok()
        })
    }

    fn request_id(&self) -> String {
        format!("h{}", self.seq.fetch_add(1, Ordering::SeqCst))
    }

    /// 确保侧车就绪（并发调用共享同一次启动）。
    pub async fn ensure_ready(self: &Arc<Self>) -> Result<ReadyFrame, WireError> {
        let _guard = self.lifecycle.lock().await;
        {
            let inner = self.inner.lock().await;
            match &inner.phase {
                Phase::Ready(ready) => return Ok((**ready).clone()),
                Phase::Stopped(reason) if inner.restarts >= MAX_RESTARTS => {
                    return Err(WireError::unsupported(format!(
                        "侧车连续失败 {MAX_RESTARTS} 次后已停止自动重启：{reason}"
                    )));
                }
                _ => {}
            }
        }
        self.start().await
    }

    /// 不做重启计数判定的一次启动尝试（`start` / 手工重启共用）。
    async fn start(self: &Arc<Self>) -> Result<ReadyFrame, WireError> {
        let location = match &self.location {
            Ok(location) => location.clone(),
            Err(reason) => return Err(WireError::unsupported(reason.clone())),
        };

        let mut command = tokio::process::Command::new(&location.node);
        command
            .arg(&location.entry)
            .current_dir(
                location
                    .sidecar_dir
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| location.sidecar_dir.clone()),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(migrations) = &location.migrations_dir {
            command.env("EC_SIDECAR_MIGRATIONS_DIR", migrations);
        }
        // Windows 上避免弹出控制台窗口（侧车是后台进程，不该闪黑框）
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn().map_err(|error| {
            WireError::unsupported(format!(
                "侧车进程启动失败（{} {}）：{error}",
                location.node.display(),
                location.entry.display()
            ))
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| WireError::new("UNKNOWN", "未能取得侧车 stdout"))?;
        let stderr = child.stderr.take();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| WireError::new("UNKNOWN", "未能取得侧车 stdin"))?;

        let (ready_tx, ready_rx) = oneshot::channel::<Result<ReadyFrame, WireError>>();
        {
            let mut inner = self.inner.lock().await;
            inner.phase = Phase::Starting;
            inner.child = Some(child);
            inner.ready_tx = Some(ready_tx);
            inner.last_bye = None;
        }
        *self.stdin.lock().await = Some(stdin);

        // 读循环与 stderr 泵各自一个任务：读循环必须**永远在跑**，
        // 否则侧车的 stdout 写满管道后会阻塞，表现为"侧车突然不动了"。
        tokio::spawn(Self::reader_loop(self.clone(), stdout));
        if let Some(stderr) = stderr {
            tokio::spawn(Self::stderr_loop(self.clone(), stderr));
        }

        match tokio::time::timeout(STARTUP_TIMEOUT, ready_rx).await {
            Ok(Ok(Ok(ready))) => {
                let mut inner = self.inner.lock().await;
                inner.restarts = 0;
                inner.phase = Phase::Ready(Box::new(ready.clone()));
                Ok(ready)
            }
            Ok(Ok(Err(error))) => {
                self.fail_all_pending(error.message.clone()).await;
                self.force_stop().await;
                Err(error)
            }
            Ok(Err(_)) => {
                let error = WireError::new("CANCELLED", "侧车在就绪前结束（握手通道已关闭）");
                self.force_stop().await;
                Err(error)
            }
            Err(_) => {
                let error = WireError::unsupported(format!(
                    "侧车在 {} 秒内未就绪（装配超时），已终止",
                    STARTUP_TIMEOUT.as_secs()
                ));
                self.fail_all_pending(error.message.clone()).await;
                self.force_stop().await;
                Err(error)
            }
        }
    }

    /* ------------------------------ 入站帧处理 ------------------------------ */

    async fn reader_loop(self: Arc<Self>, stdout: ChildStdout) {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Inbound>(&line) {
                        Ok(frame) => self.handle_inbound(frame).await,
                        Err(error) => {
                            // 解析失败**不能**让宿主崩：侧车可能正在退出而写了半行。
                            // 但要留痕——否则"协议被污染"会表现成凭空少了一个响应。
                            let preview: String = line.chars().take(200).collect();
                            self.push_log(
                                "warn",
                                &format!("侧车帧无法解析（{error}）：{preview}"),
                            )
                            .await;
                        }
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    self.push_log("warn", &format!("读取侧车 stdout 失败：{error}"))
                        .await;
                    break;
                }
            }
        }
        self.on_eof().await;
    }

    async fn stderr_loop(self: Arc<Self>, stderr: tokio::process::ChildStderr) {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // 侧车把 console 全部改道 stderr，因此这里就是它的运行日志。
            // 原样转成 log 事件：诊断时不必再去翻宿主进程的 stderr。
            self.push_log("info", &format!("[sidecar] {line}")).await;
        }
    }

    async fn handle_inbound(self: &Arc<Self>, frame: Inbound) {
        match frame {
            Inbound::Hello(hello) => self.on_hello(hello).await,
            Inbound::Ready(ready) => self.on_ready(*ready).await,
            Inbound::Res {
                id,
                ok,
                result,
                error,
            } => self.on_response(&id, ok, result, error).await,
            Inbound::Evt { op: op_name, payload } => self.on_event(&op_name, payload).await,
            Inbound::Host {
                id,
                capability,
                payload,
            } => self.on_host_call(id, capability, payload).await,
            Inbound::Bye(bye) => self.on_bye(bye).await,
            Inbound::Unknown => {}
        }
    }

    async fn on_hello(self: &Arc<Self>, hello: HelloFrame) {
        let compatible = is_protocol_compatible(PROTOCOL_VERSION, hello.protocol);
        if !compatible {
            let reason = format!(
                "侧车协议不兼容：侧车 protocol={}，外壳支持 {}（请重新构建侧车产物）",
                hello.protocol, PROTOCOL_VERSION
            );
            self.fail_ready(WireError::unsupported(reason.clone())).await;
            self.push_log("error", &reason).await;
            return;
        }
        self.push_log(
            "info",
            &format!(
                "侧车已连接：pid={} node={} features={}",
                hello.pid,
                hello.node,
                hello.features.join(",")
            ),
        )
        .await;

        let welcome = WelcomeFrame::new(self.secure_store_available(), self.config.clone());
        self.write_frame(&welcome).await;
    }

    async fn on_ready(self: &Arc<Self>, ready: ReadyFrame) {
        if !is_protocol_compatible(PROTOCOL_VERSION, ready.protocol) {
            self.fail_ready(WireError::unsupported("侧车 ready 帧协议版本不兼容"))
                .await;
            return;
        }
        let mut inner = self.inner.lock().await;
        inner.phase = Phase::Ready(Box::new(ready.clone()));
        if let Some(tx) = inner.ready_tx.take() {
            let _ = tx.send(Ok(ready));
        }
    }

    async fn on_response(
        self: &Arc<Self>,
        id: &str,
        ok: bool,
        result: Option<Value>,
        error: Option<WireError>,
    ) {
        let sender = self.inner.lock().await.pending.remove(id);
        let Some(sender) = sender else {
            // 迟到的响应（请求已超时）：丢弃即可，不该转化成错误抛给谁
            return;
        };
        let outcome = if ok {
            Ok(result.unwrap_or(Value::Null))
        } else {
            Err(error.unwrap_or_else(|| WireError::new("UNKNOWN", "侧车未给出错误详情")))
        };
        let _ = sender.send(outcome);
    }

    async fn on_event(self: &Arc<Self>, op_name: &str, payload: Value) {
        // 事件按"发出去就算"处理：某个订阅者失败（窗口已销毁）不该影响其它订阅者，
        // 更不该反向打断侧车的业务路由。
        let envelope = EventEnvelopeWire::new(op_name, payload);
        let mut stale: Vec<String> = Vec::new();
        {
            let subscribers = self.subscribers.lock().await;
            for (id, channel) in subscribers.iter() {
                if channel.send(envelope.clone()).is_err() {
                    stale.push(id.clone());
                }
            }
        }
        if !stale.is_empty() {
            let mut subscribers = self.subscribers.lock().await;
            for id in stale {
                subscribers.remove(&id);
            }
        }
    }

    async fn on_bye(self: &Arc<Self>, bye: ByeFrame) {
        let reason = if bye.reason.is_empty() {
            format!("侧车退出（code={}）", bye.code)
        } else {
            bye.reason.clone()
        };
        self.push_log("info", &format!("侧车终止：{reason}")).await;
        {
            let mut inner = self.inner.lock().await;
            inner.last_bye = Some(bye);
            inner.phase = Phase::Stopped(reason.clone());
        }
        self.fail_ready(WireError::unsupported(reason)).await;
        self.fail_all_pending("侧车已终止".to_string()).await;
    }

    async fn on_host_call(self: &Arc<Self>, id: String, capability: String, payload: Value) {
        let reply = match capability.as_str() {
            capability::SECURE_AVAILABLE => HostResultFrame::ok(
                id.clone(),
                Some(serde_json::json!({ "available": self.secure_store_available() })),
            ),
            capability::SECURE_ENCRYPT => match payload
                .get("plainText")
                .and_then(Value::as_str)
            {
                Some(plain) => match crate::commands::secure_store::dpapi_encrypt_bytes(
                    plain.as_bytes(),
                ) {
                    Ok(cipher) => HostResultFrame::ok(
                        id.clone(),
                        Some(serde_json::json!({
                            "cipherBase64": encode_base64(&cipher)
                        })),
                    ),
                    Err(error) => HostResultFrame::failed(
                        id.clone(),
                        WireError::new(&error.code, error.message),
                    ),
                },
                None => HostResultFrame::failed(
                    id.clone(),
                    WireError::new("INVALID_ARGUMENT", "secure.encrypt 缺少 plainText"),
                ),
            },
            capability::SECURE_DECRYPT => {
                let cipher = payload
                    .get("cipherBase64")
                    .and_then(Value::as_str)
                    .and_then(decode_base64);
                match cipher {
                    Some(bytes) => {
                        match crate::commands::secure_store::dpapi_decrypt_bytes(&bytes) {
                            Ok(plain) => match String::from_utf8(plain) {
                                Ok(text) => HostResultFrame::ok(
                                    id.clone(),
                                    Some(serde_json::json!({ "plainText": text })),
                                ),
                                Err(error) => HostResultFrame::failed(
                                    id.clone(),
                                    WireError::new("DECRYPT_FAILED", error.to_string()),
                                ),
                            },
                            Err(error) => HostResultFrame::failed(
                                id.clone(),
                                WireError::new(&error.code, error.message),
                            ),
                        }
                    }
                    None => HostResultFrame::failed(
                        id.clone(),
                        WireError::new("INVALID_ARGUMENT", "secure.decrypt 缺少合法 cipherBase64"),
                    ),
                }
            }
            capability::SHELL_OPEN_EXTERNAL => {
                match payload.get("url").and_then(Value::as_str) {
                    Some(url) => match crate::commands::external::open_external_url(url) {
                        Ok(()) => HostResultFrame::ok(id.clone(), None),
                        Err(error) => HostResultFrame::failed(
                            id.clone(),
                            WireError::new(&error.code, error.message),
                        ),
                    },
                    None => HostResultFrame::failed(
                        id.clone(),
                        WireError::new("INVALID_ARGUMENT", "shell.openExternal 缺少 url"),
                    ),
                }
            }
            capability::CLIPBOARD_WRITE_TEXT => {
                match payload.get("text").and_then(Value::as_str) {
                    Some(text) => {
                        use tauri_plugin_clipboard_manager::ClipboardExt;
                        match self.app.clipboard().write_text(text.to_string()) {
                            Ok(()) => HostResultFrame::ok(id.clone(), None),
                            Err(error) => HostResultFrame::failed(
                                id.clone(),
                                WireError::new("IO_ERROR", format!("写入剪贴板失败：{error}")),
                            ),
                        }
                    }
                    None => HostResultFrame::failed(
                        id.clone(),
                        WireError::new("INVALID_ARGUMENT", "clipboard.writeText 缺少 text"),
                    ),
                }
            }
            other => HostResultFrame::failed(
                id.clone(),
                WireError::unsupported(format!("宿主未登记该能力：{other}")),
            ),
        };
        self.write_frame(&reply).await;
    }

    async fn on_eof(self: &Arc<Self>) {
        let reason = {
            let mut inner = self.inner.lock().await;
            let reason = match &inner.phase {
                Phase::Ready(_) => "侧车进程结束（stdout 已关闭）".to_string(),
                Phase::Stopped(existing) => existing.clone(),
                _ => "侧车在就绪前结束".to_string(),
            };
            let crashed = matches!(inner.phase, Phase::Ready(_));
            if crashed {
                inner.restarts += 1;
            }
            inner.child = None;
            inner.phase = Phase::Stopped(reason.clone());
            reason
        };
        *self.stdin.lock().await = None;
        self.fail_ready(WireError::unsupported(format!("{reason}（已自动重启 {} 次上限）", MAX_RESTARTS)))
            .await;
        self.fail_all_pending(reason).await;
    }

    /* ------------------------------ 出站 ------------------------------ */

    async fn write_frame<T: Serialize>(&self, frame: &T) -> bool {
        let mut line = match serde_json::to_string(frame) {
            Ok(text) => text,
            Err(error) => {
                // 序列化失败是编程错误（帧类型不可序列化），留痕即可
                eprintln!("[sidecar] 帧序列化失败：{error}");
                return false;
            }
        };
        line.push('\n');
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return false;
        };
        if let Err(error) = stdin.write_all(line.as_bytes()).await {
            eprintln!("[sidecar] 写入侧车 stdin 失败：{error}");
            return false;
        }
        if let Err(error) = stdin.flush().await {
            eprintln!("[sidecar] 刷新侧车 stdin 失败：{error}");
            return false;
        }
        true
    }

    async fn fail_ready(&self, error: WireError) {
        let mut inner = self.inner.lock().await;
        if let Some(tx) = inner.ready_tx.take() {
            let _ = tx.send(Err(error));
        }
    }

    async fn fail_all_pending(&self, reason: String) {
        let mut inner = self.inner.lock().await;
        let pending = std::mem::take(&mut inner.pending);
        drop(inner);
        for (_, sender) in pending {
            let _ = sender.send(Err(WireError::new("CANCELLED", reason.clone())));
        }
    }

    async fn push_log(self: &Arc<Self>, level: &str, message: &str) {
        self.on_event(
            event::LOG,
            serde_json::json!({ "level": level, "message": message }),
        )
        .await;
    }

    /* ------------------------------ 公共 API ------------------------------ */

    /// 向侧车发一次调用。
    pub async fn request(
        self: &Arc<Self>,
        op_name: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, WireError> {
        self.ensure_ready().await?;

        let id = self.request_id();
        let (tx, rx) = oneshot::channel();
        {
            let mut inner = self.inner.lock().await;
            if !matches!(inner.phase, Phase::Ready(_)) {
                return Err(WireError::unsupported("侧车尚未就绪"));
            }
            inner.pending.insert(id.clone(), tx);
        }

        let frame = RequestFrame::new(&id, op_name, payload);
        if !self.write_frame(&frame).await {
            self.inner.lock().await.pending.remove(&id);
            return Err(WireError::new("CANCELLED", "侧车管道不可写（进程可能已结束）"));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err(WireError::new("CANCELLED", "侧车在应答前结束")),
            Err(_) => {
                // 超时后必须把登记项摘掉：否则响应迟到时会往一个已放弃的
                // oneshot 里投递（无害但会掩盖"侧车变慢"的趋势）
                self.inner.lock().await.pending.remove(&id);
                Err(WireError::new(
                    "TIMEOUT",
                    format!("{op_name} 超过 {} 秒未应答", timeout.as_secs()),
                ))
            }
        }
    }

    /// 域调用：把侧车返回的 `DomainRpcResponse` 原样交给渲染层。
    ///
    /// 侧车不可用时**合成**一份同形状的失败响应（而不是抛错）：渲染层契约是
    /// "一定拿到 `{requestId, ok:false, error}`"，抛错会让它走另一条路径。
    pub async fn invoke_domain(self: &Arc<Self>, request: Value) -> Value {
        let request_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("invalid")
            .to_string();
        match self
            .request(op::DOMAIN_INVOKE, request, REQUEST_TIMEOUT)
            .await
        {
            Ok(value) => value,
            Err(error) => serde_json::json!({
                "requestId": request_id,
                "ok": false,
                "error": error,
            }),
        }
    }

    /// 各域可用性。侧车不可用时返回**空列表 + 原因**——
    /// 渲染层据此不注入任何端口，并对页面给出如实引导。
    pub async fn describe(self: &Arc<Self>) -> SidecarReadiness {
        match self
            .request(op::DOMAIN_DESCRIBE, Value::Null, STARTUP_TIMEOUT)
            .await
        {
            Ok(value) => {
                let domains =
                    serde_json::from_value::<Vec<DomainDescriptorWire>>(value).unwrap_or_default();
                let inner = self.inner.lock().await;
                if let Phase::Ready(ready) = &inner.phase {
                    return SidecarReadiness {
                        available: true,
                        reason: None,
                        domains,
                        sync_domains: ready.sync_domains.clone(),
                        ai: ready.ai.clone(),
                    };
                }
                SidecarReadiness::unavailable("侧车状态不一致（describe 成功但状态非 Ready）")
            }
            Err(error) => SidecarReadiness::unavailable(error.message),
        }
    }

    /// 就绪信息（不触发完整 describe，供 `capabilities()` 快速判定）
    pub async fn readiness(self: &Arc<Self>) -> SidecarReadiness {
        match self.ensure_ready().await {
            Ok(ready) => SidecarReadiness {
                available: true,
                reason: None,
                domains: ready.domains.clone(),
                sync_domains: ready.sync_domains.clone(),
                ai: ready.ai.clone(),
            },
            Err(error) => SidecarReadiness::unavailable(error.message),
        }
    }

    /// 订阅事件（返回订阅 id）。
    pub async fn subscribe(
        self: &Arc<Self>,
        channel: Channel<EventEnvelopeWire>,
    ) -> Result<String, String> {
        let mut subscribers = self.subscribers.lock().await;
        if subscribers.len() >= MAX_SUBSCRIBERS {
            return Err(format!(
                "事件订阅数已达上限（{MAX_SUBSCRIBERS}）：疑似泄漏的订阅未退订"
            ));
        }
        let id = self.request_id();
        subscribers.insert(id.clone(), channel);
        Ok(id)
    }

    pub async fn unsubscribe(&self, id: &str) {
        self.subscribers.lock().await.remove(id);
    }

    /// 强制终止侧车进程树（不做优雅等待）。
    async fn force_stop(&self) {
        let child = self.inner.lock().await.child.take();
        *self.stdin.lock().await = None;
        let Some(mut child) = child else {
            return;
        };
        let pid = child.id();
        if let Some(pid) = pid {
            // Windows 上 `kill()` 只结束直接子进程；侧车自己 spawn 的预览后端
            // （npm run dev 之类）会变成孤儿，继续占着端口与工程目录。
            // `taskkill /T` 按进程树整棵结束，与 Electron 侧 `process-host.ts` 同口径。
            #[cfg(windows)]
            {
                let _ = tokio::process::Command::new("taskkill")
                    .args(["/pid", &pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await;
            }
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }

    /// 优雅收尾：协议 `shutdown` → 等 `bye` → 强杀兜底。
    pub async fn shutdown(self: &Arc<Self>) {
        let _guard = self.lifecycle.lock().await;
        {
            let inner = self.inner.lock().await;
            if matches!(inner.phase, Phase::Idle | Phase::Stopped(_)) && inner.child.is_none() {
                return;
            }
        }
        // 先礼：让侧车自己释放（它会一并杀掉预览后端）
        let _ = self
            .request(op::SHUTDOWN, Value::Null, SHUTDOWN_TIMEOUT)
            .await;
        // 等退出；超时后兵
        let deadline = tokio::time::Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            {
                let mut inner = self.inner.lock().await;
                if let Some(child) = inner.child.as_mut() {
                    match child.try_wait() {
                        Ok(Some(_)) => {
                            inner.child = None;
                            inner.phase = Phase::Stopped("已按宿主请求关闭".to_string());
                            break;
                        }
                        Ok(None) => {}
                        Err(_) => {}
                    }
                } else {
                    break;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.force_stop().await;
        self.fail_all_pending("宿主正在退出".to_string()).await;
    }
}

/* ------------------------------ base64（避免新增 crate） ------------------------------ */

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 标准 base64 编码（无换行）
pub fn encode_base64(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(B64_ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

/// 标准 base64 解码；输入非法时返回 `None`（调用方据此回 INVALID_ARGUMENT）。
pub fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn value_of(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some((byte - b'A') as u32),
            b'a'..=b'z' => Some((byte - b'a') as u32 + 26),
            b'0'..=b'9' => Some((byte - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let cleaned: Vec<u8> = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if !cleaned.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    for chunk in cleaned.chunks(4) {
        let mut accum = 0u32;
        let mut padding = 0;
        for (index, byte) in chunk.iter().enumerate() {
            if *byte == b'=' {
                // 只允许出现在最后两位
                if index < 2 {
                    return None;
                }
                padding += 1;
                accum <<= 6;
                continue;
            }
            if padding > 0 {
                return None;
            }
            accum = (accum << 6) | value_of(*byte)?;
        }
        out.push((accum >> 16) as u8);
        if padding < 2 {
            out.push((accum >> 8) as u8);
        }
        if padding < 1 {
            out.push(accum as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests;
