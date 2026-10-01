# 开发环境搭建（DEV-SETUP）

> 本文档面向 EveryoneCoding 的开发者。本项目以 **Apache License 2.0** 开源，仓库地址见 README。

## 1. 环境要求

| 依赖                                  | 版本                                  | 用途                                 | 本机状态（2026-09-30）                                         |
| ------------------------------------- | ------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| Node.js                               | ≥ 22                                  | 构建 / Electron 主进程 / 测试        | ✅ v24.21.0                                                    |
| pnpm                                  | ≥ 9（`packageManager` 已锁定 9.15.9） | monorepo 包管理                      | ✅ 9.15.9（corepack）                                          |
| Rust 工具链（stable）                 | ≥ 1.77                                | 仅构建 Tauri 外壳时需要              | ✅ 1.98.1（用户级安装，`x86_64-pc-windows-gnu`）               |
| MSVC C++ 生成工具 + Windows 10/11 SDK | 最新                                  | Tauri 与原生模块编译                 | ❌ 未安装（需管理员，见 §2.3；免管理员替代路径已验证部分可用） |
| WebView2 Runtime                      | 常青版                                | Tauri 版渲染（缺失时应用内引导安装） | ✅ 154.0.4258.48                                               |
| Git                                   | ≥ 2.40                                | 仓库管理                             | ✅ 已就位                                                      |
| Electron 运行时二进制                 | 33.4.11                               | Electron 版外壳                      | ⚠️ 见 §2.1（`pnpm install` 时被 build script 策略拦下需补装）  |

## 2. 安装依赖

```bash
pnpm install
```

说明：

- 根 `package.json` 的 `pnpm.onlyBuiltDependencies` 仅允许 `better-sqlite3`、`esbuild` 执行安装脚本；
  `electron` 的二进制下载默认被跳过（见 §2.1）。
- 所有包以**源码方式**互相引用（`"main": "./src/index.ts"`），无需先构建依赖包。

### 2.1 Electron 形态的前置条件

Electron 形态除了 `pnpm install` 外还需要两样东西，两者都**不需要管理员权限**：

1. **Electron 运行时二进制**（约 100 MB）。官方包的 `install.js` 被 pnpm 的 build script 策略拦截，
   默认不下载，表现为 `apps/desktop-electron/node_modules/electron/dist` 不存在。补齐方式：

   ```bash
   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm rebuild electron
   ```

2. **better-sqlite3 的 Electron ABI 绑定**。这是 ABI 相关的原生模块：Node 侧（vitest）用的是
   Node ABI，而 Electron 内置 Node 版本不同（Electron 33 → Node 20.18 → ABI 130），两者不能共用
   同一份 `.node`。仓库的做法是**两套共存、互不影响**：

   | 使用方                       | 绑定位置                                                                       |
   | ---------------------------- | ------------------------------------------------------------------------------ |
   | Node 侧（vitest / 各包单测） | `node_modules/.pnpm/better-sqlite3@<版本>/…/build/Release/better_sqlite3.node` |
   | Electron 主进程              | `apps/desktop-electron/build/Release/better_sqlite3.node`                      |

   > 为什么是后者：esbuild 会把 better-sqlite3 的 JS 内联进主进程产物，`bindings` 的
   > `module_root` 因此解析为应用根目录，该路径正是它的候选之一。
   > **切勿**用 Electron 版覆盖 `.pnpm` 下那份 —— 会连带弄坏全仓单测基线。

   该绑定由脚本自动准备（幂等，已就绪则跳过）：

   ```bash
   pnpm --filter @ec/desktop-electron prepare:native
   ```

   脚本会以 `ELECTRON_RUN_AS_NODE=1 electron -p process.versions.modules` **动态探测 ABI**（不硬编码
   版本映射表），再从 npmmirror 拉取对应预编译包（失败回退 GitHub releases），解压到上述位置。
   升级 Electron 后 ABI 变化会被自动识别并重新获取。

### 2.2 启动 Electron 形态

```bash
# 终端 1：渲染层（Electron 主进程会加载 http://localhost:5173）
pnpm dev:renderer

# 终端 2：桌面外壳（自动完成原生绑定准备 + 主进程构建 + 启动）
pnpm dev:electron
```

`pnpm dev:electron` 走 `apps/desktop-electron/scripts/dev.mjs`，它额外处理两个环境坑：

- **`ELECTRON_RUN_AS_NODE` 污染**：在 WorkBuddy / VS Code 等自身基于 Electron 的宿主终端里，
  环境可能带有 `ELECTRON_RUN_AS_NODE=1`。该变量会让 `electron.exe` 退化成纯 Node 进程
  （`require('electron')` 只返回包路径字符串、`app` 为 `undefined`，主进程启动即崩）。
  脚本会在启动子进程前移除它。
