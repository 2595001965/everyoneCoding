# EveryoneCoding 双形态能力矩阵（CAPABILITY-MATRIX）

> 对应 D-01「Tauri 2 与 Electron 双形态并存，功能层通过外壳抽象隔离，**两版功能等价**」。
> 本文件是**唯一的能力事实源**：每一条都指向代码里的判据，不靠人记。
> 关联：`docs/ACCEPTANCE-REPORT.md`（验收证据）、`docs/RELEASE.md`（打包分发）、
> `docs/DEV-SETUP.md`（工具链前置）。

---

## 0. 怎么自己拿到最新答案（别读文档，去问程序）

三条命令，任选：

```bash
# ① 渲染层视角：外壳能力 + 缺失原因（ShellCapabilities.reasons）
#    在应用内打开 DevTools 执行：
await (await window.__EC_SHELL__).capabilities()      # 端口注入后可直接取

# ② 域装配视角：15 个域逐个可用性与原因
await (await window.__EC_SHELL__).domain.describe()

# ③ Tauri 形态的侧车诊断（Rust 命令）：就绪状态 + 产物/Node 位置 + 协议版本
```

第 ③ 条在 Tauri 形态下对应 `sidecar_status` 命令；它同时返回侧车入口与 Node 运行时的
实际路径，是排"侧车起不来"的第一现场。

**纪律**：任何能力为 `false` 时都必须带**真实原因**（`ShellCapabilities.reasons` /
`DomainDescriptor.reason`）。不带原因的 `false` 视为缺陷——用户无从判断是"还没做"、
"这台机器缺东西"还是"自己关掉了"。

### 0.1 最近一次实机复核（2026-09-30）

在一台**没有 MSVC、没有管理员权限**的 Windows 机器上复跑了 Tauri 形态（`x86_64-pc-windows-gnu`

- Zig 顶替 C 工具链，脚本 `apps/desktop-tauri/scripts/setup-rust-tauri-gnu.ps1`）：

| 观测项                                      | 结果                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `cargo check --locked`                      | ✅ 退出码 0                                                                                                   |
| `cargo clippy --all-targets -- -D warnings` | ✅ 退出码 0                                                                                                   |
| `cargo build --locked`                      | ✅ 退出码 0                                                                                                   |
| **真实启动 `everyone-coding.exe`**          | ✅ 窗口标题 `EveryoneCoding`、`Responding=True`、WebView2 子进程就位                                          |
| **侧车随应用启动**                          | ✅ `node ...\dist\sidecar\everyone-coding-sidecar.cjs` 成为子进程                                             |
| **侧车真实建库**                            | ✅ `%APPDATA%\com.everyonecoding.desktop\data\everyonecoding.sqlite`：34 张表、6 个迁移、FTS 表、1 行本地用户 |
| **宿主强杀后无孤儿**                        | ✅ 宿主被强杀后 6 秒内 `node.exe` 归零（侧车读 stdin EOF 自退）                                               |
| **宿主优雅关闭（关窗口）**                  | ✅ 关窗后 5 秒内宿主退出、侧车进程树归零。**首轮跑是红的**（关窗永久挂死，已修，见 §2.11.8 的 2.1）           |
| `cargo test`（执行 Rust 单测）              | ⚠️ 见 §4「本机无法执行的部分」——产物可链接，但测试二进制无法启动                                              |

> 这一节证明的是**链路上真的通了**（Rust → 侧车 → SQLite），而不仅是单测断言层面成立。
> 域方法的逐条覆盖仍以 `apps/desktop-electron/src/sidecar/__tests__/sidecar-service.test.ts`
> 的"四域 69 方法逐条真实分发"为准（该用例在本轮也复跑通过）。
> 另外，这一轮真机走查**发现并修掉了一个 P0 死锁**（关窗口永不退出）——正是"必须真跑一次"的价值所在。

---

## 1. 外壳级能力

