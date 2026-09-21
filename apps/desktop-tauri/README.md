# @ec/desktop-tauri

EveryoneCoding 的 **Tauri 2 外壳（Rust 命令 + TypeScript 桥接层）**。

本包把 `packages/shell-api` 定义的 `ShellHost` 接口落地为 Rust 命令（`src-tauri/`）与
TypeScript 桥接层（`src/bridge.ts`）。渲染层只依赖 `@ec/shell-api`，**禁止**直接 `import`
任何 `@tauri-apps/*`（桥接层是唯一授权边界）。

## 环境要求

- **Rust 工具链**：stable ≥ 1.77（`rustup toolchain install stable`）；Windows 上请安装
  MSVC 宿主工具链（`x86_64-pc-windows-msvc`）。本机已装：`rustc 1.98.1`。
- **MSVC 生成工具**：Visual Studio 2022 的「使用 C++ 的桌面开发」工作负载
  （或 VS Build Tools 的 `Microsoft.VisualStudio.Workload.VCTools` + Windows 11 SDK）
- **Windows 10 / 11 SDK**
- **WebView2 运行时**：Evergreen 版（[下载](https://go.microsoft.com/fwlink/p/?LinkId=2124703)）；
  缺失时应用启动会经 `webview2-check.ts` 渲染安装引导，不会白屏
- **Node.js** ≥ 18 与 pnpm（workspace 根）

> 一键脚本：`scripts/setup-rust-tauri.ps1`（需管理员）可完成 rustup + VS Build Tools 安装与环境体检。

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
    main.rs lib.rs       # 入口，注册全部命令
    error.rs             # CommandError -> {code,message}
    state.rs             # 共享状态（进程表/白名单/监听句柄）
    commands/            # fs/path/dialog/process/secure_store/window/updater/app_info/clipboard/net/webview2/external
src/
  bridge.ts              # ShellHost 实现 + createTauriShell + 注册工厂
  webview2-check.ts      # WebView2 探测与安装引导
  index.ts               # 导出桥接层与探测能力
  __tests__/bridge.test.ts  # 复用 shell-api 契约套件
vitest.config.ts
```

## 安全相关

- **安全存储**：密钥经 Windows **DPAPI**（`CryptProtectData`/`CryptUnprotectData`，当前用户上下文）
  加密，落盘于 `%APPDATA%\EveryoneCoding\secure\<ns>.dat`。切换 Windows 用户或数据损坏会导致解密失败
  （对应 `DECRYPT_FAILED`）。
- **受限网络**：`net.fetch` 默认拒绝所有主机，必须显式 `setAllowedHosts` 放行（OAuth / AI 请求 /
  版本检查）。Rust 与 TS 双层校验。
- **外部链接**：`openExternal` 仅放行 `http(s)://` 与 `mailto:`，经 `cmd /C start` 打开。

## 已知限制

- **构建验证已闭环（2026-09-19）**：`cargo check`、`cargo clippy -- -D warnings`、
  `cargo build`、`tauri build`（release + NSIS 出包）全部通过，release 产物实机启动渲染正常。
  首轮编译曾修正 20 余处与真实依赖 API 的偏差（windows 0.58 的 `CRYPT_INTEGER_BLOB`/
  `LocalFree` 位置、`AppState::default` 缺失、`dialog_confirm` 按钮语义、`Update.body` 字段名等）。
- **updater**：端点与公钥在 `tauri.conf.json` 中为占位符，发布前须替换为真实 `pubkey`。
- **fs.watch**：采用轻量轮询实现（约 400ms 粒度），非原生 inotify/ReadDirectoryChangesW。
- **clipboard**：依赖 `tauri-plugin-clipboard-manager`，需确认其 API 与所用版本一致。
- **域端口 / AI 栈未接入**：`bridge.ts` 的 `domain` 与 `ai` 如实返回 `NOT_SUPPORTED`，
  `capabilities()` 对应报 `false`（四域 69 个方法目前只在 Electron 形态可用）。
- 开源项目：采用 Apache License 2.0，许可文本见仓库根目录 `LICENSE`。