- **无 GPU 的宿主环境**：此类嵌入宿主常无 GPU 访问权限，Electron 的 GPU 进程会反复崩溃并以
  `GPU process isn't usable. Goodbye.` 退出。检测到该场景时自动改用软件渲染。
  可用 `EC_ELECTRON_HEADLESS=1` 强制启用，或用 `EC_ELECTRON_FLAGS` 追加自定义 Chromium 开关。

数据落点：`%APPDATA%\@ec\desktop-electron\data\everyonecoding.sqlite`（迁移在首次启动时自动执行）。

### 2.3 Tauri 形态的前置条件

**官方路径（需管理员）**：Tauri 侧需要 **Rust 工具链 + MSVC C++ 生成工具**，且这两者必须一起装：

- Tauri 在 Windows 上唯一官方支持的链接器是 MSVC 的 `link.exe`（来自 VS Build Tools）；
- Rust 工具链本身可装到用户目录，但**没有 `link.exe` 时连 `cargo check` 都跑不起来**
  （build script 与 proc-macro 的编译同样需要链接）。

安装 VS Build Tools 要写 `Program Files` 与注册表，**必须管理员权限**。已备好一键脚本：

```powershell
# 右键「以管理员身份运行 PowerShell」
powershell -ExecutionPolicy Bypass -File apps\desktop-tauri\scripts\setup-rust-tauri.ps1

# 仅体检、不做任何改动（可在普通会话里跑）
powershell -ExecutionPolicy Bypass -File apps\desktop-tauri\scripts\setup-rust-tauri.ps1 -CheckOnly
```

脚本做的事：体检（windbg/vswhere/rustup/cargo）→ 安装 VS 2022 Build Tools 的 VCTools 工作负载
→ 安装 rustup（走清华 TUNA 镜像）→ 写入 `~/.cargo/config.toml` 的 crates 国内镜像
→ 打印后续 `cargo check` / `cargo clippy` / `pnpm build:tauri` 命令。
可选开关：`-SkipBuildTools`（已有 VS 时）、`-NoMirror`（不写镜像）、`-CheckOnly`。

装完后的验收口径见 `docs/ACCEPTANCE-REPORT.md` 的 L-09（含 `cargo clippy --all-targets -- -D warnings`）。

**免管理员替代路径（`x86_64-pc-windows-gnu` + Zig，Tauri 官方未支持，已实测部分可用）**：
在拿不到管理员权限时用 rustup 的 GNU 工具链（自带 rust-mingw 的 mingw-w64 CRT）配合 Zig
提供的 C 编译器 / `dlltool` / `windres`，链接交给 rustc 自带的 `rust-lld`：

```powershell
powershell -ExecutionPolicy Bypass -File apps\desktop-tauri\scripts\setup-rust-tauri-gnu.ps1
# 生成 env 与门禁命令；加 -RunGates 会直接跑 cargo check + clippy
```

实测结论（2026-09-30，见 `docs/ACCEPTANCE-REPORT.md §2.11.8`）：

| 命令                                                | 结果                                                        |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `cargo check --locked`                              | ✅ 通过                                                     |
| `cargo clippy --all-targets -- -D warnings`         | ✅ 通过                                                     |
| `cargo build --locked` + 启动 `everyone-coding.exe` | ✅ 窗口起来、侧车随启动建库（34 表）                        |
| `cargo test`（执行单测）                            | ❌ 测试二进制以 `STATUS_ENTRYPOINT_NOT_FOUND` 退出，需 MSVC |

> 也就是说：**调试 / 冒烟可以用这条路径，跑 Rust 单测仍然要 MSVC。**
> 该路径下 `pnpm build:tauri` 未验证（NSIS bundler 与 Tauri 官方只保证 MSVC）。

## 3. 常用命令