| 能力           | Electron | Tauri 2 | Tauri 实现落点                                          | 说明                                                      |
| -------------- | -------- | ------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `fs`           | ✅       | ✅      | `commands/fs.rs`                                        | 含原子写（临时文件 → fsync → rename）                     |
| `watch`        | ✅       | ✅      | `commands/fs.rs` 轮询线程 + Channel                     | 轮询而非 `fs.watch`：见 `commands/fs.rs` 文件头           |
| `process`      | ✅       | ✅      | `commands/process.rs`                                   | 通用子进程端口（渲染层直连）                              |
| `dialog`       | ✅       | ✅      | `commands/dialog.rs`（tauri-plugin-dialog）             |                                                           |
| `window`       | ✅       | ✅      | `commands/window.rs`                                    |                                                           |
| `secureStore`  | ✅       | ✅      | `commands/secure_store.rs`（DPAPI，当前用户上下文）     | 磁盘上只有密文；不可用时**拒绝**而不是落明文              |
| `updater`      | ✅       | ✅      | `commands/updater.rs`（tauri-plugin-updater，minisign） | 需先替换 `tauri.conf.json` 的 `pubkey`（见 RELEASE §3.2） |
| `net`          | ✅       | ✅      | `commands/net.rs`（host 白名单）                        | 白名单外一律 `NET_BLOCKED`                                |
| `clipboard`    | ✅       | ✅      | `commands/clipboard.rs`                                 |                                                           |
| `openExternal` | ✅       | ✅      | `commands/external.rs`                                  | 仅放行 http/https/mailto（防 cmd 注入）                   |
| `ai`           | ✅       | ✅      | **侧车**（`@ec/ai` 真实栈）→ `commands/ai.rs` 搬运      | 见 §3                                                     |
| `domain`       | ✅       | ✅      | **侧车**（15 个域运行时）→ `commands/domain.rs` 搬运    | 见 §2                                                     |

---

## 2. 领域端口（15 个域）

两形态**共用同一份领域实现**：Electron 直接跑在 Node 主进程里；Tauri 把同一份代码放进
**受控侧车**（`apps/desktop-electron/src/sidecar/`），由 Rust 负责生命周期与协议搬运。

```text
Electron:  渲染层 → preload → ipcMain → domain-runtime（Node 主进程）
Tauri:     渲染层 → invoke  → Rust   → NDJSON → 侧车（同一个 domain-runtime）
```

| 域           | Electron | Tauri | 备注                                                                                                          |
| ------------ | -------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| `workspace`  | ✅       | ✅    | 19 个方法全通（含从 Git 导入的三阶段进度事件）                                                                |
| `docs`       | ✅       | ✅    | 22 个 RPC 方法，含 `ocrStatus` / `searchDocuments`；运行前置见 §2.2                                           |
| `auth`       | ✅       | ✅    | **前置**：须宿主 DPAPI 可用，否则整个域不装配并给出原因                                                       |
| `settings`   | ✅       | ✅    | 16 个方法全通                                                                                                 |
| `memory`     | ✅       | ✅    | 异步口全通；**同步签名端口见 §2.1**                                                                           |
| `pipeline`   | ✅       | ✅    | Electron 主进程事务、队列恢复和真实 UI/IPC 已验收（§2.3）；Tauri 同步页面限制见 §2.1，本次未复验 Tauri 客户端 |
| `git`        | ✅       | ✅    | 凭据类方法前置同 `auth`；AI 类方法前置同 §3                                                                   |
| `preview`    | ✅       | ✅    | 后端托管经受控进程端口，`cwd` 必须落在工程根内（否则 `PATH_ESCAPE`）                                          |
| `rename`     | ✅       | ✅    |                                                                                                               |
| `package`    | ✅       | ✅    | 归档 / 备份 / 快照；`.ecpkg` 平坦布局与命名规范两形态一致                                                     |
| `usage`      | ✅       | ✅    | 预算变更即时回灌运行中的网关                                                                                  |
| `ai-context` | ✅       | ✅    | 四源组装（memory / notes / documents / code）                                                                 |
| `code`       | ✅       | ✅    | 写入只有一条路：`plan → preview → apply`                                                                      |
| `nav`        | ✅       | ✅    | 跳转 / 反查 / 关系图                                                                                          |
| `designer`   | ✅       | ✅    | PageDSL；`createPage` 走 `@ec/designer/dsl` 的 `createEmptyPage`                                              |

