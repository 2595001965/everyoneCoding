# 开发环境搭建（DEV-SETUP）

> 本文档面向 EveryoneCoding 的开发者。本项目以 **Apache License 2.0** 开源，仓库地址见 README。

## 1. 环境要求

| 依赖 | 版本 | 用途 | 本机状态（2026-09-15） |
| --- | --- | --- | --- |
| Node.js | ≥ 22 | 构建 / Electron 主进程 / 测试 | ✅ v24.20.0 / v22.22.2 |
| pnpm | ≥ 9（`packageManager` 已锁定 9.15.9） | monorepo 包管理 | ✅ 经 corepack 调用 |
| Rust 工具链（stable） | ≥ 1.77 | 仅构建 Tauri 外壳时需要 | ❌ 未安装（需管理员，见 §2.3） |
| MSVC C++ 生成工具 + Windows 10/11 SDK | 最新 | Tauri 与原生模块编译 | ❌ 未安装（需管理员，见 §2.3） |
| WebView2 Runtime | 常青版 | Tauri 版渲染（缺失时应用内引导安装） | ✅ 152.0.4191.66 |
| Git | ≥ 2.40 | 仓库管理 | ✅ 2.55.0 |
| Electron 运行时二进制 | 33.4.11 | Electron 版外壳 | ✅ 已就位（见 §2.1） |

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

   | 使用方 | 绑定位置 |
   | --- | --- |
   | Node 侧（vitest / 各包单测） | `node_modules/.pnpm/better-sqlite3@<版本>/…/build/Release/better_sqlite3.node` |
   | Electron 主进程 | `apps/desktop-electron/build/Release/better_sqlite3.node` |

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

### 2.3 Tauri 形态的前置条件（需管理员权限）

Tauri 侧需要 **Rust 工具链 + MSVC C++ 生成工具**，且这两者必须一起装：

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

> **替代路径（免管理员，非官方支持）**：装便携版 MinGW-w64 并改用
> `x86_64-pc-windows-gnu` 工具链。Tauri 官方未支持该组合，构建可能失败，
> 仅在确实无法取得管理员权限时考虑。

装完后的验收口径见 `docs/ACCEPTANCE-REPORT.md` 的 L-09（含 `cargo clippy --all-targets -- -D warnings`）。

## 3. 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:renderer` | 启动渲染层 dev server（http://localhost:5173，mock 外壳） |
| `pnpm dev:tauri` | 启动 Tauri 2 桌面外壳（需要 Rust 工具链） |
| `pnpm dev:electron` | 构建 main/preload 并启动 Electron 外壳（自动准备原生绑定，见 §2.1/§2.2） |
| `pnpm build:renderer` | 构建渲染层产物（`apps/renderer/dist`） |
| `pnpm build:tauri` | 产出 Tauri NSIS 安装包 |
| `pnpm build:electron` | 产出 Electron NSIS 安装包 |
| `pnpm typecheck` | 全仓库 TypeScript strict 类型检查（`pnpm -r typecheck`） |
| `pnpm test` | 全仓库单元测试（Vitest，`pnpm -r test`） |
| `pnpm test:coverage` | 覆盖率（核心模块门禁 ≥ 70%） |
| `pnpm test:e2e` | 21 条 E2E 验收用例（独立工程 `e2e/`，见 `docs/E2E-CHECKLIST.md`） |
| `pnpm quality-gate` | 六核心模块逐模块覆盖率门禁（≥70%，低于即失败） |
| `pnpm perf` | 性能基准（7 项可复现基准，结果写 `perf/last-run.md`） |
| `pnpm version:check` / `version:sync` | 校验 / 同步双形态版本号（单一事实源在根 `package.json`） |
| `pnpm release:manifest` | 生成发布清单与分发页（含体积门禁） |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |

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
- 测试一律用 `DataClient.open()`（`:memory:`），不要触碰真实数据目录。

## 7. 安全基线（违反即返工）

- 明文密钥只允许经 `ShellHost.secureStore`（DPAPI）写入；
- 日志与导出必须经过 `@ec/core` 的 `mask / maskObject` 脱敏；
- 渲染层禁止出现 `require` / Node 全局（Electron preload 有白名单审计测试）；
- 写文件一律 `writeAtomic`（临时文件 + fsync + rename）。

## 8. 提交规范

Conventional Commits（`feat: ...` / `fix: ...` / `refactor: ...`），提交前确保
`pnpm lint && pnpm typecheck && pnpm test` 全绿。