| 命令                                  | 作用                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm dev:renderer`                   | 启动渲染层 dev server（http://localhost:5173，mock 外壳）                                          |
| `pnpm dev:tauri`                      | 启动 Tauri 2 桌面外壳（需要 Rust 工具链）                                                          |
| `pnpm dev:electron`                   | 构建 main/preload 并启动 Electron 外壳（自动准备原生绑定，见 §2.1/§2.2）                           |
| `pnpm build:renderer`                 | 构建渲染层产物（`apps/renderer/dist`）                                                             |
| `pnpm build:tauri`                    | 产出 Tauri NSIS 安装包                                                                             |
| `pnpm build:electron`                 | 产出 Electron NSIS 安装包                                                                          |
| `pnpm typecheck`                      | 全仓库 TypeScript strict 类型检查（`pnpm -r typecheck`）                                           |
| `pnpm test`                           | 全仓库单元测试（Vitest，`pnpm -r test`）                                                           |
| `pnpm test:coverage`                  | 覆盖率（核心模块门禁 ≥ 70%）                                                                       |
| `pnpm test:e2e`                       | 完整 E2E 套件（独立工程 `e2e/`；2026-10-01 为 14 文件/55 项，含真实 Electron E2E-26，前置见 §3.1） |
| `pnpm quality-gate`                   | 六核心模块逐模块覆盖率门禁（≥70%，低于即失败）                                                     |
| `pnpm perf`                           | 性能基准（7 项可复现基准，结果写 `perf/last-run.md`）                                              |
| `pnpm version:check` / `version:sync` | 校验 / 同步双形态版本号（单一事实源在根 `package.json`）                                           |
| `pnpm release:manifest`               | 生成发布清单与分发页（含体积门禁）                                                                 |
| `pnpm lint` / `pnpm format`           | ESLint / Prettier                                                                                  |

### 3.1 Electron 流水线端到端测试

E2E-26 会启动实际 Electron，并使用其专用 SQLite 原生绑定。先完成 §2.1 的 Electron 二进制准备，
再在仓库根执行以下命令；无需预先启动 Vite dev server 或打开用户工作区。

```bash
pnpm --filter @ec/desktop-electron prepare:native
pnpm test:e2e --no-file-parallelism e2e-26-electron-pipeline
```

完整验收命令为 `pnpm test:e2e --no-file-parallelism`。测试自行构建主进程/preload/页面测试入口，
创建 `apps/desktop-electron/.tmp-pipeline-e2e-*`，在两个进程中复用其中的测试数据库与项目，结束后清理。
BrowserWindow 隐藏运行；生产 preload、IPC、PipelinePage、领域实现和磁盘写入均参与，外部 AI 网关使用确定性回复。
它不需要用户 API Key，也不修改用户数据、默认项目目录或发布安装包。

原生绑定缺失时先运行 `prepare:native`；不要把 Node 单测的 `.node` 文件复制给 Electron。
本机此次测试使用 Node v24.21.0。若同一环境的 pnpm shim 报 `NVM4306`，先确认所用 pnpm 的来源和路径；
本次执行记录使用已安装的 pnpm 9.15.9 入口运行同名命令，例如在 PowerShell 中：

```powershell
node "$env:LOCALAPPDATA/node/corepack/v1/pnpm/9.15.9/bin/pnpm.cjs" test:e2e --no-file-parallelism
```

此路径是本机环境记录，不是仓库对所有开发机的目录要求。结果与测试边界见
[TEST-REPORT §5.2](TEST-REPORT.md#52-t12-03-生产运行时复验2026-10-01)。

### 3.2 文档 AI 摘要、图片 OCR 与账号联调

本节于 2026-10-01 同步代码现状；自动化记录见 [测试报告 §5.3](TEST-REPORT.md#53-wave-9-文档与账号复核2026-09-30)。

**图片 OCR**：Windows 使用系统 `Windows.Media.Ocr`，不需随应用分发第三方 OCR 二进制。
PowerShell 必须可启动，且系统已安装对应 OCR 识别语言；以导入面板的实际检测结果为准。
Windows 设置 → 时间和语言 → 语言和区域 → 添加语言，检查该语言的“光学字符识别”组件；
安装后重新打开导入对话框。选“图片”后会列出本机已装语言；不可用时给出原因并禁用导入。
`zh-CN` 可对齐 `zh-Hans-CN`，简体/繁体不会互相替代。非 Windows 返回不可用提示。

```powershell
# 可用性探测之外，还实际生成图片、识别并检索；缺环境时会跳过并说明原因
node node_modules/vitest/vitest.mjs run --no-file-parallelism packages/core/src/docs/__tests__/windows-ocr.integration.test.ts
```

导入后在文档中心搜索图片文字，点击“正文命中”定位段落，再点“转为记忆”。在“设置 → 模型”配置
可用 Provider、Key 与模型，并确认 `memory-extract` 用途有可用模型。摘要生成成功后可编辑提交，
来源文档及段落锚点会保留。AI 请求失败或输出为空会显示错误；扫描件 PDF 无文字时需导出页面图片再导入。

**邮箱联调**：另开终端执行 `pnpm --filter @ec/account-service dev`（默认端口 3000）。
默认不配置 `ACCOUNT_MAIL_WEBHOOK_URL`，邮件进入本地 outbox；验证链接默认由服务的 `/verify-email`
页面承载。完整步骤与部署限制见 [账号服务 README](../services/account/README.md#开发环境完整操作)。

**Electron OAuth**：服务端凭据使用 `ACCOUNT_OAUTH_<GOOGLE|GITHUB|WECHAT>_ID/SECRET/REDIRECT`。
客户端的通道设置如下，须在启动 Electron 的终端设置；回调地址还必须满足对应提供方的应用注册规则。

| 客户端变量               | 默认行为                   | 用途                                                                                   |
| ------------------------ | -------------------------- | -------------------------------------------------------------------------------------- |
| `EC_OAUTH_LOOPBACK_PORT` | 随机空闲端口               | 设为 1024–65535 的整数可固定监听端口；非法值退回随机端口；用于白名单或端口冲突回退验收 |
| `EC_OAUTH_CHANNEL`       | 先回环，监听失败才回退协议 | `protocol` 显式跳过回环；协议须由 OS 注册并能拉起应用。正常验收应先不设置此覆盖值      |

回环地址为 `http://127.0.0.1:<端口>/oauth/callback`，协议为 `everyonecoding://oauth`。
固定端口被占用可验证真实监听失败回退；state 不匹配不换令牌，已消费回调不能重放。
手工验收见 [E2E 清单 M-01/M-02/M-08](E2E-CHECKLIST.md)。

