# @ec/desktop-tauri

EveryoneCoding 的 **Tauri 2 外壳（Rust 命令 + TypeScript 桥接层）**。

本包把 `packages/shell-api` 定义的 `ShellHost` 接口落地为 Rust 命令（`src-tauri/`）与
TypeScript 桥接层（`src/bridge.ts`）。渲染层只依赖 `@ec/shell-api`，**禁止**直接 `import`
任何 `@tauri-apps/*`（桥接层是唯一授权边界）。

## 环境要求

- **Rust 工具链**：stable ≥ 1.77（`rustup toolchain install stable`）；Windows 上**官方仅支持**
  MSVC 宿主工具链（`x86_64-pc-windows-msvc`）。
- **MSVC 生成工具**：Visual Studio 2022 的「使用 C++ 的桌面开发」工作负载
  （或 VS Build Tools 的 `Microsoft.VisualStudio.Workload.VCTools` + Windows 11 SDK）
- **Windows 10 / 11 SDK**
- **WebView2 运行时**：Evergreen 版（[下载](https://go.microsoft.com/fwlink/p/?LinkId=2124703)）；
  缺失时应用启动会经 `webview2-check.ts` 渲染安装引导，不会白屏
- **Node.js** ≥ 18 与 pnpm（workspace 根）

> 一键脚本（**需管理员**，官方路径）：
> `powershell -ExecutionPolicy Bypass -File scripts/setup-rust-tauri.ps1`
> 可完成 rustup + VS Build Tools 安装与环境体检。
>
> **无可管理员权限时的替代路径（非官方支持，本机实测部分可用）**：
> `scripts/setup-rust-tauri-gnu.ps1` 用 `x86_64-pc-windows-gnu` 工具链 + Zig 提供的
> C 编译器 / `dlltool` / `windres` 顶替 MSVC。实测 `cargo check`、`cargo clippy --all-targets -- -D warnings`、
> `cargo build` 与**真实启动窗口**均通过；但 `cargo test --lib` 的测试二进制会以
> `STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)` 退出（该组合的运行期限制，非仓库代码缺陷），
> 因此**跑 Rust 单测仍必须用 MSVC 官方工具链**。

## 双形态功能等价（D-01）怎么落地

Tauri 外壳是 Rust + 系统 WebView2，**没有 Node 运行时**；而本仓库的业务逻辑
（15 个域 + AI 栈 + `@ec/*` 领域内核 + better-sqlite3）全部是 Node 侧 TS。
若把它们重写进 Rust，就会有两份必然漂移的实现。因此这里采用**受控侧车**：

```text
渲染层 ──shell-api──► bridge.ts ──invoke──► Rust 命令 ──NDJSON──► Node 侧车（同一个 domain-runtime）
```

Electron 与 Tauri **共用同一份领域装配**（`apps/desktop-electron/src/main/runtime/bootstrap.ts`），
Rust 只负责三件事：**生命周期**（起停 / 崩溃回收 / 升级兼容）、**协议搬运**、
**宿主能力**（DPAPI / 外链 / 剪贴板 —— 只有外壳能做的事）。

- 实现细节：`src-tauri/src/sidecar/mod.rs`（文件头有完整设计说明）
- 协议：`src-tauri/src/sidecar/protocol.rs`（NDJSON 帧，与 `apps/desktop-electron/src/sidecar/protocol.ts` 逐字对齐）
- 不伪造成功：侧车不可用时每个命令返回**带真实原因**的 `NOT_SUPPORTED`，
  `capabilities()` 的 `ai` / `domain` 来自 `sidecar_status` 的真实装配结果，
  缺失原因经 `ShellCapabilities.reasons` 回传渲染层
- 唯一的结构性差异：`memory` / `pipeline` 的**同步签名端口**在 Tauri 下不注入
  （Tauri 渲染层没有同步 IPC 原语，用异步伪装同步会读到上一拍的数据）。
  两个域本身完全可用，走异步 `domain.invoke`。详见 `docs/CAPABILITY-MATRIX.md §2.1`

## 启动命令

```bash
# 开发（热重载，devUrl 指向渲染层 http://localhost:5173）
pnpm --filter @ec/desktop-tauri dev

# 生产构建（NSIS 安装包，bundle target = nsis）
pnpm --filter @ec/desktop-tauri build

# 类型检查与契约测试
pnpm --filter @ec/desktop-tauri typecheck
pnpm --filter @ec/desktop-tauri test
```

> 说明：`tauri.conf.json` 的 `beforeDevCommand` / `beforeBuildCommand` 依赖 `apps/renderer`
> 提供前端产物（见 Wave 0 其它任务）。首次构建前请确认渲染层已就绪。

### 构建注意事项（本机实测，2026-09-19）

- **NSIS 工具链需预置**：bundler 首次打包会从 GitHub 下载 `nsis-3.11.zip` 与
  `nsis_tauri_utils.dll`，国内网络易超时。可手动下载并解压到 `%LOCALAPPDATA%\tauri\NSIS`
  （`makensis.exe`、`Include/`、`Stubs/`、`Plugins/x86-unicode/additional/nsis_tauri_utils.dll`
  均在该目录根部），bundler 校验 SHA1 后直接复用。
- **updater 签名**：`bundle.createUpdaterArtifacts: true` 且 `plugins.updater.pubkey` 非空时，
  构建要求 `TAURI_SIGNING_PRIVATE_KEY`（CI Secret 注入）。本地无密钥时该步报
  `A public key has been found, but no private key`；**NSIS 安装包此时已产出**，只是没有更新包签名。

## 目录结构

```
src-tauri/
  Cargo.toml             # Tauri 2 + tokio + reqwest + windows(DPAPI) + 各 tauri-plugin-*
  tauri.conf.json        # 窗口 1440x900/最小1024x640、NSIS、updater 占位
  build.rs
  src/
    main.rs lib.rs       # 入口，注册全部命令 + 侧车装配 + RunEvent::Exit 收尾
    error.rs             # CommandError -> {code,message}
    state.rs             # 共享状态（进程表/白名单/监听句柄）
    commands/            # fs/path/dialog/process/secure_store/window/updater/app_info/
                         # clipboard/net/webview2/external + domain.rs（域 RPC）/ ai.rs（AI 控制）
    sidecar/
      mod.rs             # 侧车生命周期：起停、崩溃重启、订阅表、宿主能力应答
      protocol.rs        # NDJSON 帧定义与协议兼容判定（与 TS 侧逐字对齐）
      tests.rs           # 路径安全 / 帧编解码 / 活体握手（真实起 Node 侧车）
src/
  bridge.ts              # ShellHost 实现 + createTauriShell + 注册工厂
  webview2-check.ts      # WebView2 探测与安装引导
  index.ts               # 导出桥接层与探测能力
  __tests__/bridge.test.ts        # 复用 shell-api 契约套件 + 路径语义回归
  __tests__/bridge-sidecar.test.ts # 能力协商 / 域 RPC / 事件订阅 / AI 流式
vitest.config.ts
scripts/
  setup-rust-tauri.ps1     # 官方路径：rustup + MSVC Build Tools（需管理员）
  setup-rust-tauri-gnu.ps1 # 免管理员替代路径（非官方支持，详见「环境要求」）
```

## 安全相关

- **安全存储**：密钥经 Windows **DPAPI**（`CryptProtectData`/`CryptUnprotectData`，当前用户上下文）
  加密，落盘于 `%APPDATA%\EveryoneCoding\secure\<ns>.dat`。切换 Windows 用户或数据损坏会导致解密失败
  （对应 `DECRYPT_FAILED`）。
- **受限网络**：`net.fetch` 默认拒绝所有主机，必须显式 `setAllowedHosts` 放行（OAuth / AI 请求 /
  版本检查）。Rust 与 TS 双层校验。
- **外部链接**：`openExternal` 仅放行 `http(s)://` 与 `mailto:`，经 `cmd /C start` 打开。

## 已知限制

- **构建验证**：`cargo check`、`cargo clippy -- -D warnings`、`cargo build` 与
  `tauri build`（release + NSIS 出包）已在装有 MSVC 的机器上通过；release 产物实机启动渲染正常。
  首轮编译曾修正 20 余处与真实依赖 API 的偏差（windows 0.58 的 `CRYPT_INTEGER_BLOB`/
  `LocalFree` 位置、`AppState::default` 缺失、`dialog_confirm` 按钮语义、`Update.body` 字段名等）。
- **侧车随包分发（发行形态）未做**：开发期侧车用系统 PATH 上的 `node`；
  发行包需要把 `node.exe` + `dist/sidecar/**` 一起放进 `bundle.resources`，
  并且随包的 Node 必须与 `better-sqlite3` 的 Node ABI 同代（当前按 Node 24 / ABI 137 构建）。
  未做这一步之前，**打包产物里的域端口与 AI 栈不可用**（会如实报"未找到侧车产物"）。
- **updater**：端点与公钥在 `tauri.conf.json` 中为占位符，发布前须替换为真实 `pubkey`。
- **fs.watch**：采用轻量轮询实现（约 400ms 粒度），非原生 inotify/ReadDirectoryChangesW。
- **clipboard**：依赖 `tauri-plugin-clipboard-manager`，需确认其 API 与所用版本一致。
- 开源项目：采用 Apache License 2.0，许可文本见仓库根目录 `LICENSE`。