### 2.1 Memory / Pipeline 的异步渲染端口

`MemoryApi` 与 `PipelineApi` 已转换为 Promise 契约，Electron 与 Tauri 都经异步
`domain.invoke` 调用同一领域实现。页面在写入完成后重读 SQLite 权威状态；Tauri 不需要也不伪造
同步 IPC。`ready.syncDomains` 仅描述领域内仍有同步实现的兼容信息，不再阻止异步页面注入。

---

### 2.2 文档 OCR、摘要与账号的运行前置（2026-10-01 同步）

当前 RPC 白名单以 `packages/shell-api/src/domain-control.ts` 为准：workspace 19、docs 22、auth 19、
settings 16，合计 76；上文历史记录中的“四域 69 方法”是此前版本的统计。

| 能力                | 当前实现                                                                                                                                                           | 已验证与限制                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 图片 OCR            | 共用 docs 域通过隐藏的 PowerShell 子进程调用 Windows.Media.Ocr；语言列表来自 `ocrStatus`，缺引擎/语言有安装提示                                                    | 9 月 30 日本机 `zh-Hans-CN` 真机识别、入库、搜索通过；不等同于双形态安装包逐一识别验收；非 Windows 不可用    |
| 文档全文搜索        | `searchDocuments(projectId, query)` 按标题/段落匹配，返回锚点与片段；renderer 点击定位，转换范围预选命中段                                                         | OCR 文字与普通正文同样可搜，排除回收站；目前逐段扫描，未做大库索引性能验收                                   |
| 文档转记忆          | 配置的 AI 网关以 `memory-extract` 生成预览；提交保存编辑后的草稿和来源关联；缺配置、空输出或流错误如实失败                                                         | 自动化使用模拟网关；真实模型质量仍需 M-08                                                                    |
| 邮箱验证 / 找回密码 | account 服务自托管验证页面；随机令牌校验、单次消费、过期拒绝、发送冷却与开发 outbox 已实现                                                                         | 无需再扩展邮箱接口；真实送达需邮件 webhook。当前允许未验证账号登录，M-01 验证完整操作与送达时间              |
| OAuth 自定义协议    | Electron 经单实例桥接；Tauri Deep Link + single-instance 插件将 URL 投递给共享 auth 域，按 state 一次性完成握手；默认回环失败才回退，支持 `EC_OAUTH_LOOPBACK_PORT` | Electron 回环/协议测试与共享 auth state 路由测试通过；Tauri Rust 插件尚未在本机编译/OS 实测；真实授权见 M-02 |