## 4. 目录约定

```
everyoneCoding/
├── apps/
│   ├── desktop-tauri/     # Tauri 2 外壳（src-tauri/ 为 Rust，src/ 为 TS 桥接层）
│   ├── desktop-electron/  # Electron 外壳（main / preload / bridge）
│   └── renderer/          # React 渲染层（双形态共用）
├── packages/
│   ├── shell-api/         # 外壳抽象接口 + 工厂 + Mock（含契约测试套件）
│   ├── core/              # 事件总线 / 命令 / 撤销重做 / 崩溃恢复 / 设置 / 日志 / 文件服务
│   ├── data/              # SQLite 迁移框架 + DAO + FTS5/vec 扩展 + 全量 DDL + 种子
│   └── ui/                # 设计令牌 + 29 个自建组件（虚拟化 Tree/Table/List）
└── docs/
```

跨包引用只允许走 `@ec/<包名>` 单一入口，禁止深路径导入。

## 5. 外壳抽象（双形态并存，决策 D-01）

渲染层启动时调用 `createShell()`：

1. 环境探测（`detectShellKind`）：Tauri → Electron → mock；
2. Tauri / Electron 各自在启动时 `registerShellFactory(kind, factory)` 注册实现；
3. `negotiate(shell)` 返回能力协商结果，缺失能力**降级而非报错**；
4. 契约测试：`packages/shell-api` 的 `runShellContract` 对 Mock / Tauri 桥接层 / Electron 桥接层
   跑**同一套用例**（fs 原子写、进程流、secureStore、受限网络等）。

新增外壳能力时：先改 `packages/shell-api/src/types.ts`，再同步三处实现与契约用例。

## 6. 数据层

- 迁移文件：`packages/data/migrations/*.sql`（`-- up` / `-- down` 段，事务化执行、失败回滚、幂等）；
- 连接：WAL + busy_timeout + foreign_keys ON；
- FTS5 不可用时关键词检索自动退化为 LIKE 并告警；sqlite-vec 不可用时语义检索关闭；
- 纯 DAO 测试可使用 `DataClient.open()`（`:memory:`）；主进程集成和 Electron E2E 使用独立临时目录中的真实 SQLite，不得触碰用户数据目录。
- 流水线迁移 `0007_pipeline_checkpoint.sql` 在业务库打开时自动执行，新增 checkpoint 与提交回执表。
  新 checkpoint 存在时以数据库为准；旧快照可导入。恢复日志位于 `<dataDir>/pipeline-transactions/`，
  其清理由运行时依据提交回执完成，排查问题时不要把删除日志当成恢复手段。
- 文档在 `<project>/docs/`，版本产物在 `<project>/pipeline/`，S4 当前拆分在 `pipeline/S4/split.json`；
  S5 代码经 `resolveCodeRoot()` 使用已有代码根登记，未登记时使用 `<project>/code`。

## 7. 安全基线（违反即返工）

- 明文密钥只允许经 `ShellHost.secureStore`（DPAPI）写入；
- 日志与导出必须经过 `@ec/core` 的 `mask / maskObject` 脱敏；
- 渲染层禁止出现 `require` / Node 全局（Electron preload 有白名单审计测试）；
- 写文件一律 `writeAtomic`（临时文件 + fsync + rename）。

## 8. 提交规范

Conventional Commits（`feat: ...` / `fix: ...` / `refactor: ...`），提交前确保
`pnpm lint && pnpm typecheck && pnpm test` 全绿。