证据及历史门禁数字见 [验收报告 §2.12.5](ACCEPTANCE-REPORT.md#2125-复核补缺与验收边界2026-09-30)。

---

### 2.3 Electron 流水线生产运行时（2026-10-01）

| 能力       | 事实源与边界                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 持久化     | `domain/pipeline-persistence.ts` + 迁移 `0007_pipeline_checkpoint.sql`：阶段状态、activeVersion、stale、原始需求、S5 断点/契约保存到 SQLite checkpoint；阶段文件与台账一起提交，日志/提交回执处理崩溃边界 |
| 阶段产物   | S1/S3/S4 由主进程一次生成并提交待确认；S2 `captureDesign` 固化真实 DSL；S6/S7 为版本化报告；历史读取、diff、版本切换及下游 stale 经生产端口完成                                                           |
| 技术选型   | 问卷结果写项目记忆；`advance`、`startStage`、`generateTechDoc` 均检查已保存的 TechChoice                                                                                                                  |
| S5 队列    | `runGeneration` / `retryNode` / `skipNode` 为异步；`getQueueState` / `pauseQueue` / `getResumeProgress` 可同步调用；节点失败隔离、暂停/退出后恢复已验证                                                   |
| 代码与构建 | 代码经共享 code 域 `WritePipeline` 写入官方代码根；构建端口接收本次候选文件，在临时目录校验并返回修复版；不将测试中的 Web 夹具当作七端编译实测                                                            |
| 跨进程事件 | `pipeline:stage-event` / `pipeline:progress` 带 projectId，经 `ec:domain:event` 进入 renderer；项目切换会重建页面会话                                                                                     |
| 验收范围   | 主进程 12 项 + 事务 3 项通过；E2E-26 用两个实际 Electron 进程验证 UI/IPC 重启续跑。仅 AI 网关为确定性替身；不代表安装包、真实模型或 Tauri 页面复验                                                        |

完整证据见 [ACCEPTANCE-REPORT §2.9](ACCEPTANCE-REPORT.md#29-t12-03-electron-流水线生产运行时2026-10-01)。

---

## 3. AI 侧能力

AI 栈**不在 Rust 里重写**：它随侧车一起跑，Rust 只提供服务：

| 能力                             | 状态 | 落点 / 前置                                                                                                       |
| -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| Provider 增删改查 / 排序         | ✅   | `@ec/ai` 的 control 层；`ai.invoke` 的 32 个方法白名单                                                            |
| Model 列表 / 能力矩阵 / 手动补充 | ✅   | 同上                                                                                                              |
| **DPAPI 安全存储**（Key 落盘）   | ✅   | 侧车经宿主能力 `secure.encrypt` / `secure.decrypt` 用 **Rust 侧同一份 DPAPI**；不可用时 AI 栈整体不装配并给出原因 |
| 流式生成                         | ✅   | `ai.stream.start` + 侧车事件总线（`op = "ai.stream"`），按 `requestId` 分流                                       |
| usage / budget                   | ✅   | 预算两端共用 `setting.usage_budget` 落点；`setBudget` 落库并经 `onBudgetChanged` 即时回灌网关                     |
| 远程配置（D-06 用户自配）        | ✅   | `remoteSource` 系列方法                                                                                           |
| WritePipeline                    | ✅   | `code.plan / apply` + 已登记的 `code:write-plan` 域事件                                                           |

**无能力时必须 negotiate 为 false 并给出理由**（本轮的硬要求）：

- `ShellCapabilities.ai` / `.domain` 由 `sidecar_status` 的**真实装配结果**决定，
  不再写死；缺失原因经新增的 `ShellCapabilities.reasons` 回传渲染层；
- AI 未装配时 `ai.invoke` 回结构化 `NOT_SUPPORTED` + 原因；
  `ai.stream` **补发 `error` + `done`**（只回 `accepted:false` 会让界面永远转圈）。

---

## 4. 仍受外部工具链 / 环境限制的功能（如实列出，不粉饰）

| 项                                     | 现状                                                                                                                                                                                                                                                                                                                                            | 需要什么                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Tauri 安装包产出与体积实测             | **未产出**：`cargo check / clippy / build` 与真实启动应用均已跑通（Rust 1.98.1；本机无 MSVC、无管理员权限，走的是非官方支持的 `x86_64-pc-windows-gnu` 路径）                                                                                                                                                                                    | 管理员身份装 MSVC C++ 生成工具（`scripts/setup-rust-tauri.ps1`），再 `pnpm build:tauri`；NSIS 还需预置 nsis-3.11 工具链 |
| **Rust 单测执行（`cargo test`）**      | **未执行**：`cargo test --no-run` 可产出测试二进制，但 `-f74df249f9da6813.exe`（lib 测试）在本机以 `STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)` 退出。已排除：导入表逐符号可解析（`LoadLibrary` 成功）、PE 头/子系统/入口点正常、依赖中无 delay-import、`.refptr` 无内容、`ring` 的 C 目标文件单独链接可运行；根因在 GNU 路径的运行期，非仓库代码 | MSVC 官方工具链（同上一行）。2026-09-22 在装有 MSVC 的机器上 `cargo test` 为 **24/24 全绿**                             |
| 侧车随包分发（发行形态）               | 已有构建前置脚本：共享侧车、Node 24 / ABI 137、SQLite native binding、迁移写入 bundle resources；staged Node + better-sqlite3 smoke 通过；Tauri installer build 未验证                                                                                                                                                                          | `apps/desktop-tauri/scripts/stage-sidecar.mjs`；需要 Cargo/Rust 工具链验证实际安装包                                    |
| 侧车与 Node 的 ABI 绑定                | 未实测发行形态：`better-sqlite3` 的 Node 侧绑定按 **Node 24 / ABI 137** 构建；随包分发的 `node.exe` 必须是同一 ABI 大版本                                                                                                                                                                                                                       | 分发 Node ≥24（或按分发版本重建绑定，`prepare:native`）                                                                 |
| Tauri 实机 GUI 冒烟（窗口 / 首屏）     | **已执行**（2026-09-30）：窗口创建、标题正确、WebView2 渲染进程就位、侧车建库成功；**未做**的是"人工点一遍"（建项目 → 开设计器 → 预览）需真实人工操作                                                                                                                                                                                           | 一次人工走查                                                                                                            |
| 冷启动 ≤5s / 双形态内存（NFR-P-01/05） | **未实测**：需安装包 + 真实桌面会话                                                                                                                                                                                                                                                                                                             | 见 `docs/PERF-REPORT.md §3`                                                                                             |
| 真机 OAuth / 邮箱链接验证              | **待手工验收**：邮箱验证/重置与 OAuth 双通道代码及自动化已实现；真实第三方凭据、真实邮件送达尚未验收                                                                                                                                                                                                                                            | 见 `docs/E2E-CHECKLIST.md` M-01/M-02；无需再扩展邮箱验证接口，按 `services/account/README.md` 配置投递                  |
| 真机多端代码编译（Flutter / hvigor）   | **未执行**：本机无三套工具链                                                                                                                                                                                                                                                                                                                    | 见 `docs/E2E-CHECKLIST.md M-04`                                                                                         |

> 判定口径与验收报告一致：这些属于「环境缺失导致未能执行」，与「功能未实现」是两件事。
> 注：本机 `x86_64-pc-windows-gnu` 路径**非 Tauri 官方支持**；上面"已通过"的项在该路径下成立，
> 官方支持路径（MSVC）的历史结论见 `docs/ACCEPTANCE-REPORT.md §2.11.6`。

---

## 5. 自助复核命令

```bash
# 仓库根（Windows PowerShell / Git Bash 均可；路径按本机实际情况替换）
cd <repo>

# ① 侧车产物（Tauri 形态的业务运行时）
node apps/desktop-electron/scripts/build-sidecar.mjs

# ② Rust 门禁（MSVC 官方路径）
cd apps/desktop-tauri/src-tauri
cargo check
cargo clippy --all-targets -- -D warnings
cargo test            # 含对真实侧车进程的活体握手用例

# ②' 无 MSVC / 无管理员权限时的替代路径（非官方支持）
#     cargo check / clippy / build 与真实启动应用可用；
#     cargo test 的测试二进制在本机无法启动，见 §4
powershell -ExecutionPolicy Bypass -File apps/desktop-tauri/scripts/setup-rust-tauri-gnu.ps1 -RunGates

# ③ 侧车与四域端到端（Node 侧，双形态共用同一套用例）
cd <repo>
node node_modules/vitest/vitest.mjs run apps/desktop-electron/src/sidecar
node node_modules/vitest/vitest.mjs run apps/desktop-tauri

# ④ 渲染层产物（证明没有把 Node 模块带进浏览器构建）
pnpm build:renderer
```

> 本仓库的历史验证记录里出现过 `/d/code/program/...`、`/c/Users/<某人>/.cargo/bin` 之类的
> **当时那台机器的绝对路径**；它们只是当时的执行环境，不构成对本机的任何要求。
