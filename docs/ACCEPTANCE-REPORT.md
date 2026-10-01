# EveryoneCoding 验收报告（ACCEPTANCE-REPORT）

> 对应 Wave 10 / T10-05（PRD §10.1 端到端验收 + §10.2 质量门禁）。
> 关联文档：`docs/E2E-CHECKLIST.md`（PRD 21 条及后续追加用例）、`docs/TEST-REPORT.md`（覆盖率与门禁）、
> `docs/PERF-REPORT.md`（九项性能）、`docs/RELEASE.md`（打包与更新回滚）。
> 日期：2026-09-14；**2026-09-15 环境恢复后补齐 git 覆盖率实测并更新 L-03**；
> **2026-09-23 补 §2.12（Wave 9 收口：文档 AI 摘要、图片 OCR、账号完整闭环）并更新 L-05**；
> **2026-09-30 在无语 MSVC 的机器上复验 T13-01 并实机启动 Tauri 应用（§2.11.8）。**
> **2026-10-01 更新 §2.9：流水线持久化事务、队列恢复和真实 Electron E2E-26 验收。**
> **2026-10-01 同步 Wave 9 的 9 月 30 日复核结果（§2.12.5），区分自动化证据与待手工验收项。**
> **2026-10-01 复跑 Wave 9 相关自动化门禁全绿（§2.12.5 末），范围为本任务子集，非根级全量。**
> **2026-10-01 复核 T12-05 四条链路并修掉导出 fail-fast 回归（§2.13）。**

---

## 1. 结论摘要

| 验收维度                              | 目标                                                                                                                         | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E2E 用例齐备                          | 21 条均有用例或手工清单                                                                                                      | ✅ 21/21（`docs/E2E-CHECKLIST.md`）                                                                                                                                                                                                                                                                                                                                                                                                                                |
| E2E 可自动化部分                      | 已登记自动化用例全绿                                                                                                         | ✅ 2026-10-01 完整 `test:e2e` 套件 14 文件/55 项通过；包含真实 Electron 进程退出、重启和续跑（E2E-26）；各场景边界见清单                                                                                                                                                                                                                                                                                                                                           |
| 关键路径埋点                          | ≥90%，payload 无内容                                                                                                         | ✅ 40 项关键事件 / 12 类，payload 走字段白名单断言；覆盖率报告见 `core/src/__tests__/telemetry-coverage.test.ts`                                                                                                                                                                                                                                                                                                                                                   |
| 九项性能指标                          | 逐项达标                                                                                                                     | ✅ 6 项实测达标；3 项（冷启动/内存/包体）需真实外壳与安装包，已列整改计划（`docs/PERF-REPORT.md §3`）                                                                                                                                                                                                                                                                                                                                                              |
| 六核心模块覆盖率                      | ≥70%                                                                                                                         | ✅ 实测（2026-09-15 补齐）：memory 90.78%、context 93.68%、adapters 74.86%、registry 85.68%、package-kit 85.14%、**git 75.71%**                                                                                                                                                                                                                                                                                                                                    |
| 静态检查                              | TS strict 零 error；eslint 零 error/警告                                                                                     | ✅ 2026-10-01：`pnpm -r typecheck` 覆盖 17 个 workspace，`pnpm lint` 全仓通过；独立 `e2e/tsconfig.json` 检查本轮未重跑，历史结果按记录日期解读                                                                                                                                                                                                                                                                                                                     |
| 破坏性操作撤销路径                    | 集成测试 100% 覆盖                                                                                                           | ✅ 八类逐条指到测试（`docs/TEST-REPORT.md §2`）                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 渲染层构建                            | `vite build` 通过（硬规则 1：浏览器入口不泄漏 Node 模块）                                                                    | ✅ **589 modules**（Wave 9 基线 571）                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 双形态打包与更新回滚                  | 安装包产出且体积达标、更新可回滚                                                                                             | ⚠️ **配置与流程逻辑已就绪并验证，安装包未在本机产出**（见 §3）                                                                                                                                                                                                                                                                                                                                                                                                     |
| 首次体验                              | 引导可用、空状态有下一步                                                                                                     | ✅ 新增 `OnboardingCard`（7 项测试）+ 空态文案改造                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 全程不打开终端                        | FR-SET-08                                                                                                                    | ⚠️ 自动化侧以「链路不含 shell 调用 + argv 无高危参数」近似验证；**人工录像走查未完成**（见 §3）                                                                                                                                                                                                                                                                                                                                                                    |
| Electron 生产端口总装（T12-01）       | 11 个生产能力端口装配到真实 SQLite/工程目录、项目上下文贯穿、页面不再因"端口未注入"占位                                      | ✅ 11/11 端口装配；新增 33 项端口集成测试全绿；`lint` / `-r typecheck` / `vite build` / `test:e2e` 全绿（详见 §2.7）                                                                                                                                                                                                                                                                                                                                               |
| 流水线生产运行时（T12-03）            | S1→S5 重启续跑；版本/diff/回退/stale；技术选型阻断；节点失败隔离                                                             | ✅ 2026-10-01：主进程流水线集成 12/12、事务恢复 3/3、真实 Electron E2E-26 1/1；相关测试 21 文件/264 项、完整 E2E 套件 14 文件/55 项、lint 与 17 个 workspace typecheck 通过（§2.9）                                                                                                                                                                                                                                                                                |
| **Tauri 双形态功能等价（T13-01）**    | Tauri 实机下四域每方法可真实调用；`domain`/`ai` 不再因"尚未接入"报 `NOT_SUPPORTED`；无能力必须 negotiate 为 false 并给出理由 | ✅ **业务运行时经受控侧车承载，两版共用同一份领域实现**；15 域全部装配；四基础域白名单 **69/69 方法**逐条真实分发；`cargo check` / `clippy -D warnings` / `cargo test`（24 项，含**真实侧车进程活体握手**）/ `vite build`（611 modules）/ 全仓单测 **248 文件 2552 项全绿**（详见 §2.11）。**2026-09-30 换机复验**：无语 MSVC 机器上 `cargo check`/`clippy`/`build` 退出码 0，**实机启动窗口 + 侧车建库 34 表**，侧车/桥接 82 项与全仓 2589 项全绿（详见 §2.11.8） |
| **Wave 9 收口（2026-09-23）**         | 文档「一键转记忆」走真实 AI 摘要并保留段落锚点、图片 OCR 可用、邮箱验证与找回密码闭环、OAuth 回环+协议双通道各可用           | ✅ 三条半截链路全部打通；新增测试 **主进程 75 项 + 渲染层 18 项 + 服务端 25 项**；另修掉 1 个**跨 6 个域**的潜伏缺陷（AI 流块判别值写错，六个 AI 功能此前实际全不可用）与 5 处真实缺陷（详见 §2.12）                                                                                                                                                                                                                                                               |
| 归档/用量/备份/遥测接线复核（T12-05） | 四条链路接真实数据并可用：导出/导入、五种模式、自愈、增量、定时备份、预算前置阻断、遥测白名单                                | ✅ 2026-10-01 复核：package-kit 17 文件/120 项、归档遥测验收 19/19、renderer package/usage/runtime 88 项 + settings 73 项、shell-api 50 项、E2E-13/14 归档 4 项全绿；`pnpm lint` / `-r typecheck` 通过；修掉 1 处导出 fail-fast 回归（详见 §2.13）                                                                                                                                                                                                                 |

---

## 2. 本轮交付物清单

### 2.1 T10-01 埋点与用量统计

- `packages/core/src/telemetry-events.ts`（事件目录）、`telemetry-client.ts`（本地缓冲 / 批量上报 / 失败重试 / 一键清除）、`telemetry.ts`
- `packages/ai/src/gateway/usage-report.ts`、`budget-alert.ts`
- `apps/renderer/src/features/usage/{UsageDashboard,BudgetSettings,usage-api}.tsx`
- 测试：`telemetry-events / telemetry-client / telemetry-coverage` 等

### 2.2 T10-02 性能专项

- `perf/run.ts`（`pnpm perf`，7 项可复现基准，含机器吞吐归一化）、`perf/last-run.md`（自动写出）
- `docs/PERF-REPORT.md`（九项 NFR-P 对照表 + 机器配置 + 未达标项整改计划）

### 2.3 T10-03 测试与门禁

- `ci/quality-gate.mts`（逐模块覆盖率门禁）、`ci/vitest.coverage.config.ts`、`ci/quality-gate.yml`
- `docs/TEST-REPORT.md`（覆盖率 / 撤销路径清单 / 门禁说明）
- 补齐用例：`packages/ai/src/adapters/openai/__tests__/embeddings.test.ts`（adapters 66.8% → 74.86%）
- **本轮修正三处门禁缺口**（详见 `docs/TEST-REPORT.md §1.1`）：
  ① 覆盖率汇总行取错列（取 % Stmts 当行覆盖率）→ 按列序取 % Lines；
  ② 每模块超时 10 分钟 → 30 分钟，并明确区分「未取到数据（超时/退出码）」与真实百分比、打印每模块耗时；
  ③ `pnpm lint` 实际上一直在红（`perf/run.ts` 的 7 处 `no-console`；且 `ci/*.mts` 因 `--ext` 未含 `.mts` 从未被扫到）
  → CLI 脚本加规则豁免 + `--ext` 补 `.mts`，根 lint 现全仓零问题。
- **放宽** `packages/git/src/__tests__/git-integration.test.ts` 的用例超时改为**环境变量可控、默认 180s**
  （`EC_GIT_IT_TIMEOUT_MS`）。实测本机即便放到 900s 仍两趟都超时（单趟 >15 分钟，双后端需 40+ 分钟），
  故不是超时参数问题；门禁在这种机器上如实报「未取到覆盖率数据」，不输出假百分比
  （详见 `docs/TEST-REPORT.md §1.2`）。

### 2.4 T10-04 打包分发

- 版本单一事实源：`ci/version.mts`（`pnpm version:check` / `version:sync`，同步 `tauri.conf.json` / `Cargo.toml` / `electron-builder.yml` 等五处）
- 发布编排：`ci/release.yml`（version-guard → build-tauri ∥ build-electron → release）、`ci/make-release.mts`
  （产出 `latest.json` / `latest.yml` / `release-manifest.json` / `distribution.html` + 体积门禁）
- 更新与回滚：`packages/core/src/update/*`（`update-policy` / `update-ledger` / `update-runner`）、
  `apps/desktop-tauri/src-tauri/nsis/installer-hooks.nsh`、`apps/desktop-electron/build/installer.nsh`
- `docs/RELEASE.md`（双形态差异、系统要求、更新通道、回滚方法、本机无法验证项）

### 2.5 T10-05 E2E 与首次体验

- `e2e/vitest.config.ts`、`e2e/tsconfig.json`、`e2e/helpers.ts`
- `e2e/services/e2e-01-account.test.ts`、`e2e/services/e2e-02-oauth.test.ts`
- `e2e/domain/e2e-03-pipeline.test.ts`、`e2e-07-git.test.ts`、`e2e-10-relay.test.ts`、
  `e2e-11-remote-config.test.ts`、`e2e-13-14-archive.test.ts`、`e2e-15-17-20-rename-and-migration.test.ts`、
  `e2e-19-21-tech-and-multiplatform.test.ts`
- `e2e/ui/e2e-04-18-workflow.test.tsx`
- 首次体验：`apps/renderer/src/features/workspace/OnboardingCard.tsx` + `workspace.css` 样式 + `WorkspaceHome` 空态接入
- 文档：`docs/E2E-CHECKLIST.md`、本报告
- 入口：`pnpm test:e2e`

### 2.6 Electron 形态本机实跑（2026-09-15 补齐）

Wave 10 收官时 Electron 形态标注为"未本机验证"。本轮补齐前置条件后**真机跑通**，过程中暴露出
4 处只在"真启动"时才会暴露的缺陷 —— 这类缺陷单测与构建都无法发现，记录如下：

| #   | 缺陷                                                                                | 根因                                                                                                                                    | 修复                                                                                                               |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | `pnpm dev:electron` 必失败：`Cannot find module 'node_modules/esbuild/bin/esbuild'` | `esbuild` 是 vite 的**传递依赖**，未在任何 `package.json` 声明（幽灵依赖），根 `node_modules` 下并不存在该路径                          | 把 `esbuild` 声明为 `@ec/desktop-electron` 的显式 devDependency；构建脚本改用可执行名                              |
| 2   | 主进程启动即崩：`ReferenceError: require is not defined in ES module scope`         | 包声明了 `"type": "module"`，而构建产物是 CJS `.js`，Electron 按 ESM 加载                                                               | 产物扩展名改为 `.cjs`（`package.json` 的 `main`、`electron-builder.yml` 的 `files.main`、主进程 preload 路径同步） |
| 3   | `migrator.ts` 顶层抛 `ERR_INVALID_ARG_TYPE`（`fileURLToPath(undefined)`）           | esbuild 以 `--format=cjs` 打包时 `import.meta.url` 为 `undefined`                                                                       | 改为惰性求值 + 无 ESM 上下文时回退 `process.cwd()`；主进程入口删去 `fileURLToPath`，改用 CJS 原生 `__dirname`      |
| 4   | AI 栈报"找不到 SQLite 迁移目录"                                                     | 主进程用 `__dirname` 推导迁移目录，但 `src/main/index.ts` 与产物 `dist/main/index.cjs` 相对仓库根的深度不同（差一层），三个候选路径全错 | `resolveMigrations` 改为**逐级向上探测**（对源码深度/产物深度/asar 打包均健壮）；同时修正主进程传参的上溯层数      |

**跑通证据**：

- 主进程 `dist/main/index.cjs` 加载成功，AI 栈装配无告警（`[AI]` 提示不再出现）。
- 首次启动自动执行迁移：`%APPDATA%\@ec\desktop-electron\data\everyonecoding.sqlite`
  → **34 张表 + 5 个迁移全数应用**，FTS5 索引表（`memory_item_fts*`）就绪，`user` 表写入本地用户 1 行。
- `better-sqlite3` Electron ABI 绑定（ABI 130）加载正常 —— 与 Node 侧绑定两套共存，未影响全仓单测。

**回归验证**：改动涉及 `packages/data`（核心迁移框架）与主进程，故跑全量回归 ——
**218 文件 / 2188 项全绿**（含真实 git 集成 3 项），ESLint 与 TS strict 均零 error。

> 说明：Electron 主进程的 AI 栈依赖 `safeStorage`（DPAPI）。在无桌面会话/无加密可用性的环境下
> 该栈会**优雅降级**（仅告警、不阻塞启动），这是既有设计而非缺陷。

### 2.7 T12-01 Electron 生产端口总装与项目上下文（2026-09-20）

渲染层早已定义好 11 个生产能力端口（`MemoryApi` / `PipelineApi` / `GitApi` / `PreviewApi` /
`RenameApi` / `PackageApi` / `UsageApi` / `ContextPanelApi` / `CodeViewApi` / `NavApi` /
`DesignerPortApi`），但只有消费方、没有生产者 —— 记忆 / 流水线 / Git / 预览 / 重命名 / 归档 /
用量等页面长期停留在"服务未初始化"占位态。本次把生产者补齐并让**当前项目上下文**贯穿全链路。

#### 2.7.1 每个端口的生产装配证据

装配链四层（缺一层就不通）：`packages/shell-api` 契约 → `main/ipc/domain.ts` 通道 →
`preload/api.ts` 白名单 → `bridge.ts` → `renderer/runtime/production-ports.ts` 适配器。

| 端口（域）                 | 主进程域实现                               | 渲染层适配器（`production-ports.ts`） | 复用的领域内核（不重写）                                                                                                                  | 如实降级（不伪造成功）                                                                     |
| -------------------------- | ------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| memory（`memory`）         | `main/domain/domains/memory-domain.ts`     | `createMemoryApi`                     | `MemoryRepo` / `resolveInheritance` / `detectConflicts` / `readImport` / `classifyImport` / `planMerge` / `commitMergePlan` / `exportAll` | 外壳无同步口 → 整个端口不注入（页面保留引导）                                              |
| pipeline（`pipeline`）     | `main/domain/domains/pipeline-domain.ts`   | `createPipelineApi`                   | `PipelineMachine` / `ArtifactStore` / `SplitModel`                                                                                        | AI 栈未装配 → `generateRequirement`/`generateTechDoc`/`runGeneration` 报 `NOT_SUPPORTED`   |
| designer（`designer`）     | `main/domain/domains/designer-domain.ts`   | `createDesignerApi`                   | `@ec/designer/dsl` 的 `createEmptyPage`/`serializePageDsl`；`@ec/memory` 的 `condensePage`                                                | AI 生成页面 `NOT_SUPPORTED` + 引导（可先手动搭建）                                         |
| git（`git`）               | `main/domain/domains/git-domain.ts`        | `createGitApi`                        | `GitClient` + `MergeService`/`ConflictService`/`RecoveryService`/`RemoteService`/`HistoryService`                                         | 凭据读写、`generateCommitMessage`（需 AI）、`applyResolution`（D-04 只走写入管线）如实拒绝 |
| preview（`preview`）       | `main/domain/domains/preview-domain.ts`    | `createPreviewApi`                    | `@ec/preview`                                                                                                                             | 后端托管需项目具备可启动脚本，缺失时返回结构化 `PreviewResult.error`                       |
| rename（`rename`）         | `main/domain/domains/rename-domain.ts`     | `createRenameApi`                     | `@ec/registry`（occurrence / transaction / anchor）+ 注册表写入口                                                                         | 影响面/事务/迁移的 AI 生成类方法报 `NOT_SUPPORTED`                                         |
| package（`package`）       | `main/domain/domains/package-domain.ts`    | `createPackageApi`                    | `@ec/package-kit` + 复用 settings 域已验证的 `createExportSourcePort`/`createImportLocalStatePort`/`createImportTargetPort`               | 附件子系统与外部条件缺失处如实报错，不静默丢数据                                           |
| usage（`usage`）           | `main/domain/domains/usage-domain.ts`      | `createUsageApi`                      | `usage_record` 表（行结构原样透传）                                                                                                       | 无记录时返回空集而不是编造用量                                                             |
| ai-context（`ai-context`） | `main/domain/domains/ai-context-domain.ts` | `createAiContextApi`                  | `ContextSources` 四源（memory / notes / documents / code）                                                                                | `availableSources` 只声明真实接线的源                                                      |
| code（`code`）             | `main/domain/domains/code-domain.ts`       | `createCodeApi`                       | WritePipeline 语义（plan→preview→apply）+ `fs.watch` 外部改动检测                                                                         | `requestRework` 需会话上下文 → `NOT_SUPPORTED`                                             |
| nav（`nav`）               | `main/domain/domains/nav-domain.ts`        | `createNavApi`                        | `@ec/ai` 导航 + Code Anchor 反查                                                                                                          | 无锚点时返回空跳转集而不是假跳转                                                           |

**同步签名端口的专用通道**（本轮的关键设计决定）：`MemoryApi` 与 `PipelineApi` 是**同步签名**
（消费方在 `advance()` 之后**立刻同步**读 `snapshot()`），异步 RPC + 快照缓存表达不了这种语义 ——
写入后立刻读会拿到上一拍的数据。故另开一条同步通道，五处同步落地：

| 层      | 落地                                                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 契约    | `shell-api` 的 `DOMAIN_SYNC_METHODS`（独立白名单，默认拒绝）+ `isDomainSyncMethod`；`DomainControlHost.invokeSync?` 为**可选**能力 |
| 主进程  | `createDomainRuntime.invokeSync`（与 `invoke` 同一套白名单校验/错误脱敏）+ `SyncDomainRouter` 带入 `ctx`                           |
| IPC     | 独立通道 `ec:domain:invokeSync`（`ipcMain.on` + `event.returnValue` 同步应答；`SYNC_CHANNELS` 登记）                               |
| preload | `domain.invokeSync`（进 `PRELOAD_METHOD_KEYS.domain`；只做形状校验，方法白名单归主进程）                                           |
| 渲染层  | `createDomainSyncCaller`：宿主没有 `invokeSync` 就返回 `null` → **这两个端口不注入**，而非读脏缓存                                 |

#### 2.7.2 项目上下文贯穿

- 新增 `apps/renderer/src/runtime/project-context.ts`：活跃项目由 `useProjectStore` 单点持有，
  `getActiveProject()` / `requireActiveProject()` / `onActiveProjectChange()` / `currentUserId()`。
- 适配器每次调用经 `withProject()` 注入 `projectId`；**未打开项目时抛 `INVALID_ARGUMENT` 且请求根本不发出**
  （不是发一个 `projectId: undefined` 的请求让主进程猜）。
- `WorkspacePage.openProject` 先 `getProject(id)` 取真实摘要写入项目上下文，再跳转设计器。
- `DesignerPage` 以 `key={project.id}` 装载会话：**切换项目即整棵会话卸载**，旧订阅（编辑器订阅、
  页面树订阅、防抖定时器）随之释放，不残留旧项目状态。
- 移除固定夹具：`createLoginPageDsl()` 不再出现在实现代码里，`P1` / `U-TEST` / 「商城」亦已清除
  （`grep` 结果显示仅在解释性注释中出现）。

#### 2.7.3 本轮修掉的真实缺陷（编译不过的除外）

| #   | 缺陷                                                                                                  | 根因与后果                                                                                                                                                                                                                                                                                            | 修复                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | `production-ports.ts` 文件交错损坏（`createPipelineApi` 与 `createGitApi` 互相穿插）                  | 限流打断留下的半截文件；`createPipelineApi` 的 `subscribe` 回调被 Git 函数体劈成两半 → 整个渲染层编译不过                                                                                                                                                                                             | 按行区间重排为「流水线完整体 + Git 完整体」                                                                            |
| 2   | `pipeline-domain.ts` 残留两段旧 `switch` 草案（`case 'saveArtifact'` / `case 'generateRequirement'`） | 文件已改为 handler-map 设计，残留草案造成 `TS1128/TS1005` 语法错误；且重复实现了同一方法两次                                                                                                                                                                                                          | 删除残留段，保留 `syncHandlers`/`asyncHandlers` 单一实现                                                               |
| 3   | **同步操作的状态变更事件被静默丢弃**                                                                  | `SyncDomainRouter` 只有 2 个参数（无 `ctx`），同步路由拿不到 `emit`；`startStage`/`confirm`/`back` 在同步口上推的事件全部丢失                                                                                                                                                                         | `SyncDomainRouter` 补第三参数 `ctx`，`invokeSync` 构造 ctx（requestId 复用 + `events.send`）                           |
| 4   | **code 域外部改动事件永远不触发**                                                                     | `createProductionDomains` 收到的是 `emit: () => {}` 空实现，`fs.watch` 的回调发进黑洞 → `subscribeExternalChanges` 形同虚设                                                                                                                                                                           | 主进程先建 `DomainEventSink` 再建域工厂，`emit(domain, payload)` 真实投递；无请求归属的事件用固定哨兵 requestId        |
| 5   | **新建项目后打开设计器必失败**                                                                        | `designer.createPage` 手写 DSL 漏 `projectId`/`viewport`/`apiDeps`/`notes`/`anchors`，并把 `state` 拼成 `states` → 文件落盘成功、`listPages` 也能列出，但渲染层 `deserializePageDsl` 的 zod 校验必然失败                                                                                              | 改用 `@ec/designer/dsl` 的 `createEmptyPage` + `serializePageDsl`；并新增"信封必须通过 `deserializePageDsl`"的守卫断言 |
| 6   | **同一毫秒为两个项目建路由总表会撞主键**                                                              | `upsertRoutes` 用纯时间戳生成 `memory_item.id`（`mem-<ts>-routes`）→ 第二个项目 `UNIQUE constraint failed`                                                                                                                                                                                            | id 加入 `projectId`                                                                                                    |
| 7   | `pipeline-domain` 的 `emit` 是死参数                                                                  | 声明了 `options.emit` 却从不使用（全部走 `ctx.emit`），且签名与工厂不符导致类型错误                                                                                                                                                                                                                   | 删除该死参数，避免"看起来会发事件"的误导                                                                               |
| 8   | `memory-domain` 声明返回 `DomainRouter` 却返回 `{router, syncRouter}`                                 | 返回类型与实现不符，`tsc` 报错                                                                                                                                                                                                                                                                        | 修正返回类型                                                                                                           |
| 9   | `DesignerPage` 端口装配的类型/形状错误                                                                | `writePageStructure` 返回 `Promise<unknown>` 不满足 `void \| Promise<void>`；`route` 在 `exactOptionalPropertyTypes` 下不能传 `undefined`；路由缓存形状缺 `pageId`/`pageName`/`params`                                                                                                                | 逐项修正（async 包装 + 条件展开 + 构造真实 `RouteEntry`）                                                              |
| 10  | `PageMemoryPort.listStructureRevisions` 不接受 Promise                                                | 生产实现在外壳侧（异步 RPC），契约却只允许同步数组                                                                                                                                                                                                                                                    | 契约放行 `Array \| Promise<Array>`，并注明消费方必须 `await` 收口                                                      |
| 11  | **同步域通道在生产环境从未注册**                                                                      | `registerAllIpc` 把 `ipcMain` 包成 `wrapped` 时只转发了 `handle`/`removeHandler`，而 `registerDomainIpc` 用 `ipc.on` 注册 `ec:domain:invokeSync` → 包装对象没有 `on`，注册被静默跳过。后果：渲染层 `sendSync` 无对端应答会**永久阻塞整个渲染进程**（记忆 / 流水线页面直接卡死），且只在真实外壳里现形 | `wrapped` 转发 `on` / `removeAllListeners`；`channels.test.ts` 补「同步通道确实经 `on` 注册并在 dispose 时清理」的断言 |
| 12  | preload 缺 `domain` 命名空间时整个外壳构造失败                                                        | `bridge.ts` 在构造阶段裸读 `api.domain.invokeSync` → 早期/裁剪过的 preload 会让 `createElectronShell` 直接抛错，连文件系统等无关能力一起不可用（契约测试的假 preload 正是这种情形，16 项用例集体失败）                                                                                                | 改为按需读取 + 缺失时如实报 `NOT_SUPPORTED`，构造阶段不再触碰                                                          |

#### 2.7.4 本轮新增测试（33 项）

| 文件                                                                 | 项数 | 覆盖内容                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop-electron/src/main/__tests__/domain-production.test.ts` | 15   | 真实项目 ID 贯穿；重启后重读（DSL/页面记忆/流水线快照）；错误码映射（未知方法 / 缺 projectId / 项目不存在 / 页面不存在 / `NOT_SUPPORTED`）；并发项目不串数据（目录、台账、产物文本、阶段状态、记忆归属）；同步口白名单与 `NOT_SUPPORTED`；`describe` 如实上报；`createPage` DSL 合法性守卫 |
| `apps/renderer/src/runtime/__tests__/production-ports.test.ts`       | 18   | 无同步口时 memory/pipeline 不注入并给出原因；同步口参数逐字透传；projectId 随项目切换而变且不被调用方覆盖；未打开项目时**请求不发出**；错误码映射到 `GitResult`/`PreviewResult`/`ShellError`；进度事件按 requestId 与项目双重过滤；`onProgress` 函数必须被剥掉                             |

两项必测点均落在真实数据上（临时 SQLite + 临时工程目录），未打桩域实现。

#### 2.7.6 E2E 用例复核（`pnpm test:e2e`）

| 用例                                                                         | 结果         | 耗时       |
| ---------------------------------------------------------------------------- | ------------ | ---------- |
| `services/e2e-01-account.test.ts`（账号注册/登录/找回）                      | ✅ 3/3       | 478ms      |
| `services/e2e-02-oauth.test.ts`（OAuth 回环 + PKCE + state 校验）            | ✅ 4/4       | 1.7s       |
| `domain/e2e-03-pipeline.test.ts`（S1→S5 流水线）                             | ✅ 4/4       | 8ms        |
| `ui/e2e-04-18-workflow.test.tsx`（拖拽设计 + 元素生成，组件层）              | ✅ 8/8       | 44ms       |
| `domain/e2e-07-git.test.ts`（**真实 git** 全流程，无命令行）                 | ✅ 1/1       | **223.6s** |
| `domain/e2e-10-relay.test.ts`（自定义中转）                                  | ✅ 2/2       | 287ms      |
| `domain/e2e-11-remote-config.test.ts`（远程配置）                            | ✅ 4/4       | 92ms       |
| `domain/e2e-13-14-archive.test.ts`（归档导入 / 冲突）                        | ✅ 4/4       | 174ms      |
| `domain/e2e-15-17-20-rename-and-migration.test.ts`（重命名级联/反例/回滚）   | ✅ 5/5       | 66ms       |
| `domain/e2e-19-21-tech-and-multiplatform.test.ts`（技术选型 + 七端生成矩阵） | ✅ 4/4       | 10ms       |
| **合计**                                                                     | ✅ **39/39** | 242.8s     |

#### 2.7.5 门禁实测（2026-09-20）

| 命令                                                       | 结果                                                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`（`--ext .ts,.tsx,.mts,.mjs --max-warnings 0`） | ✅ 零 error 零 warning                                                                                                                               |
| `pnpm -r typecheck`                                        | ✅ 17/17 包通过                                                                                                                                      |
| `tsc -p e2e/tsconfig.json --noEmit`                        | ✅ 零 error（e2e 是独立工程，vitest 不做类型检查）。**注**：2026-09-20 之后 `E2E-22/24` 提交曾引入 4 项 error，已于 2026-09-30 修回零 error（见 §3） |
| `vite build`（`apps/renderer`）                            | ✅ 通过，`✓ built in 4.33s`（证明 11 个端口的适配器没有把 Node 模块带进浏览器构建）                                                                  |
| 新增集成测试                                               | ✅ 33/33 通过                                                                                                                                        |
| 全量单测（根 `vitest run`）                                | ✅ **236 文件 / 2419 项全绿，0 失败**（215.9s；未改任何超时预算）                                                                                    |
| `pnpm test:e2e`                                            | ✅ **39/39 全绿**（10 个文件），含真实 git 全流程 E2E-07（223.6s）                                                                                   |

**关于一度出现的 8 项 git 红（已确诊为环境性并已消失）**：首轮全量单测有 8 项红，分布在
`apps/desktop-electron/.../domain-workspace-git.test.ts` 与
`packages/git/src/__tests__/git-integration.test.ts`。确诊过程与结论（详见 `docs/TEST-REPORT.md §1.2`）：

1. **决定性实验**：本机 `where.exe git`（极简原生进程）501ms、`node -e 0` 503ms、
   `git --version` 759ms —— 即**进程创建本身就有 ~0.5s 地板价**，git 只多约 260ms；
2. 退化期间实测 `git --version` **26.5s**，说明**进程创建被系统层拖慢约 50 倍**
   （实时杀毒扫描 / 过滤驱动一类），与 git 无关，更与本仓代码无关；
3. 两个红文件均未引用 T12-01 改动的任何模块；`@ec/git` 侧已核对**无冗余子进程**
   （`probe()` 只在建客户端时跑一次、`status()` 单次 spawn、后端探测结果被 ESM 模块缓存），
   不存在"每次操作多起几个进程"的可优化项；
4. 环境恢复后**按默认超时**复跑：两个文件 **12/12 通过**（46.2s / 184.9s），
   全量单测随即 **2419/2419 全绿**。

> 处置口径：**未改动这两个文件的超时预算**（放宽预算只会掩盖真实卡死）。
> 再次遇到同类红时，按 `docs/TEST-REPORT.md §1.2` 的四步自证流程走：同时量
> `git --version` 与 `where.exe git` → 判定是否为环境性 → 临时用 `--testTimeout` /
> `EC_GIT_IT_TIMEOUT_MS` 放行（不写回源码）→ 治本是把 `git.exe`/`node.exe` 与仓库目录
> 加入杀毒实时扫描白名单（需管理员权限）。

> 环境注记：根脚本 `pnpm build:renderer`（内含 `pnpm --filter`）在本机沙盒里会卡住不返回 ——
> 这是内层 pnpm shim 的解析问题，不是构建问题：直接调 `vite build` 4.33s 通过。
> 沙盒里报此现象时按同一路径绕过（`node node_modules/vite/bin/vite.js build`）。

> **未在本轮完成**：`pnpm dev:electron` 的**人工交互走查**（创建两个项目 → 分别打开设计器修改 →
> 重启 → 校验不串且仍存在）需要真实桌面会话，沙盒内无法操作 GUI。该场景已被
> `domain-production.test.ts` 的"重启后可重新读取"与"并发项目不串数据"两组用例以**同语义**覆盖
> （真实 SQLite + 真实工程目录 + 换运行时重读），但 GUI 层的手工复核仍需主人执行一次。

### 2.8 T12-02 记忆、上下文、代码写入与设计器端口（2026-09-20）

T12-01 把 11 个域"装配上了"，但其中三处仍是**数据直供或明确拒答**；本轮把它们换成真实主链路。

#### 2.8.1 改动清单（按职责）

| 层                      | 文件                                                                                         | 改动                                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 契约（`@ec/ai`）        | `src/context/context-types.ts`、`src/context/blocks/shared.ts`                               | `ContextMemoryQuery` 增加 `pageId/elementId/featureId`（页面 / 元素 / 功能三级记忆必须收敛到本次对象）；`ContextMemoryPort.describe?()` 让外壳自述检索能力，块来源不再写死"双路召回"                                                                                           |
| 契约（`@ec/designer`）  | `src/notes-entry.ts`（新）、`package.json`、`src/__tests__/notes-entry-purity.test.ts`（新） | 新增 `@ec/designer/notes` 纯子入口：外壳（主进程）要复用备注的优先级 / 禁止事项 / 历史规则，但不能把包根入口的 React 组件拉进主进程构建；纯度守卫与 `./dsl` 同规格                                                                                                             |
| 契约（`@ec/shell-api`） | `src/domain-control.ts`                                                                      | designer 域方法白名单补 `updateNote/setNoteStatus/removeNote/noteBadges`；新增 `code:write-plan` 事件三件套（常量 + 形状守卫 + 注册表），否则 AI 重改的计划会被渲染层的通用载荷过滤静默丢弃                                                                                    |
| 契约（`@ec/core`）      | `src/command-catalog.ts`                                                                     | 导航新增 `/code`，同步登记命令目录（`command-catalog.test.ts` 是导航↔目录的漂移守卫）                                                                                                                                                                                          |
| 数据层（`@ec/data`）    | `migrations/0006_designer_notes.sql`（新）、`src/schema.ts`                                  | `note` 表补齐 FR-ANN 需要的列（target 归属 / note_type / status / priority / version / payload_json 等）。**此前 `note` 只有 title/content/kind，主进程按领域模型写 SQL（`element_id`/`body`）必然抛列不存在**                                                                 |
| 主进程（新）            | `domain/designer-notes.ts`                                                                   | 备注的 SQLite 持久化适配：复用 `@ec/designer/notes` 的 `NoteRepository`（优先级加权、禁止事项恒为 5、历史留痕、上下文排序全在领域层），本文件只做行↔模型映射                                                                                                                   |
| 主进程（新）            | `domain/designer-pages.ts`                                                                   | 页面 DSL 的只读装载器：`listPages` / `readPage` / `findElement`（根→选中元素祖先链），上下文引擎与设计器端口共用同一份解析口径                                                                                                                                                 |
| 主进程                  | `domain/domains/ai-context-domain.ts`                                                        | **重写**：从"数据直供四源"改为真实 `ContextEngine` 组装（十类块），五个数据端口全部落在真实 SQLite / 工程目录上；返回完整 `AssembledContext`（含 tokens / source / skipped / items / truncation / noteIds / memoryIds）                                                        |
| 主进程                  | `domain/domains/code-domain.ts`                                                              | **重写**：`plan/preview/apply` 接 `@ec/ai` 的 `WritePipeline`（冲突检测 + 事务回滚），`requestRework` 走真实模型 → 输出契约解析 → 计划经 `code:write-plan` 事件回流；写入后 Code Anchor 经 `AnchorRepository` 写回 `code_anchor` 表；外部改动检测改为"事件触发 + 文件索引比对" |
| 主进程                  | `domain/domains/designer-domain.ts`                                                          | 页面记忆改走 `PageMemoryService` + `condensePage` + revision 台账（增量 diff）；路由总表改走 `ProjectMemoryService.mergeRoutes`；`generatePage` 增加 DSL 校验结论；备注 CRUD 落地；**新增 `element` 行与 `feature` 行登记**（详见 2.8.3 ①②）                                   |
| 主进程                  | `domain/domain-factories.ts`                                                                 | 备注存储单例在 designer 与 ai-context 之间共享（两处各持一份内存副本会出"刚加的备注没进上下文"）                                                                                                                                                                               |
| 渲染层                  | `runtime/production-ports.ts`                                                                | `availableSources` 补 `elements`；`createCodeApi` 增加 `subscribeWritePlan`（AI 重改计划回流）；`createDesignerApi` 对齐备注 CRUD 与 `generatePage.validation`                                                                                                                 |
| 渲染层（新）            | `pages/CodePage.tsx`、`App.tsx`、`layout/{navigation,AppIcon}.tsx`、`i18n/*`                 | 新增「代码与上下文」页：`ContextPanel` + `CodeView` + `DiffView` + `ApplyBar` 首次有了**生产挂载点**（此前只有组件测试在驱动它们）。页面不提供任何"保存代码"入口                                                                                                               |
| 渲染层                  | `features/code/{code-api.tsx,CodeView.tsx}`、`features/ai/context-api.tsx`                   | `CodeViewApi` 增 `subscribeWritePlan`；`CodeView` 装载后默认选中第一个文件（否则用户打开代码页只看到"请选择一个文件查看"）；两个端口补 `*_GLOBAL_KEY` 常量                                                                                                                     |

#### 2.8.2 每条验收标准的落地证据

| 验收标准（任务卡原文）                                     | 证据                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新建页面并修改元素 → 页面记忆出现对应结构摘要              | `domain-content-ports.test.ts`「保存页面后页面记忆出现结构摘要」：断言 `memory_item.structured` 的 `skeleton` 含 `Card`/`Button`、`state` 1 项、`apiDeps=['/api/auth/login']`，且不含 `"style"`                         |
| 修改元素后 revision 递增、重复保存不刷台账                 | 同用例：加一个元素后 `revision` 递增且 `changed` 含 `el-captcha`；同一份 DSL 再写一次 revision 不增（设计器 600ms 防抖会反复重发）                                                                                      |
| 打开上下文面板能看到真实来源和裁剪提示                     | `ai-context-domain` 的十类块证据见下一条；渲染层 `code-page.test.tsx` 断言块 source（"关键词检索（FTS5 trigram） 1 条"）、跳过原因与 `ec-context-omitted` 省略清单都真实渲染                                            |
| 上下文真实读取五层记忆 / 备注 / 文档 / 祖先链 / 代码与锚点 | `domain-content-ports.test.ts`「十类块按真实数据组装」：长期记忆（用户级）、项目记忆（路由总表）、页面记忆（含页面摘要）、元素祖先链（`祖先链 4 层`）、备注（`备注 1 条` + `【禁止】`）、文档章节、代码锚点片段逐块断言 |
| 不能把空块伪装成已有内容                                   | 两条机器化断言：① 每块 `content` 非空 ⟺ `items` 非空；② 空项目组装时只有 `instruction` 有内容，其余块 `content === ''` 且给出 `skipped` 原因，提示词如实写「（本次无可用上下文）」                                      |
| 选中元素生成代码 → 预览 diff → 应用 → 回滚                 | `domain-content-ports.test.ts`：`plan`（新建 + 补丁）→ `apply` 后磁盘内容逐字断言；回滚用"父路径是文件"制造真实写入失败 → 断言 `applied=[]`、`rolledBack` 含已写文件、磁盘无残留                                        |
| 手动键入 / 粘贴 / 拖拽编辑代码均被拦截                     | `CodeView` 的 `createReadOnlyGuard`（原有）+ `code-page.test.tsx` 断言 `data-readonly` 且 `paste` 被拦截并弹出「交给 AI 修改」；`packages/ai` 的静态扫描测试继续盯住 `CodeView.tsx` 源码                                |
| 外部进程修改代码后客户端提示重新生成或回滚                 | `domain-content-ports.test.ts`：AI 自身写入被抑制（0 条假警报），外部改写后事件上报 `src/watched.ts` 与提示语；`code-page.test.tsx` 断言横幅与两个动作（回滚导航到 Git 模块，不另造恢复旁路）                           |
| 新建文件 / diff 补丁 / AI 重改都走现有 WritePipeline       | 三种模式全部经 `WritePipeline.plan/apply`；`requestRework` 用假 gateway 覆盖"真实模型 → 契约解析 → 计划事件 → 应用"全链；模型输出不合约时如实报错且不落半成品                                                           |
| SQLite / Node 依赖不进 renderer 浏览器入口                 | `vite build` 通过（`CodePage` 独立 chunk 33.62 kB）；`@ec/designer/notes` 只被主进程引用，并有纯度守卫测试                                                                                                              |

#### 2.8.3 本轮修掉的真实缺陷（4 处）

① **`note` 表结构与领域模型不匹配**（迁移 `0006`）：主进程此前按 `Note` 字段写 SQL
（`INSERT ... element_id, body`），列不存在 ⇒ 元素级备注写入必抛错；上下文引擎读 `row.body`
永远拿到空。**症状隐蔽**：只在"真的给元素加备注"时现形。

② **`element` / `feature` 行从未登记**：`code_anchor.element_id` 与 `memory_item.feature_id`
都是外键，而设计器只维护了 `page` 行。后果是"锚点写回失败"与"页面归属某功能时页面记忆写入
失败"，且只在对应数据形状下触发。现由 `designer-domain` 在 `savePage/createPage` 时同步
组件树到 `element` 表、按需登记 `feature` 行（`INSERT OR IGNORE`）。

③ **Windows 上 `fs.watch` 的 `filename` 不可信**：实测对 `src/a.ts` 的写入，事件里报的是
**目录名**（`src`）且重复上报；直接采信会给用户弹"代码已被外部修改（src）"并漏掉真实文件。
现行方案是**事件只当触发器**：短窗口合并后对代码根做一次「路径 → size/mtime」索引比对，
输出精确相对路径；自身写入经抑制窗口排除（临时文件与最终路径一起抑制）。

④ **`CodeView` 装载后不选中任何文件**：只读视图停在"请选择一个文件查看"，用户会误判成
"端口没装配"。现默认选中第一个文件（受控用法不受影响）。

#### 2.8.4 门禁实测（2026-09-20 第二轮）

| 命令                            | 结果                                                                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                     | ✅ 零 error 零 warning                                                                                                                                                                                                                                           |
| `pnpm -r typecheck`             | ✅ 17/17 包通过                                                                                                                                                                                                                                                  |
| 新增集成测试                    | ✅ `domain-content-ports.test.ts` 17/17、`code-page.test.tsx` 5/5、`notes-entry-purity.test.ts` 3/3                                                                                                                                                              |
| 相关包测试                      | ✅ shell-api 47、data 28、ai 301、memory 171、designer 423、core 240、renderer 456、desktop-electron 177（全绿）                                                                                                                                                 |
| 根级全量单测                    | ⚠️ **239 文件 / 2444 项，2443 通过、1 红**：红项是 `@ec/ai` 上下文性能基准（全量并发下 p95 338.56ms > 300ms）。已用"只改并发度"的对照判定为**环境性假红**（单独跑该文件 p95 = 6.95 / 7.99ms，余量约 40 倍），详见 `docs/TEST-REPORT.md §5.1`；未改动任何性能预算 |
| `vite build`（`apps/renderer`） | ✅ `✓ built in 4.23s`，`CodePage` 独立 chunk 33.62 kB                                                                                                                                                                                                            |

> 仍未完成（与本轮同因）：`pnpm dev:electron` 的人工 GUI 走查需要真实桌面会话；
> 「代码与上下文」页的交互已由 `code-page.test.tsx` 以真实组件 + 假端口覆盖，
> 但"在真窗口里点一遍"仍需主人执行一次。

### 2.9 T12-03 Electron 流水线生产运行时（2026-10-01）

本次在既有领域引擎和生产端口上补齐事务、重启与 UI 链路。S1/S3/S4 的生成、入档、
版本保存和提交待确认由主进程一次完成；renderer 不再重复保存。S2 捕获设计器的完整 DSL，
S6/S7 使用同一版本化入口记录报告。S6/S7 的确认表示用户确认报告，不代表自动完成集成测试或发布。

#### 2.9.1 实现与持久化位置

| 职责           | 实现与数据位置                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 阶段内核       | `PipelineMachine`、`ArtifactStore`、S1/S3、`SplitModel`、`S5GenerateStage`、`GenerationQueue`；恢复阶段判定复用 `@ec/pipeline` 的 `findResumeStage`                                              |
| 主进程事务     | `apps/desktop-electron/src/main/domain/pipeline-persistence.ts`；迁移 `packages/data/migrations/0007_pipeline_checkpoint.sql` 新增 `pipeline_checkpoint` 与 `pipeline_commit_receipt`            |
| 状态与断点     | SQLite checkpoint 保存阶段快照、activeVersion、stale、原始需求、S5 节点进度和依赖契约；`<dataDir>/snapshots/pipeline-<projectId>.snapshot.json` 保留兼容快照；数据库无 checkpoint 时可导入旧快照 |
| 崩溃边界       | `<dataDir>/pipeline-transactions/` 撤销日志在文件发布前持久化；重启依据 SQLite 提交回执决定撤销未提交文件或仅清理已提交日志                                                                      |
| 文档与阶段产物 | `document` / `doc_version` / `stage_artifact` 与 `<project>/docs/`、`<project>/pipeline/s1-art-v<n>.md` 等文件一起提交；S4 当前拆分位于 `pipeline/S4/split.json`，切换生效版本时同步更新         |
| 技术选型       | `saveTechChoice` 校验后创建或更新项目 `memory_item`；S3 的推进、开始和直接生成入口均检查已保存结果；请求临时附带 `choice` 不能绕过                                                               |
| S5 代码与进度  | 代码经 code 域 `WritePipeline` 写入 `resolveCodeRoot()` 指定的官方代码根；单节点重试/跳过/暂停和进度经域口与带 projectId 的事件回流；S5 报告保留生成文件内容供版本回看和 diff                    |
| renderer       | `PipelinePage` 读取真实项目和用户上下文，切项目重建会话；S4 编辑落库，队列从主进程恢复，版本切换提示下游重生成；工作台从七阶段 checkpoint 计算进度                                               |

#### 2.9.2 验收证据

| 要求                                      | 可核验的证据                                                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输入需求→S1→S5→退出进程→重启续跑          | `e2e/domain/e2e-26-electron-pipeline.test.ts` 启动两个独立 Electron 进程，经真实 BrowserWindow、preload、IPC、生产端口和 PipelinePage 操作；S5 先完成 1 个节点，重启只生成剩余 2 个，再保存并确认 S6/S7 报告      |
| 阶段版本、diff、activeVersion、stale 恢复 | `pipeline-production.test.ts` 验证历史读取、diff、版本切换和回退；S4 切回旧版再重建运行时后，拆分、指针和 stale 状态一致                                                                                          |
| 未完成技术选型禁止 S3                     | 同文件验证 `advance`、`startStage` 和直接 `generateTechDoc` 的阻断，以及选型写项目记忆后跨重启继续生效                                                                                                            |
| 节点失败隔离与队列控制                    | 同文件验证失败节点不阻塞其余节点、重启后仅重试指定节点、暂停/跳过持久化；直接关闭客户端会把中断节点恢复为待办，成功节点不会重复生成                                                                               |
| 失败不留半成品                            | 同文件用 SQLite 触发器使台账写失败，断言文档/版本/文件未发布；制造第二个代码文件的真实 OS 写入失败，断言第一个文件已撤销。`pipeline-persistence.test.ts` 验证 SQL 失败及文件发布后 SQLite 提交前/后的两个崩溃边界 |
| 真实 E2E 与领域测试区分                   | E2E-26 是 Electron UI/IPC/进程重启测试；E2E-22 保留为真实磁盘、SQLite 和 `CrashRecovery` / `PipelineRecovery` 的领域测试，不能作为 Electron 启动的证据                                                            |

#### 2.9.3 早期缺陷记录（2026-09-21，保留供追溯）

① **快照域名含 `:` 导致崩溃恢复在 Windows 上整体失效**。`@ec/core` 的 `CrashRecovery` 直接把领域名
拼进文件名，而流水线领域名是 `pipeline:<projectId>`（见 `PIPELINE_DOMAIN_PREFIX`）。Windows 上路径里的
`:` 会被解释成 **NTFS 备用数据流**：写入 / 读取 / `exists` 全都"成功"，但 `readdir` **永远列不出**这个条目
—— 于是 `detectPending()` 找不到任何脏快照，「上次异常退出」被静默改判成「正常退出」，
崩溃恢复在主平台上等于没有，而且 **POSIX 与 `MockShell` 夹具都复现不出来**（既有 18 项单测因此全绿）。
现改为落盘名只保留 `[A-Za-z0-9._-]`、其余字符转 `_`，逻辑域名照旧存信封 `domain` 字段供 `detectPending` 匹配；
`undo-crash-logger.test.ts` 补 1 项回归（断言落盘名 `pipeline_P-1.snapshot.json`、且信封域名仍是 `pipeline:P-1`）。

② **S5 的裸 JSON 兜底路径从未生效**。`MultiPlatformGenerator.parseFiles` 的兜底正则缺捕获组，
`jsonMatch[1]` 恒为 `undefined`，于是模型不带 ```json 围栏直接回 JSON 时，产物被当成"没有文件"整包丢弃
（文件落盘成功、台账有版本，但 `code/` 目录是空的）。改为 `jsonMatch[1] ?? jsonMatch[0]`。

#### 2.9.4 本次门禁实测（2026-10-01）

| 检查                                  | 结果                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                           | 通过，零 error / warning                                                                                                                                                   |
| `pnpm -r typecheck`                   | 17 个 workspace 全部通过                                                                                                                                                   |
| 流水线主进程与事务测试                | `pipeline-production.test.ts` 12/12；`pipeline-persistence.test.ts` 3/3                                                                                                    |
| 相关测试集合                          | 21 文件 / 264 项通过，含流水线、主进程、renderer、shell-api、SQLite 和 WritePipeline；完整复现命令见 [TEST-REPORT §5.2](TEST-REPORT.md#52-t12-03-生产运行时复验2026-10-01) |
| `pnpm test:e2e --no-file-parallelism` | 完整 E2E 套件 14 文件 / 55 项通过；E2E-26 为其中 1 项                                                                                                                      |

264 项是本次相关测试集合，不是全仓单测总数；旧全仓测试、覆盖率及独立 E2E 类型检查结果保留各自日期。
本次主进程与 Electron E2E 仅替换外部 AI 网关，模型回复为确定性夹具；没有验证真实模型生成质量、
七端工具链编译、真实安装包或人工录像走查。E2E-26 使用测试启动入口装配生产组件，窗口隐藏，
不会修改用户的项目或模型配置。准备条件见 [DEV-SETUP §3.1](DEV-SETUP.md#31-electron-流水线端到端测试)。

---

### 2.10 T12-05 归档、用量、备份与遥测生产接线（2026-09-22）

T12-01 把 `package` / `usage` 两域挂进了路由表，但**多处仍在生产环境必炸或空转**：预算配置写的是
不存在的列、遥测一个调用点都没有、自愈直接报 `NOT_SUPPORTED`、附件恒为空数组。本轮把四条链路
逐一接到真实数据上，并补上此前缺失的验收测试。

#### 2.10.1 改动清单（按职责）

| 层                      | 文件                                           | 改动                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主进程（新）            | `domain/telemetry-runtime.ts`                  | 新增遥测运行时：授权位取自持久化设置（默认 false），事件统一经 `buildEvent` 构造（内含白名单断言），`clearAll()` 覆盖**内存队列 + 文件缓冲 + 数据库记录**三层                                                                                                                                                                                                       |
| 主进程                  | `domain/domains/usage-domain.ts`               | **重写预算读写**：改用 `createSettingStore`（真实列 `value_json`，`user_id` NOT NULL），逐字段校验坏配置；新增 `onBudgetChanged` 回灌钩子；`budgetDecision` 与网关共用同一判定口径                                                                                                                                                                                  |
| 主进程                  | `domain/domains/package-domain.ts`             | **实现 `runHealing` / `adoptAnchorCandidate`**（替换 `NOT_SUPPORTED` stub）：锚点读 `code_anchor`、链接读 `memory_doc_link`、附件按内容寻址清点，报告落盘可导出；新增 `exportIncremental` / `getIncrementalCursor`；备份走 `createSnapshot` + `pruneSnapshots` + `restoreFromSnapshot`（回滚前自动安全快照）；装配 `BackupScheduler` 并暴露 `start()` / `dispose()` |
| 主进程                  | `domain/domains/package-domain.ts`（配置读写） | 备份配置 / 导出方案 / 增量游标全部改走 `createSettingStore`；新增 `HH:mm` 格式与保留份数校验（坏值会让调度器排不出下一次执行）                                                                                                                                                                                                                                      |
| 主进程                  | `domain/package-ports.ts`                      | **附件内容寻址落地**：`listAttachments()` 真实枚举 `<projectDir>/attachments/<sha256>.<ext>`；`putFile` 新增附件分支（按引用文档定位归属项目，无法判定时落到暂存目录而非丢弃）；`ensureDirs` 建出附件目录；新增 `resolveAttachmentOwner`                                                                                                                            |
| 主进程                  | `ai/runtime.ts`                                | 预算**从持久化配置装载**并注入 `createAiStack`；`setBudget` 同步落库；导出 `readPersistedBudget` 供测试断言；暴露 `handle`（含 `budget.configure`）给域工厂                                                                                                                                                                                                         |
| 主进程                  | `domain/domain-factories.ts`                   | usage 域接上预算回灌（`aiStack.budget.configure`）；package 域改为带生命周期的句柄；`disposers` 收编调度器停止；启动时执行备份补偿 `pack.start()`                                                                                                                                                                                                                   |
| 主进程                  | `domain/settings.ts`                           | 遥测三方法改走运行时（`inspectLocalTelemetry` / `clearLocalTelemetry` / `setTelemetry`）；`exportProject` / `importPackage` 增加关键路径埋点；默认导出选择纳入附件                                                                                                                                                                                                  |
| 主进程                  | `main/index.ts`                                | 域工厂接入 `aiRuntime.handle`（此前传 `null`，导致预算护栏接不上网关）                                                                                                                                                                                                                                                                                              |
| 契约（`@ec/shell-api`） | `src/domain-control.ts`                        | package 域白名单补 `exportIncremental` / `getIncrementalCursor`                                                                                                                                                                                                                                                                                                     |
| 契约（`@ec/shell-api`） | `src/ai-control.ts`                            | 新增 `AiStackHandle` 并在 `AiControlServiceHost` 上暴露可选 `handle`                                                                                                                                                                                                                                                                                                |
| 测试（新）              | `__tests__/domain-archive-telemetry.test.ts`   | 19 项验收测试：附件往返、用量真实读取、预算落库与前置阻断、备份配置校验、快照保留数清理、快照回滚、遥测默认关闭 / 白名单 / 三层清除、篡改检出、错误口令拒绝                                                                                                                                                                                                         |

#### 2.10.2 每条验收标准的落地证据

| 验收标准（任务卡原文）                                | 证据                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PackageApi / UsageApi / BackupSettings 真实注入且可用 | `domain-archive-telemetry.test.ts` 19/19 全绿，全部经**真实域运行时**（`createProductionDomains` + `createDomainRuntime`）调用，断言对象是落盘文件与表内行                                                                           |
| 导出/导入、冲突预览、五种导入模式、自愈报告可用       | 自愈已从 stub 换为真实实现（`runHealing` 读 `code_anchor` + `memory_doc_link` + 附件目录，报告落盘）；五种模式由 `mode-selector` 与既有 `import-mode-selector.test.ts`（6 项）覆盖                                                   |
| 增量包可用                                            | `exportIncremental` + `getIncrementalCursor` 已装配；`incremental-volume.test.ts` 实测全量 27722 字节 / 增量 1114 字节（4.0%）                                                                                                       |
| 附件不静默丢弃                                        | 导出：`counts.attachments ≥ 1` 且包内确实存在 `attachments/` 条目；导入：`putFile` 按内容寻址落回项目附件目录（无归属时落暂存目录，绝不丢内容）                                                                                      |
| 用量从真实 `usage_record` 读取                        | 插入真实行后 `listRows` 返回 `totalTokens=150` / `cost=0.25`，与源数据逐字段一致                                                                                                                                                     |
| **预算超限在真正调用模型前阻断**                      | 三重证据：① `budgetDecision` 超限返回 `ok=false`；② 持久化预算被 `readPersistedBudget` 读到（`dailyUsd=0.1`）；③ 用同一配置构造真实 `BudgetGuard`，已花费 0.25 > 0.1 ⇒ `check().ok === false`（`AiGateway.chat` 在发起请求前先调它） |
| 遥测默认关闭                                          | `createTelemetryRuntime({ enabled: false })` 下 `record()` 后缓冲为 0 且缓冲文件不存在（零 IO，非"发了再丢"）                                                                                                                        |
| 遥测 payload 断言不含内容字段                         | `assertEventPayloadSafe` 对 `prompt` / `code` / `apiKey` 三种夹带**全部抛错**；合法维度（`providerId` / `purpose`）不抛                                                                                                              |
| 隐私面板清除内存、文件缓冲和数据库记录                | `clearAll()` 返回 `fileCleared=2`，之后 `buffered()===0` 且 `pending()===0`，缓冲文件内容为 `[]`；同时尝试清理历史遗留遥测表                                                                                                         |
| 篡改 / 错误口令 / 高版本包不留半导入状态              | 篡改：按 ZIP 局部文件头精确定位压缩数据区并翻转字节 ⇒ `verifyPackage.ok=false` 且 `failureCode` 非空；口令：正确口令通过、错误口令 `failureCode='password'`（认证标签先校验后落盘）                                                  |
| 定时备份按日/周生成并按保留数清理，可一键恢复         | `createBackupNow` 生成规范命名 `ec-backup-<yyyymmdd-hhmmss>-<ms>-manual.ecpkg`；keepCount=2 时生成 3 份后仅留 2 份；`restoreFromSnapshot` 返回 `safetySnapshot`（含 `pre-restore`）                                                  |

#### 2.10.3 本轮修掉的真实缺陷（5 处）

① **`setting` 表列名不匹配（生产必炸）**：`usage-domain` 与 `package-domain` 此前写
`SELECT value FROM setting WHERE key = ?` / `INSERT INTO setting (key, value)`，而迁移 `0001`
定义的真实列是 `value_json` / `value_text`，且 `user_id` 为 NOT NULL。一旦用户点下「预算」或
「定时备份」，必然 `SqliteError: no such column: value`。**症状隐蔽**：装配期没有真实调用时不暴露。
现全部改走 `createSettingStore`（同一入口已在 git/preview 域验证过）。

② **预算配置从未进入 AI 网关（"改了预算却还在烧钱"）**：用量面板把预算写进 `setting` 表，
而 `createAiStack` 构造时用的是 `DEFAULT_BUDGET`（全 `null` = 不限），两侧**各持一份互不相干的状态**。
后果是「设置里配了预算，实际调用模型时毫无反应」，任务卡要求的"请求前阻断"在生产链路上不成立。
现由 `readPersistedBudget` 装载注入，并让 `usage.setBudget` 经 `onBudgetChanged` 即时回灌运行中的 `BudgetGuard`。

③ **遥测零生产调用点**：`TelemetryClient` / `Telemetry` / 事件目录在 `@ec/core` 里实现完备，
但没有任何业务代码调用 `track`。于是"关键路径埋点覆盖率"只在测试里成立，真实运行不产生任何埋点，
隐私面板也没有对象可清。现新增 `telemetry-runtime.ts` 并在导出/导入等关键路径接入。

④ **自愈引擎整体 `NOT_SUPPORTED`**：`package-kit` 的 `anchor-relocator` / `link-fixer` /
`attachment-checker` / `healing-report` 四模块与测试都齐备，主进程却直接抛
`NOT_SUPPORTED`，导入后自愈（FR-PKG-10，P1）实际不可用。现接到 `code_anchor` /
`memory_doc_link` / 附件目录三处真实数据源，报告落盘可导出。

⑤ **附件恒为空数组**：`listAttachments()` 返回 `[]` 而 `attachments: false` 写死，
但 `runExport` 的 `includes` 逻辑与 UI 勾选项都宣称支持附件——用户勾了"包含附件"却什么都拿不到，
属于"静默丢弃"。现按内容寻址真实枚举与落盘，`counts.attachments` 如实计数。

#### 2.10.4 门禁实测（2026-09-22）

| 命令                    | 结果                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`             | ✅ 零 error 零 warning（`--max-warnings 0`）                                                                                          |
| `pnpm format:check`     | ✅ `All matched files use Prettier code style!`（6 个文件补格式化后）                                                                 |
| `pnpm -r typecheck`     | ✅ 全仓零错误                                                                                                                         |
| 新增验收测试            | ✅ `domain-archive-telemetry.test.ts` **19/19**                                                                                       |
| 受影响主进程回归        | ✅ `domain-settings` 26/26、`domain-runtime` 13/13、`domain-production` 15/15、`domain-content-ports` 17/17、`domain-run-ports` 16/16 |
| 核心包回归              | ✅ `package-kit` + `core` + `shell-api` + `ai` 共 **61 文件 / 711 项全绿**                                                            |
| `pnpm test:e2e`         | ✅ **12 文件 / 42 项全绿**（含 E2E-13/14 归档往返与冲突决策）                                                                         |
| 埋点覆盖率              | ✅ 关键路径事件 **40/40 = 100.0%**（`telemetry-coverage.test.ts`）                                                                    |
| 增量体积实测            | ✅ 全量 27722 字节（100 文件）/ 增量 1114 字节（2 文件变更）= **4.0%**                                                                |
| 1 万文件导出 / 流式读写 | ✅ 导出 25.4s ≤60s；流式读写 RSS 增长 81.9MB（阈值 350MB）                                                                            |

> **环境退化项（非代码问题）**：`domain-workspace-git.test.ts` 的克隆用例在默认 15s 预算下超时。
> 实测 `git --version` 已退化到 **1.7–2.5s**（健康基线 ≈759ms），按既有约定**不改测试预算**；
> 用 `--testTimeout=120000` 复跑 **9/9 全绿**，确认是环境成因。

> 仍未闭环：`pnpm dev:electron` 的人工 GUI 走查需要真实桌面会话（同上节）。
> 附件导出已真实落地，但**本仓库当前没有产生附件的业务入口**（设计器素材上传尚未实现），
> 因此附件的生产路径由集成测试以"手工放入内容寻址文件"的方式验证——端口行为正确，
> 待素材上传功能落地后即自动进入真实链路。

---

### 2.11 T13-01 Tauri 双形态功能等价：业务运行时经受控侧车承载（2026-09-22）

**本轮要消灭的状态**：Tauri 形态此前是个"半壳"——`bridge.ts` 里 `ai` 与 `domain`
**写死** `false`，域调用一律回 `NOT_SUPPORTED：Tauri 外壳尚未接入域端口运行时`，
AI 命令是占位实现。即 D-01「两版功能等价」在 Tauri 侧从未成立。

#### 2.11.1 方案决策（记录在案，便于复核）

| 选项                                          | 结论        | 理由                                                                                                                                          |
| --------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 把业务运行时迁进 Rust                      | ❌ 否决     | 15 个域 + AI 栈 + `@ec/*` 领域内核 + better-sqlite3 全为 Node 侧 TS。迁进 Rust = **重写第二遍**，两份实现必然漂移，与「同一套领域包」直接冲突 |
| B. **受控 sidecar 承载现有 Node 领域代码**    | ✅ 采纳     | 业务逻辑**一行都不重复**；Rust 只做生命周期、协议搬运与宿主能力。可维护性与"等价"同时成立                                                     |
| C. 在 Tauri bridge 中伪造 Electron 的成功返回 | ❌ 明令禁止 | 会让"没接"表现成"业务错误"，是最难定位的一类故障                                                                                              |

采纳 B 的关键前提是**代码本来就是外壳无关的**：全仓只有 2 个文件 `import 'electron'`
（`main/index.ts` 与 `preload/index.ts`），所有域模块都以参数注入依赖。因此新增
`src/main/runtime/bootstrap.ts` 把装配抽成纯函数（不碰任何 Electron API），
**Electron 与侧车共用同一份装配**：

```
Electron:  渲染层 → preload → ipcMain ─┐
                                       ├─► domain-runtime（同一个 createHeadlessRuntime）
Tauri:     渲染层 → invoke → Rust 命令 ─┘     ▲
                              │  NDJSON       │
                              └────────► 侧车进程（Node）
```

> **Electron 主进程已同步迁到这份装配**（本轮一起做的）：`main/index.ts` 原先自带一份
> `buildDomainRuntime()`（约 125 行），已删除，改为调用 `createHeadlessRuntime()` 只做
> 「外壳侧注入」（`app.getPath` 的目录、`safeStorage`、外链、剪贴板）。
> 这一步是必要的：不迁的话"共用同一份装配"只是文档里的说法，两形态仍会各自漂移。
> 迁移后 `before-quit` 只需一次 `runtime.dispose()`（AI 栈已是域运行时 disposers 里的一项，
> 重复释放会让它的 `db.close()` 跑两遍并掩盖真实失败）。
> 验证：`tsc` 零 error、`esbuild` 主进程产物可出（11.3MB）、`apps/desktop-electron` 测试 **21 文件 / 265 项全绿**。

#### 2.11.2 协议（NDJSON over stdin/stdout）

| 帧                 | 方向        | 用途                                                                                                                              |
| ------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `hello`            | 侧车 → 宿主 | 自报协议版本 / pid / node / features                                                                                              |
| `welcome`          | 宿主 → 侧车 | 协商结果 + **宿主 DPAPI 可用性** + 运行时配置                                                                                     |
| `ready`            | 侧车 → 宿主 | 15 个域逐个可用性 + 原因 + AI 可用性 + 同步口域清单                                                                               |
| `req` / `res`      | 双向        | 调用与应答（`id` 关联）：`domain.invoke` / `domain.describe` / `ai.invoke` / `ai.stream.start` / `ai.abort` / `shutdown` / `ping` |
| `evt`              | 侧车 → 宿主 | 单向事件：`domain.event` / `ai.stream` / `log`                                                                                    |
| `host` / `hostres` | 双向        | **侧车请求宿主能力**：`secure.encrypt` / `secure.decrypt` / `shell.openExternal` / `clipboard.writeText`                          |
| `bye`              | 侧车 → 宿主 | 终止原因 + 建议退出码（0 计划内 / 3 协议不兼容 / 4 装配失败 / 5 未捕获异常）                                                      |

**DPAPI 的设计要点**：Node 侧没有 DPAPI，而密钥必须用它。做法是侧车把加解密原语
**回传宿主执行**——Rust 侧复用 `commands/secure_store.rs` 里**同一份** `CryptProtectData`
实现（本轮把 `dpapi_encrypt/decrypt` 提升为 `pub(crate)`）。因此：

- 磁盘上仍然只有密文（`<secureDir>/<ns>/<key>.dat` 布局与 Electron 一字不差）；
- 两形态的密文由同一实现产出，可互解；
- 宿主 DPAPI 不可用时，侧车**不装配 auth 域、不装配 AI 栈**，并各自给出原因
  （`createGitCredentialStore` 同口径），绝不落明文。

为此把 `SafeStorageLike` 的加解密原语放宽为 `Buffer | Promise<Buffer>`：Electron 传同步实现，
侧车传跨进程异步实现，**下游三个存储实现共用同一份落盘逻辑**（只多一个 `await`）。

#### 2.11.3 每条验收标准的落地证据

| 验收要求                                          | 证据                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 选择并记录一种可维护方案                          | §2.11.1；`apps/desktop-electron/src/main/runtime/bootstrap.ts` 文件头                                                                                                                                                                                                                                    |
| 不得伪造成功                                      | 侧车不可用时 `Rust → 合成 DomainRpcResponse{ok:false,error}`；`capabilities()` 的 `ai/domain` 来自 `sidecar_status` 真实结果；`HostCallError` 取不到字段即抛错而不是返回空串                                                                                                                             |
| 先四域、再生产能力域                              | 两个 sweep 用例：四域 **69/69** 方法 + 11 个生产能力域逐方法，断言**不出现**"尚未接入/未装配"形态的 `NOT_SUPPORTED`                                                                                                                                                                                      |
| 共用 shell-api 契约，错误码/域事件/结构化克隆一致 | 侧车复用 `@ec/shell-api` 的 `DOMAIN_KINDS` / `DOMAIN_RPC_METHODS` / `isDomainRpcMethod` / `domainErrorFromUnknown` / `createDomainEventSink`；请求内事件按 `requestId` 注册回传（与 Electron 的 `ipc/domain.ts` 同构），无归属事件走 `broadcast` + 固定哨兵 id                                           |
| AI：Provider/Model                                | `ai.invoke` 的 32 方法白名单；`listProviders/listAllModels/budgetConfig/setBudget` 走真实栈并断言落库读回                                                                                                                                                                                                |
| AI：DPAPI / 安全存储                              | §2.11.2；断言 `secure.encrypt` 真的被调用过（`hostCalls`）                                                                                                                                                                                                                                               |
| AI：流式生成                                      | `ai.stream.start` + 事件总线；两个测试桥接层用例断言按 `requestId` 过滤、`done` 后自动退订、未接受时补 `error + done`                                                                                                                                                                                    |
| AI：usage/budget                                  | `setBudget` 经 `setting.usage_budget` 落库并由 `onBudgetChanged` 即时回灌网关（复用既有实现）                                                                                                                                                                                                            |
| AI：远程配置                                      | `remoteSource` 系列方法在 `ai.invoke` 白名单内；`refreshRemoteSourcesOnBoot` 已接线                                                                                                                                                                                                                      |
| AI：WritePipeline                                 | `code.plan/apply` + 已登记的 `code:write-plan` 域事件（复用既有实现）                                                                                                                                                                                                                                    |
| 无能力必须 negotiate 为 false 并给出理由          | 新增 `ShellCapabilities.reasons`（可选字段）+ `negotiate()` 的 `degradedReasons`；Tauri `capabilities()` 填入真实原因                                                                                                                                                                                    |
| Rust/sidecar 生命周期测试                         | `sidecar/tests.rs`（路径安全/协议/base64/契约名/活体握手）+ `sidecar-lifecycle.test.ts`（协议不兼容、宿主早退、崩溃收尾、幂等 shutdown、装配失败、装配中宿主退出、未就绪拒绝）                                                                                                                           |
| 崩溃清理测试                                      | 宿主关闭 stdin → 侧车自行退出（Node 侧真进程用例）；宿主 `RunEvent::Exit` → 协议 `shutdown` → 超时 `taskkill /T /F` 整棵进程树                                                                                                                                                                           |
| 路径安全测试                                      | `validate_sidecar_dir` 五道关 + `is_within` 组件级比较（`C:\root-evil` 不匹配 `C:\root`）+ 四组拒绝用例                                                                                                                                                                                                  |
| 升级兼容测试                                      | 清单协议校验（**启动前**）+ 握手协议校验（**运行时**）+ 活体用例断言两侧版本一致 + `sidecar-process.test.ts` 的 manifest 常量比对                                                                                                                                                                        |
| 不引入 renderer 对 Tauri API 的直接依赖           | 渲染层仍只 import `@ec/shell-api`；`@tauri-apps/*` 的使用被限制在 `apps/desktop-tauri/src/bridge.ts` 一处（既有约束未被打破）                                                                                                                                                                            |
| 四域每个方法至少一条真实端到端测试                | `sidecar-service.test.ts`：真实 SQLite + 真实迁移 + 真实工程目录 + **真实 HTTP 账号服务**；四域白名单 69 方法逐条分发，且 workspace/docs/auth/settings 各有一条**全链路成功**用例（auth 走真 HTTP + DPAPI 往返）                                                                                         |
| Tauri 实机启动后…                                 | 本机无桌面会话，**进程内等价证据 + 真实进程证据**两段拼齐：`sidecar-service.test.ts`（内存管道跑真实协议）与 `sidecar-process.test.ts`（真起 `node dist/sidecar/*.cjs`）、`cargo test` 的 `live_handshake_with_a_real_sidecar_process`（Rust 起真实侧车跑完 handshake）。仅剩"窗口渲染"一段未走（见 §3） |

#### 2.11.4 本轮修掉的真实缺陷（7 处）

| #   | 缺陷                                                        | 根因与后果                                                                                                                                                                                                                                                    | 修复                                                                                                                                                   |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **订阅在建立完成前被全部退订 → 永久泄漏**                   | `sidecar_subscribe` 是异步的；若调用方在 promise 解析前就退订（短命组件 / 立即 unmount），`sidecarSubId` 仍为 `null`，释放分支不成立 → 该订阅**永不回收**，持续占用 Rust 侧订阅表上限（症状：用久了新订阅全部失败）                                           | 订阅返回后立即调 `releaseSidecarSubscriptionIfIdle()`。**由测试抓出**（`多个监听器共用一条订阅…不泄漏`）                                               |
| 2   | 装配期间宿主退出 → 新建的运行时无人释放                     | `finish()` 已经把状态置为 settled，而 `createRuntime` 随后才返回；`runtime` 被赋值后无人 dispose → 泄漏 SQLite 句柄与预览后端子进程（下次启动撞锁/撞端口）                                                                                                    | 装配返回后检查 `settled`，成立则立刻 `dispose()` 并返回                                                                                                |
| 3   | 宿主能力应答取值错误                                        | 侧车按结构化对象取 `plainText/cipherBase64`，而宿主回到的是 `{plainText}` 包装；取不出来会被当成"加密成功但密文为空"——比失败更糟的静默损坏                                                                                                                    | 改为 `fieldOf()` 显式取字段，**取不到即抛错**；空串不被接受                                                                                            |
| 4   | 未消费的 `ready` 拒绝掩盖真失败                             | 并非每条用例都会 `await ready`；拒绝成为 `unhandledRejection`，被框架记成"用例外的错误"，与真正失败的断言混在一起                                                                                                                                             | harness 挂空 catch 消费；`finishWith` 让 ready **立刻**带原因失败，而不是挂到 hookTimeout（超时信息里没有任何线索）                                    |
| 5   | `ai.stream` 未被接受时只回 `accepted:false`                 | 界面拿不到终止信号 → **永远转圈**                                                                                                                                                                                                                             | Tauri 桥接层显式补 `error` + `done`（两条事件），与新协议口径一致                                                                                      |
| 6   | 侧车 stdout 易被 `console` 污染                             | 领域代码/第三方库的 `console.info` 会混进 NDJSON → 宿主随机解析失败（最难定位的一类）                                                                                                                                                                         | 侧车入口把 console 全部改道 stderr；并由**真进程用例**断言"stdout 每行都是合法协议帧"，同时反向断言 stderr 确实收到了日志                              |
| 7   | `domain-workspace-git.test.ts` 的清理把用例判成失败（假红） | `afterEach` 里裸 `rmSync(root)`；Windows 上 SQLite 的 WAL 与 `git` 刚写过的 pack 目录在 `db.close()` 之后仍被短暂占用 → `EPERM`。**全量并发**跑时这一拍被拉长，于是"断言早已通过"的用例被清理动作判红（本轮全量跑出现 2 例；单跑该文件 **9/9 全绿**可作对照） | 改为 `cleanupTempDir()`：重试 4 次（退避 60/120/180ms，`Atomics.wait` 同步小睡），仍失败只 `console.warn` 留痕。**断言部分不做任何放松**——只让清理容错 |

#### 2.11.5 本轮新增测试（89 项）

| 文件                                                                          | 项数 | 覆盖内容                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop-electron/src/sidecar/__tests__/sidecar-service.test.ts`         | 17   | 握手/ready/describe；**四域白名单 69 方法逐条真实分发**；11 个生产能力域逐条分发；四域全链路成功（含真 HTTP auth + DPAPI 往返）；域事件按 requestId 回传；AI 真实栈（Provider/Model/预算落库）；错误码与脱敏；stdout 纯净                                          |
| `apps/desktop-electron/src/sidecar/__tests__/sidecar-lifecycle.test.ts`       | 11   | 协议不兼容拒绝服务（码 3）；宿主握手前退出；宿主死亡侧车自退；幂等 shutdown；装配失败上报（码 4）；装配中宿主退出不泄漏；未就绪结构化拒绝；DPAPI 不可用时 auth/AI 如实降级且逐个带原因                                                                             |
| `apps/desktop-electron/src/sidecar/__tests__/sidecar-process.test.ts`         | 6    | **真起进程**：握手→ready(15 域)→真实域调用→shutdown→bye；stdout 纯净 + stderr 留痕；Windows SIGTERM 硬杀语义；宿主关闭 stdin 自退；协议不兼容码 3；未知 op 后连接仍健康                                                                                            |
| `apps/desktop-electron/src/sidecar/__tests__/host-bridge.test.ts`             | 8    | DPAPI 原语往返 / 失败不伪造 / 缺字段抛错；外链与剪贴板端口（fire-and-forget 但留痕）                                                                                                                                                                               |
| `apps/desktop-electron/src/sidecar/__tests__/protocol.test.ts`                | 5    | 帧编解码；半截 JSON / 空行 / 非帧对象一律 `null` 不抛错；主版本兼容判定                                                                                                                                                                                            |
| `apps/desktop-tauri/src/__tests__/bridge-sidecar.test.ts`                     | 16   | 能力协商（含四种降级）；域 RPC 透传与结构化失败；describe 降级为 15 域全不可用；事件订阅惰性建立/共用/释放/脏数据丢弃；AI invoke/stream/abort（含 `done` 后退订、未接受补事件）                                                                                    |
| `src-tauri/src/sidecar/tests.rs` + `protocol.rs` 内联 + `commands/ai.rs` 内联 | 26   | 路径安全五道关与四组拒绝；`is_within` 组件级比较；base64 往返与非法输入；**跨语言 op/capability/event 名逐字比对**；welcome/req/hostres 帧的 camelCase 键名；真实 hello/ready/res/host/bye 文本解析；未知帧忽略；**真实侧车进程活体握手**（15 域 + auth 如实降级） |

#### 2.11.6 门禁实测（2026-09-22）

| 命令                                        | 结果                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `cargo check`                               | ✅ 零 error 零 warning                                                                              |
| `cargo clippy --all-targets -- -D warnings` | ✅ 零 warning（本轮修掉 `is_multiple_of` 与死代码两处）                                             |
| `cargo test`                                | ✅ **24/24 通过**，含 `live_handshake_with_a_real_sidecar_process`（Rust 起真实 Node 侧车完成握手） |
| `pnpm lint`（`--max-warnings 0`）           | ✅ 零 error 零 warning                                                                              |
| `pnpm -r typecheck`                         | ✅ 17/17 包通过                                                                                     |
| `vite build`（`apps/renderer`）             | ✅ **611 modules**，`✓ built in 25.62s`（证明新代码没有把 Node 模块带进浏览器构建）                 |
| 侧车测试（5 文件）                          | ✅ **48/48**                                                                                        |
| Tauri 桥接测试（3 文件）                    | ✅ **34/34**                                                                                        |
| **全仓单测**                                | ✅ **248 文件 / 2552 项全绿，0 失败**（226.7s，未改任何超时预算）                                   |
| 侧车产物                                    | ✅ 11.4MB bundle + 迁移目录 + `sidecar-manifest.json`（protocol=1）                                 |

> **环境说明（非代码问题）**：`cargo test` 首次运行时报
> `应用程序控制策略已阻止此文件。(os error 4551)`——Windows 应用控制策略对新编译出的
> 可执行文件有短暂拦截，**重跑即通过**；这与既有记录（SAC 拦未签名 build script）同源。
> 另：`vite build` 首次因 `dist/assets` 被占用报 `EPERM`，清空 `dist/` 后重跑通过。

#### 2.11.7 仍未闭环（详见 `docs/CAPABILITY-MATRIX.md §4`）

| 项                                   | 现状                     | 需要什么                                                                                                  |
| ------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Tauri 安装包产出与体积实测           | 未产出                   | MSVC C++ 生成工具（本机无管理员权限，L-09）                                                               |
| 侧车随包分发（发行形态）             | 未做                     | `bundle.resources` 加入 `dist/sidecar/**` 与 `node.exe`；侧车目录放 `node.exe` 即被优先采用               |
| 侧车与 Node 的 ABI 绑定              | 未实测发行形态           | 随包 Node 须为 ABI 137 同代（`better-sqlite3` 的 Node 侧绑定按 v24 构建）                                 |
| Tauri 实机 GUI 冒烟（窗口/首屏）     | 未执行                   | 一次人工走查（本机为无人值守会话）                                                                        |
| memory / pipeline 的**同步签名端口** | Tauri 不暴露（结构限制） | Tauri 渲染层无同步 IPC 原语；用异步伪装同步会读到上一拍数据（伪造），故如实不注入。两域本身可用，走异步口 |

#### 2.11.8 复验：无 MSVC 机器上的实机启动与诚实边界（2026-09-30）

**复验动机**：§2.11.1~2.11.7 的结论产出于一台装有 MSVC + Rust 1.98.1 的机器。本轮换一台
**没有 MSVC、没有管理员权限**的 Windows 机器复跑，并把"能跑到哪一步"分开记账 ——
换机器复验的价值恰恰在于：**只在真启动时才会现形的问题**（§2.6 记录过 4 处）不会藏在单测里。

**0. 先修掉一个环境级故障（不是代码问题）**

`node_modules` 里 **2328 个 junction** 与 **435 个 `.bin` shim** 的 `NODE_PATH` 全部指向旧的
`D:\code\program\everyoneCoding`（本次工作树在 `F:` 盘），直接表现为 `esbuild` / `vitest`
无法解析（`ERR_MODULE_NOT_FOUND`）。源码内除历史任务卡外**没有** D: 绝对路径，故这纯粹是
"目录树被整体搬盘后链接未重建"。修复：按新根重写这些链接与 shim（只动 `node_modules`）。
**未用 `pnpm install` 修**：它会重建 `better-sqlite3` 绑定（需 MSVC 或 GitHub 预编译包，本机都不具备），
把"能跑的单测"一起弄坏。

**1. 工具链（免管理员，非官方支持）**

新增 `apps/desktop-tauri/scripts/setup-rust-tauri-gnu.ps1`：rustup 的
`stable-x86_64-pc-windows-gnu`（自带 rust-mingw 的 mingw-w64 CRT）+ Zig 0.16 提供
C 编译器 / `dlltool` / `windres`，链接交给 rustc 自带的 `rust-lld`。实测踩出并固化在脚本里的四处适配：

| #   | 障碍                                 | 现象                                                                                                                    | 处理                                                                         |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | rust-mingw 只有 CRT 导入库，无链接器 | GNU 目标默认找 `gcc`；Zig 的 `cc` 又会崩（事件日志 0xC0000005）                                                         | 改用 `rust-lld`（`-Clinker-flavor=ld.lld`）+ `-Clink-arg=-L<self-contained>` |
| 2   | 无 C 编译器（`ring` 需要）           | Zig 拒绝 LLVM 风格三元组 `x86_64-pc-windows-gnu`（UnknownOperatingSystem）；且 Debug 默认开 UBSan，链接期缺 `__ubsan_*` | shim 固定 `-target x86_64-windows-gnu` 并加 `-fno-sanitize=undefined`        |
| 3   | rustc 生成导入库要 `dlltool.exe`     | `error calling dlltool 'dlltool.exe': program not found`                                                                | 用 Zig 的 `dlltool` 顶替（做成 `dlltool.exe`）                               |
| 4   | `tauri-build` 要 `windres`           | `tauri-winres` panic：`NotAttempted("windres")`                                                                         | 用 Zig 的 `rc` 顶替，并把 windres 风格参数翻译成 rc.exe 风格                 |

**2. 门禁与实机结果**

| 观测项                                      | 结果                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cargo check --locked`                      | ✅ 退出码 0                                                                                                                                            |
| `cargo clippy --all-targets -- -D warnings` | ✅ 退出码 0                                                                                                                                            |
| `cargo build --locked`                      | ✅ 退出码 0                                                                                                                                            |
| **真实启动 `everyone-coding.exe`**          | ✅ 窗口标题 `EveryoneCoding`、`Responding=True`；`msedgewebview2.exe`（154.0.4258.48）渲染进程就位                                                     |
| **侧车随应用启动**                          | ✅ `node.exe ...\dist\sidecar\everyone-coding-sidecar.cjs` 作为子进程存活                                                                              |
| **侧车真实建库（域运行时装配成功）**        | ✅ `%APPDATA%\com.everyonecoding.desktop\data\everyonecoding.sqlite`：**34 张表 / 6 个迁移 / FTS 表 / 1 行本地用户**；目录布局与 Electron 形态逐字一致 |
| **宿主崩溃清理**                            | ✅ 强杀宿主后 6 秒内 `node.exe` 归零（侧车读 stdin EOF 自退），无孤儿进程                                                                              |
| **宿主优雅关闭（关窗口）**                  | ✅ 关窗后 5 秒内宿主退出、侧车进程树归零。**这一条在本轮第一次跑时是红的**，见下方「2.1 本轮修掉的真实缺陷」                                           |
| `pnpm build:renderer`                       | ✅ 通过（`vite build` 2.44s）                                                                                                                          |
| `pnpm lint`                                 | ✅ 零 error 零 warning                                                                                                                                 |
| 侧车 + Tauri 桥接测试（Node 侧）            | ✅ **8 文件 / 82 项全绿**（含"四基础域白名单内每个方法都被真实分发"）                                                                                  |
| 全仓单测（Node 侧）                         | ✅ **2589/2589 通过**                                                                                                                                  |
| `cargo test`（**执行** Rust 单测）          | ⚠️ **未执行**：`cargo test --no-run` 能产出测试二进制，但 `everyone_coding-*.exe`（lib 测试）以 `STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)` 退出        |

**2.1 本轮修掉的真实缺陷：关闭窗口永久挂死（P0，只在真机关窗时现形）**

| 项         | 内容                                                                                                                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 现象       | 启动 Tauri 应用后**关闭窗口，进程永不退出**。实测：发 `WM_CLOSE` 后连续观测 120 秒，`everyone-coding.exe` 仍存活、侧车仍在跑，只能从任务管理器强杀；另一次运行还留下 2 个孤儿 `node.exe`（父进程已死）                                                                                   |
| 根因       | `SidecarManager::shutdown()` 先取 `self.lifecycle`（`tokio::sync::Mutex`，**不可重入**），随后调用 `self.request(op::SHUTDOWN, …)`；而 `request()` 第一步是 `ensure_ready()`，它**要再取一次同一把锁** → 关窗口时永久死锁。`SHUTDOWN_TIMEOUT` 根本没机会生效（挂的是锁，不是那一次请求） |
| 次生缺陷   | 预热任务与 `shutdown()` 抢同一把锁：若 `shutdown()` 先拿到，此时 `phase` 还是 `Idle`、`child` 还是 `None`，它走早退分支直接返回；预热任务随后把侧车拉起来，而 `RunEvent::Exit` 只跑一次 → 那个进程没人回收（就是上面那 2 个孤儿）                                                        |
| 修复       | ① `shutdown()` 改为**直接写 `shutdown` 帧**（这里只要把话带到，不需要应答），不再经由 `request()`，死锁消失；<br>② 新增 `Inner::shutting_down`：`shutdown()` 在**拿锁之前**先立旗，`start()` 在 spawn 前与 spawn 后**各检查一次**（后者负责回收"刚 spawn、还没登记"的那一拍）            |
| 复验       | 关窗后 **5 秒内宿主退出、侧车进程树归零**；连跑多轮均为 0 孤儿。`cargo check` / `cargo clippy --all-targets -- -D warnings` / `cargo build` 均退出码 0                                                                                                                                   |
| 为什么漏了 | 这条路径只有"真的去点关闭窗口"才会走到：§2.11.6 的 `cargo test` 活体握手用例直接 spawn 侧车、不走 `SidecarManager`；Node 侧用例也覆盖不到 Rust 的锁语义。历史记录里 Tauri 形态从未做过 GUI 走查（§3 一直是"未执行"），所以它一直没被发现                                                 |

> 这正是 §2.6 那条经验的翻版：**只在"真启动 / 真交互"时才会现形的问题，单测与构建都发现不了**。

**3. 对 `cargo test` 这一项的排查边界（避免把"没查"写成"查不出"）**

已排除的假设，逐条附证据：

- **不是导入表缺符号**：用独立解析器逐条比对 458 个导入符号 → 全部可解析；把测试二进制当镜像
  `LoadLibrary` 亦**成功**（说明导入解析完整）。
- **不是 PE 结构问题**：入口点 `0x13f0`、子系统 3、`SizeOfImage` 正常；两个可运行二进制（app、
  `src/main.rs` 测试）与它的可选头字段一致。
- **不是 delay-import / 伪重定位**：数据目录无 delay-import；`.refptr` 节不存在。
- **不是 WebView2Loader**：用只导出所需符号的桩 DLL 替换后错误码不变；且其符号集是 app 的**真子集**
  （app 能跑）。
- **不是 Zig 编译的 C 目标文件**：单独建 `ring` 探针可编译、可运行、输出正确。
- **不是 `--disable-auto-image-base` / `--high-entropy-va`**：去掉后仍失败。

结论：这是 `x86_64-pc-windows-gnu` 这条**非官方路径**的运行期限制，**不是仓库代码缺陷**
（同一份代码在 MSVC 官方工具链下 `cargo test` 24/24 全绿，见 §2.11.6）。
要跑 Rust 单测，仍需按 `scripts/setup-rust-tauri.ps1` 装 MSVC。

**4. 本轮附带的小修**

- `apps/desktop-tauri/src/__tests__/tmp-debug.test.ts`（历史遗留的临时命名）合并进
  `bridge.test.ts` 的「Windows 语义回归」块，测试项数不变（34 项）。
- `apps/desktop-tauri/README.md` 的「已知限制」此前仍写着"域端口 / AI 栈未接入、
  `bridge.ts` 的 `domain` 与 `ai` 如实返回 `NOT_SUPPORTED`"——与代码现状相反，已改为如实描述
  侧车承载方案，并补上双形态架构说明与 `scripts/` 目录。
- **`pnpm version:check` 在 HEAD 上就是红的**（本任务之前即如此）：`apps/desktop-electron/electron-builder.yml`
  缺少 `extraMetadata.version`，而 `ci/version.mts` 读写的正是这一段（`docs/RELEASE.md §1` 把它列为五处版本落点之一）。
  缺了它，Electron NSIS 产物版本不再来自单一事实源，CI 的 `version-guard` 也会直接失败。
  已按文档口径补回该段（5 行），`pnpm version:check` 与 `pnpm version:sync` 均恢复通过且幂等。
- **`pnpm test:e2e` 的 E2E-01 / E2E-02 断言过时**（本任务之前即红；**已按当前契约修正，e2e 恢复 42/42**）：
  Wave 9 把 account 契约对齐为 `{ identity, tokens }`（`services/account/src/__tests__/contract.test.ts`
  头部注释即为该口径），而这两个用例仍断言旧的扁平字段。修法：`register` 与 `oauth callback` 改读
  `identity.accountId` / `tokens.{accessToken,refreshToken}`；`login` 的 refresh 令牌改读 `tokens.refreshToken`；
  `/api/auth/refresh` 本身回的就是**扁平**令牌对，那处断言保持不变并补注释说明口径来源。
- **`tsc -p e2e/tsconfig.json` 的 4 项 error**（本任务之前即红；**已修回零 error**）：
  `e2e/domain/e2e-24-git-production-flow.test.ts` 直引 `@ec/shell-api` 的 `DomainRouter` /
  `DomainRouterContext`（这两个签名早已迁到 `apps/desktop-electron/src/main/domain/runtime.ts`）、
  直引 e2e 工程解析不到的 `better-sqlite3` 类型、并把冲突块写成 `unknown[]` 导致 `blocks[0].index` 报错。
  修法：路由类型改从主进程 runtime 引，DB 类型改用 `ReturnType<typeof openBusinessDb>`，
  `conflicts` 改用 `@ec/git` 的 `ConflictFile`。E2E-24 实跑仍绿（真实 git 全流程 5.1s）。

### 2.12 Wave 9 收口：文档 AI 摘要、图片 OCR 与账号完整闭环（2026-09-23）

> 本轮把 Wave 9 遗留的三条"半截链路"打通：文档的「一键转记忆」此前只报 `NOT_SUPPORTED`、
> 图片导入没有可用的文字提取、账号侧的邮箱验证与 OAuth 辅通道缺实现。同时修掉一个
> **跨 6 个域的潜伏缺陷**（见 2.12.3 D-01）。

#### 2.12.1 改动清单（按职责）

| 层                        | 改动                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docs 域（主进程）         | `DocsDomainOptions` 增 `aiStack` / `ocr` / `extractionPurpose`；新增 `createGatewayExtractionPort`（以 `purpose=memory-extract` 调网关，解析「标题：xxx + 空行 + 正文」，保留 `sourceRef.docId/anchor`，失败抛结构化原因，**不伪造摘要**）；新增 `ocrStatus` 方法                                                                                             |
| OCR（`@ec/core`）         | 新增 `packages/core/src/docs/parsers/windows-ocr.ts`：经 PowerShell WinRT 子进程调 `Windows.Media.Ocr`；临时 `.ps1` 以 UTF-8 BOM 落盘、强制 `[Console]::OutputEncoding=UTF8`、stdout 按 UTF-8 解并在异常时回退 GBK（中文环境 PowerShell 默认 cp936）                                                                                                          |
| 图片解析                  | `makeImageParser` 捕获引擎异常 → `DocDomainError('ocr_unsupported')`（此前裸异常会被归一成 `UNKNOWN`，用户看到的是"未知错误"而不是"缺 OCR 语言包"）                                                                                                                                                                                                           |
| 服务端（account）         | 新增 `migrations/0002_email_verification.sql`（`email_verified` 列 + `account_email_token` 表）与 `0003_email_outbox.sql`；新增 `mailer.ts`（`MailerPort` + outbox/webhook 两种实现）与 `routes/verify-page.ts`；`routes/auth.ts` 契约对齐并新增邮箱验证 / 重置密码 / 开发期 outbox 接口；`config.ts` 增 `publicBaseUrl` 并把验证链接默认指向服务自托管落地页 |
| 客户端契约（@ec/account） | `beginOAuth` 改为使用**服务端签发的 state**（服务端在 authorize 时暂存 PKCE challenge，回调时校验）；回调经 `ingestCallback` 统一入口；新增 `waitForCallback` / `confirmEmailVerification` / `emailVerified` / `requestPasswordReset`；`unbind` 改按 `bindingId`                                                                                              |
| Electron auth 域          | 回环监听接真（回调直达 `AuthClient`，不再丢弃）；新增 `pollOAuthCallback` / `submitOAuthCallback`；`registerProtocol` 接线；`forceOAuthChannel` 可强制协议通道；408 映射为 `TIMEOUT`                                                                                                                                                                          |
| 外壳协议（新增模块）      | `apps/desktop-electron/src/main/protocol.ts`：`setAsDefaultProtocolClient` + 单实例锁 + `second-instance`/`open-url` 转发 + **注册前的回调排队**（冷启动时 URL 先于运行时就绪）                                                                                                                                                                               |
| 渲染层                    | 新增 `ForgotPasswordForm.tsx`（两步式：请求验证码 → 验证码+新密码，含 60s 冷却倒计时）、`EmailVerificationPanel.tsx`（**主动查服务端**状态，不信任会话快照）、`LoginPage` 增「找回密码」页签与「忘记密码？」入口                                                                                                                                              |
| 文档                      | `services/account/README.md` 补邮件与验证相关环境变量表；`services/account/openapi.yaml` 补 `GET /verify-email`；`docs/E2E-CHECKLIST.md` M-01/M-02 改为可实现的手工步骤                                                                                                                                                                                       |

#### 2.12.2 每条验收标准的落地证据

> 以下保留 9 月 23 日记录。9 月 30 日复核发现：格式失败用例不足，图片用例只检查落库文本，
> 没有实际搜索入口；OCR 当时只做可用性探测，不能证明识别成功。修复后的证据以 §2.12.5 为准。

| 验收项                                     | 落地证据                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Markdown / Word / PDF / 图片各成功与失败   | `apps/desktop-electron/src/main/__tests__/domain-docs.test.ts`：`supportedFormats` 断言 docx/pdf/image 全可用；未知格式报 `NOT_SUPPORTED`；垃圾字节图片走 `ocr_unsupported`；正常图片走注入的假 OCR 端口                                                                                         |
| 图片导入 → 搜到 OCR 文本 → 转记忆          | 同上「图片 OCR（注入假端口走完整导入→检索→转记忆链）」用例：导入成功、OCR 文本入库可检索、且能转记忆                                                                                                                                                                                             |
| 真实 OCR 引擎可用性                        | `ocrStatus` 用例**跑真实探测**：本机未装 OCR 语言包 ⇒ 如实返回 `available:false` + 中文安装指引（不是 mock 出来的结果）                                                                                                                                                                          |
| 邮箱注册收到可验证链接；验证后状态正确     | `services/account/src/__tests__/email-flow.test.ts`（8 项）：注册 → outbox 取链接 → confirm → `emailVerified` 翻转；`contract.test.ts`（7 项）在 AuthClient 真实实现上重跑同一条链路                                                                                                             |
| 重置令牌单次有效、过期拒绝                 | `email-flow.test.ts`：二次 confirm 拒绝、过期令牌拒绝、60s 冷却窗口 429 限流、重置码重复使用拒绝、旧 refresh 全部失效                                                                                                                                                                            |
| OAuth 回环与自定义协议**各有**模拟回调测试 | `domain-auth.test.ts`「OAuth 双通道」三条：① 回环——域内起**真实 `http.createServer`**，测试真发一次 HTTP 进回调地址，`pollOAuthCallback` 自动完成登录；② 协议——`forceOAuthChannel='protocol'` + 真实 `createProtocolBridge` 投递，同样自动完成；③ **state 不匹配的回调被丢弃**且不发出换令牌请求 |
| 协议通道的外壳接线可验证                   | `apps/desktop-electron/src/main/__tests__/protocol.test.ts`（19 项）：argv 精确匹配（反例：路径含 `everyonecoding` 不算命中）、注册前排队与补投、重复注册后来者生效、`second-instance`/`open-url` 转发、打包态/开发态注册参数、注册失败只降级告警不阻塞启动                                      |
| 缺真实凭据时的手工验收步骤                 | `docs/E2E-CHECKLIST.md` M-01（邮箱验证，含 5 条判定）、M-02（OAuth 双通道，含 5 条判定）                                                                                                                                                                                                         |

#### 2.12.3 本轮修掉的真实缺陷

| #    | 缺陷                                                                                                                                                                                                                                    | 为什么危险                                                                                                                                                                  | 修法                                                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | **网关流块判别值写错**：`AiGateway.chat()` 的 `StreamChunk` 只有 `delta` / `tool_call` / `usage` / `error` / `done` 五种，而 code / designer / git / pipeline / rename / docs **六个域**各手写了一遍 `chunk.type === 'chunk'`（恒为假） | 条件不成立的错**不会报错**：文本恒为空串，最终以「模型返回为空，请检查模型配置」暴露。排查会被整体带偏到模型 / Key / 网络，而真因是拼错一个字面量。六个 AI 功能实际全不可用 | 新增 `main/domain/ai-stream-text.ts` 作为**唯一**判定点（`textOfStreamChunk` / `errorOfStreamChunk`），六处全部改为调用它；测试夹具同步从 `'chunk'` 改为 `'delta'`，杜绝"夹具与实现错得一样" |
| D-02 | 验证链接默认指向渲染层 dev server（`http://localhost:5173`）                                                                                                                                                                            | 渲染层用 HashRouter，裸路径 `/verify-email` **路由不到**；且用户点链接时桌面端常常没运行 ⇒ 验证根本不可能完成                                                               | 验证落地页改由服务自托管（`GET /verify-email`），并把 `ACCOUNT_PUBLIC_BASE_URL` 提为一等配置；链接不再依赖任何客户端                                                                         |
| D-03 | OAuth `state` 由客户端自造                                                                                                                                                                                                              | 服务端要拿 state 关联它暂存的 PKCE challenge；客户端自造 ⇒ 服务端无从校验，PKCE 形同摆设                                                                                    | `beginOAuth` 改为 GET authorize 并采用服务端签发的 state；`completeOAuth` 回传 `{code, codeVerifier, redirectUri, state}`                                                                    |
| D-04 | 图片解析的引擎异常泄漏为 `UNKNOWN`                                                                                                                                                                                                      | 用户看到"未知错误"，拿不到"缺 OCR 语言包"这个可操作结论                                                                                                                     | `makeImageParser` 包裹 → `ocr_unsupported`（`NOT_SUPPORTED`）                                                                                                                                |
| D-05 | 邮箱验证落地页若做服务端字符串插值，会把 query 参数注入 HTML                                                                                                                                                                            | 反射型 XSS（令牌就在 query 里，注入点与敏感数据同址）                                                                                                                       | 页面**完全静态**：token 只由页面脚本从 `location.search` 读取，零服务端插值                                                                                                                  |
| D-06 | `oauth_callback_timeout`（HTTP 408）在 `mapAuthError` 里落到 `UNKNOWN`                                                                                                                                                                  | "等待授权回调超时"是个明确的用户可操作错误（重试），报 `UNKNOWN` 会让人以为程序坏了                                                                                         | 状态码映射表补 `408 → TIMEOUT`                                                                                                                                                               |
| D-07 | **渲染层 `AuthApi.bind` 的入参声明成 `AuthProvider`（含 `email`），而 `AuthClient.bind` 只接受 `OAuthProvider`**；且 `@ec/renderer` 的 `tsc` 此前就是红的 —— 也就是说"17 工程 typecheck 全绿"这条门禁声明与实际不符                     | 邮箱登录方式是注册时建立的，不存在"再绑一个邮箱"的路径。声明写宽 + 实现侧用断言绕过，等于类型系统对这条边界完全失效；更糟的是门禁红了却没人发现，问题会一直沉在水下         | `bind` 入参收窄为 `OAuthProvider`（`BindingPanel.handleBind` 同步收窄）；CI 因此暴露后被修，本次已用 `pnpm -r typecheck` 实测 17 工程零 error                                                |
| D-08 | **渲染层第三方登录没有收口**：`startOAuth` 只调 `beginOAuth` 就返回，`pollOAuthCallback` 无人调用，`AuthApi.completeOAuth` 也无人调用；微信扫码确认后 `onConfirmed` 被写成空函数                                                        | 用户点了"GitHub 登录"，浏览器里授权成功，应用侧**永远不知道自己已登录**——表现是"点了没反应"。这类"半截链路"比直接报错更难排查（用户只会说"登不上去"）                       | `startOAuth` 改为「发起 → 轮询 `pollOAuthCallback` → 得会话」；新增等待提示与「取消等待」；微信扫码把轮询带回的回调 URL 交给 `completeOAuth` 完成登录；新增 3 条闭环测试                     |

#### 2.12.4 门禁实测（2026-09-23）

| 门禁           | 命令                                                                    | 结果                                                                                      |
| -------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 服务端测试     | `services/account`: `vitest run`                                        | ✅ 3 文件 25 项（`account` 10 + `contract` 7 + `email-flow` 8）                           |
| 主进程域测试   | `vitest run`（docs / auth / protocol / content-ports / pipeline，串行） | ✅ 5 文件 75 项                                                                           |
| 渲染层账号测试 | `vitest run apps/renderer/src/features/auth`                            | ✅ 1 文件 21 项（含 3 条第三方登录闭环）                                                  |
| 全仓单测       | `vitest run --no-file-parallelism`                                      | ⚠️ 249 文件 2586 项：**2575 passed / 4 failed / 7 skipped**，4 项失败全为环境问题（见下） |
| TypeScript     | `pnpm -r typecheck`                                                     | ✅ 17 工程零 error（此前 `@ec/renderer` 是红的，见 2.12.3 D-07）                          |
| ESLint         | `pnpm lint`                                                             | ✅ 零 error 零 warning                                                                    |
| Prettier       | `pnpm format:check`                                                     | ✅ 全部符合格式（首轮 CI 挂在这条，原因与修法见下）                                       |

> **本机环境提示**：`services/account` 与全仓 `vitest` 在本机**必须关掉文件级并行**
> （`--no-file-parallelism`）才能跑完——沙盒的文件系统代理会在写 vitest 的临时 SSR 模块时
> 报 `EPERM`，症状是"一次只收集到一个测试文件"，极易被误读成"测试文件没被 include"。
> 另须让 `node` 指向 nvm v24.20.0（ABI 137），否则满屏 `NODE_MODULE_VERSION ... requires 127`。
> 还有 `spawnSync` 自举 node 恒报 `EBUSY`（影响 `external-change-watcher` 3 项与
> `sidecar-process` 的构建前置，后者先手工跑一次 `scripts/build-sidecar.mjs` 即可绕过），
> 以及 `domain-workspace-git` 的「克隆失败补偿清理」在 git 子进程句柄不回收时挂住（1 项）。
>
> **CI 首轮失败与修法（2026-09-23）**：推送后 CI 在 `Typecheck` 与 `Lint` 两个 job 失败。
>
> - `Typecheck`：即 D-07（`@ec/renderer` 的类型错，本地"全绿"是误判——那次 `pnpm -r typecheck`
>   在 `apps/desktop-electron` 先失败就中断了，renderer 的结果行根本没打出来）。
> - `Lint`：**Prettier**。`pnpm lint` 只跑 ESLint，不含 Prettier；而本轮修改的三个 Markdown
>   （`docs/ACCEPTANCE-REPORT.md`、`docs/E2E-CHECKLIST.md`、`services/account/README.md`）
>   未过 `format:check`。**push 前必须 `lint` 与 `format:check` 两条都跑**（本仓库的老坑，又踩了一次）。

---

#### 2.12.5 复核补缺与验收边界（2026-09-30）

文档同步日期为 2026-10-01；以下测试数字来自 9 月 30 日执行记录，未在本次文档更新中重跑全量测试。
主体实现沿用 §2.12.1，本轮补齐实际检索、OCR 真机识别和失败场景。

| 验收项                                 | 修复与证据                                                                                                                                                                      | 验收边界                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Markdown / Word / PDF / 图片成功与失败 | core `doc-service.test.ts` 与 Electron `domain-docs.test.ts` 补格式矩阵；后者读取真实临时文件。空白、无文字及解析异常拒绝落库                                                   | Word 为 `.docx`；PDF 夹具验证文字层提取与页码，不代表任意复杂 PDF 均可解析；扫描件提示改用图片 OCR      |
| Windows OCR 实际识别                   | 修正不存在的 `CreateLanguage` 调用；对齐 `zh-CN` 与 `zh-Hans-CN`；修正按行间空白分段、CJK 字间空格。`windows-ocr.integration.test.ts` 现场渲染文字 PNG → 真实引擎 → 导入 → 搜索 | 本机已装 `zh-Hans-CN` 时通过；引擎/语言缺失会跳过并报告原因，跳过不能记为识别成功                       |
| 图片可搜且能转记忆                     | `searchDocuments` 贯穿 core、域 RPC 与 renderer；命中带 `anchor`/`snippet`，点击定位并预选转记忆段落。导入传递 `fileName`/`ocrLanguage`；无标题 OCR 段落可选                    | OCR 真机测试验证到检索；摘要预览/提交与来源关联由注入 AI 端口/模拟网关测试验证，真实模型质量见 M-08     |
| AI 摘要与来源                          | `MemoryExtractionPort` 经配置的网关发起 `memory-extract`；预览保留文档与段落来源，提交保存用户编辑后的草稿并建立关联；空输出/流错误如实失败                                     | 提交不会再次请求 AI；避免覆盖用户编辑。真实模型、Key 与网络仍需 M-08 手工验证                           |
| 账号请求/响应                          | `contract.test.ts` 使用真实 `AuthClient` 与 Fastify `app.inject`；注册/登录/OAuth 回调为 `{ identity, tokens }`，refresh 直接返回 `TokenPair`，bindings 按 `bindingId` 解绑     | 身份、令牌和绑定字段见 `services/account/openapi.yaml`；测试中的 OAuth 外呼由假服务承载                 |
| 邮箱验证与密码重置                     | `email-flow.test.ts` 9 项：邮件链接落地页可达且不回显 token，confirm 返回 `{ ok: true }` 并更新状态；过期/重用拒绝、60s 发信冷却、重置后旧 refresh 撤销                         | 随机验证令牌通过哈希查询、有效期与使用状态校验；开发 outbox 不等于真实邮箱送达，M-01 验证投递           |
| OAuth 双通道                           | 回环真实 HTTP、协议桥回调、端口占用 `EADDRINUSE` 后回退、回环可用时不注册辅通道均有域测试；客户端重放不换令牌，服务端 PKCE 失败也消费 state                                     | 默认先回环，失败才回退；`EC_OAUTH_CHANNEL=protocol` 为显式运维覆盖。真实提供方授权与 OS 协议拉起见 M-02 |

**行为变化**：编辑为纯空白正文会报 `empty_content` 且不升版本；解析器异常封装为 `parse_failed`，
Electron 映射为 `INVALID_ARGUMENT`。OCR 引擎错误保留 `ocr_unsupported` → `NOT_SUPPORTED`。
正文搜索目前逐文档、逐段匹配，排除回收站，未做索引与大库搜索性能验收。

**9 月 30 日门禁结果**：根测试 249 文件 / **2619 passed**；服务端 3 文件 / **26 passed**；
E2E-01/02/22 共 3 文件 / **9 passed**；`pnpm -r typecheck` 17 工程通过；`pnpm lint` 与
`pnpm format:check` 通过。命令与范围详见 [测试报告 §5.3](TEST-REPORT.md#53-wave-9-文档与账号复核2026-09-30)。

**2026-10-01 复跑（同任务重新下达后的门禁复验，范围为 Wave 9 相关子集）**：服务端 3 文件 / **26 passed**
（account 10、contract 7、email-flow 9）；`@ec/account` auth-client **30 passed**；core docs 4 文件 / **38 passed**
（其中 `windows-ocr.integration.test.ts` 真机渲染文字图 → 真实 WinRT 识别 → 入库 → 检索，当日实际执行通过）；
Electron domain-auth 17 / domain-docs 24 / protocol 19；renderer docs 25 / auth 21；
E2E-01/02 共 2 文件 / **7 passed**（E2E-22 本轮未重跑）；`pnpm -r typecheck` 17 工程通过；`pnpm lint` 全仓零 warning。
本轮**未重跑**根级全量单测与完整 e2e 套件；`pnpm format:check` 在工作树上不通过，但 44 个问题文件全部属于
同工作区其他任务的未提交改动（T12 流水线 / 更新器等），Wave 9 范围文件（core docs、account、services/account、
Electron docs/auth/protocol、renderer docs/auth）均通过格式检查。数字明细见 [测试报告 §5.3](TEST-REPORT.md#53-wave-9-文档与账号复核2026-09-30)。

**仍待手工验收**：[E2E 清单](E2E-CHECKLIST.md) M-01（真实邮件与找回密码）、M-02（真实 OAuth
双通道）、M-08（图片导入界面与真实模型摘要）。当前允许未验证邮箱登录，不能把测试通过解释为
“必须验证后才能登录”或“真实邮件已在两分钟内送达”。

---

### 2.13 T12-05 归档、用量、备份与遥测生产接线——复核与回归修复（2026-10-01）

T12-05 已于 §2.10（2026-09-22）收口，但任务卡仍保留建单时的过时"现状证据"（称渲染层没有
生产端口、附件子系统未装配）；且收口之后，工作区后续未提交改动破坏了一条已提交的导出契约。
本轮对四条链路（归档 / 用量 / 备份 / 遥测）逐条对照当前工作区重新实测、修掉回归、补齐格式，
并据此更新任务卡状态。全部数字为本日实测，环境：本机 bash，node v24.21.0（ABI 137，better-sqlite3 原生模块匹配）。

#### 2.13.1 本轮改动清单

| 文件                                            | 改动                                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/package-kit/src/export/export-job.ts` | **移除两处"有失败即中止"的抛错**（写入前 + finalize 前 `writer.abort()` + throw），恢复条目级失败记入 `failures` 且整体完成的既定契约；附件内容寻址哈希校验失败仍硬中止并给出可执行引导 |
| `packages/package-kit` 链路 5 文件              | `export-job/export-types/manifest/conflict-resolver/import-job` 补 Prettier 格式化（本链路 format 转绿；其余不合文件属其他在途任务，未代改）                                            |
| `docs/tasks/12-未完成任务清单-可直接交给AI.md`  | T12-05 卡补进度块，纠正过时现状证据                                                                                                                                                     |
| `docs/ACCEPTANCE-REPORT.md`                     | 本节                                                                                                                                                                                    |

#### 2.13.2 每条验收标准的复核证据（对照当前工作区，2026-10-01 实测）

| 验收标准（任务卡原文）                                  | 证据                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PackageApi / UsageApi / BackupSettings 真实注入且可用   | `domain-archive-telemetry.test.ts` **19/19** 全部经真实域运行时（`createProductionDomains`）调用；渲染层 `production-ports.ts` 以 `call.call('package'/'usage', …)` 真实 IPC 装配（含 `getBackupSettings` / `saveBackupSettings` / `createBackupNow`），`production-ports.test.ts` 覆盖参数剥离等通道契约         |
| 导出/导入、冲突预览、五种导入模式、自愈报告、增量包可用 | package-kit **17 文件 / 120 项**全绿：`import-mode-selector`（6 项：完整恢复/合并/仅记忆/仅文档/仅代码）、`import-conflict-resolver`、`import-verifier`（8 项）、`healing`、`incremental-volume`（全量 27722 字节 / 增量 1114 字节 = 4.0%）、`package-roundtrip`（含附件）                                        |
| 附件内容寻址、不静默丢弃                                | 导出 `counts.attachments` 如实计数且包内含 `attachments/` 条目；`listAttachments` 按 `<sha256>.<ext>` 内容寻址枚举；导入 `putFile` 无归属时落暂存目录；**哈希不符硬中止**并提示"请恢复原文件，或按实际 SHA-256 重命名附件并更新引用后重试"                                                                        |
| 用量从真实 `usage_record` 读取、两级一致                | 插入真实行后 `listRows` 逐字段一致（`totalTokens=150` / `cost=0.25`）；域层对行**原样透传**不做二次加工；`UsageDashboard` 两级视图分组数据与 CSV 导出由 `usage-components.test.tsx` 断言                                                                                                                          |
| 预算超限在真正调用模型前阻断                            | `budgetDecision` 与网关共用判定口径；持久化预算经 `readPersistedBudget` 注入 `createAiStack`；`BudgetGuard.check()` 在 `AiGateway.chat` 发请求**之前**调用，已花费 > 预算 ⇒ `ok=false`；`usage.setBudget` 经 `onBudgetChanged` 即时回灌运行中的 Guard                                                             |
| 遥测默认关闭、白名单、绝不写内容                        | `createTelemetryRuntime({ enabled: false })` 下 `record()` 后缓冲为 0 且缓冲文件不存在（零 IO）；`assertEventPayloadSafe` 对 `prompt` / `code` / `apiKey` 夹带全部抛错，合法维度（`providerId`/`purpose`）放行；`telemetry-events` / `telemetry-client` / `telemetry-coverage` 38 项全绿                          |
| 隐私面板清除内存、文件缓冲和数据库记录                  | `clearAll()` 覆盖三层，之后 `buffered()===0` 且 `pending()===0`；渲染层 `PrivacyPanel` 的 `setTelemetry` / `inspectLocalTelemetry` / `clearLocalTelemetry` 均走真实域通道（`settings-panels.test.tsx` 等 73 项全绿）                                                                                              |
| 篡改 / 错误口令 / 高版本包不留半导入状态                | 导入事务 `package-transaction.ts`：SQLite SAVEPOINT + 磁盘撤销副本，任一步失败整体回滚；篡改（按 ZIP 局部头定位翻转字节）⇒ `verifyPackage.ok=false`；错误口令 ⇒ `failureCode='password'`（认证标签先校验后落盘）；高版本 ⇒ `failureCode='version'` + "需升级"提示（`format.test.ts` / `import-verifier.test.ts`） |
| 定时备份按日/周生成、保留份数清理、一键恢复             | 调度器实测排出下一次执行（"2026/10/2 03:00:00（494.6 分钟后）"）；keepCount=2 时生成 3 份仅留 2 份；`restoreFromSnapshot` 返回 `safetySnapshot`（回滚前自动 `pre-restore` 安全快照）；配置含 `HH:mm` 与保留份数校验（坏值拒绝）                                                                                   |
| 全量 / 项目 / 选中范围均有测试                          | `export-scopes.test.ts` 4 项：`scope=all` 全部项目、`scope=project` 仅单项目（其余不出现）、`scope=selected` 仅勾选集合                                                                                                                                                                                           |
| 干净数据目录往返（E2E-13/14）                           | `e2e/domain/e2e-13-14-archive.test.ts` **4/4**                                                                                                                                                                                                                                                                    |

#### 2.13.3 本轮修掉的真实缺陷（1 处）

**`runExport` 的 fail-fast 回归（破坏 FR-PKG-12 既有契约）**：§2.10 收口之后，工作区未提交改动给
`export-job.ts` 加了两处"任一条目失败即中止"——写入前若有枚举期失败直接 throw，finalize 前若有
失败 `writer.abort()` + throw。这与已提交的 `export-progress.test.ts` 契约（文件头注释明言
"条目级失败被记入 failures 且整体不中断（其余文件仍写出）"）及 PRD FR-PKG-12"实时进度、对象计数、
**错误清单与重试**"直接矛盾：任何一个文件读取失败都会放弃整个导出（1 万文件工程里坏 1 个文件 = 全部作废），
且与"失败续跑"用例永久冲突。已恢复逐条记录、其余照常写出、归档正常 finalize 的语义；
附件内容寻址哈希不符仍保持硬中止（那是"内容对不上引用"的完整性问题，宁可失败也不静默错包）。

#### 2.13.4 门禁实测（2026-10-01）

| 命令 / 范围                                                          | 结果                                                                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`（`--max-warnings 0`）                                    | ✅ 零 error 零 warning                                                                                                                  |
| `pnpm -r typecheck`                                                  | ✅ 17 个 workspace 零错误                                                                                                               |
| `packages/package-kit`                                               | ✅ 17 文件 / **120 项**（含修复后的 `export-progress` 2 项）                                                                            |
| `packages/core` telemetry 3 文件 + `packages/ai` budget/usage 2 文件 | ✅ 5 文件 / **38 项**                                                                                                                   |
| `packages/shell-api`                                                 | ✅ **50 项**                                                                                                                            |
| `apps/desktop-electron` 主进程全套                                   | ✅ 334/336（2 失败均在 T12-05 范围外，见下注）                                                                                          |
| `apps/renderer` package/usage/runtime + settings                     | ✅ 16 文件 / **161 项**                                                                                                                 |
| `e2e/domain/e2e-13-14-archive.test.ts`                               | ✅ **4 项**                                                                                                                             |
| `pnpm format:check`                                                  | ⚠️ 归档链路 5 文件已格式化转绿；工作区其余约 33 个不合文件全部属于同工作区其他任务的未提交改动（与 §2.12.5 末的记录同一批），本轮不代改 |

> **范围外已知红（非 T12-05 造成，已归因，待对应任务卡收口）**：
> ① `domain-run-ports.test.ts > 静态预览可访问…` —— 工作区未提交的预览域改动引入（用 targeted stash
> 实测 HEAD 版本 16/16 全绿；症状为文件内新增静态资源用例与其后用例相互干扰，整文件跑必挂、`-t` 过滤单跑可过）；
> ② `electron-updater-host.test.ts > 下载中途连接被掐断…` —— 未跟踪的新 updater 工作中看门狗用例的
> 断言文案不匹配（期望 `UPDATE_NETWORK: 下载停滞`，实得 `UPDATE_NETWORK: aborted`；`classifyUpdateError`
> 归类为 network 本身正确）。两者分别属于预览端口与自动更新（T12-02/T12-04）任务卡。

> T12-05 状态结论：四条链路在当前工作区**全部成立**，任务卡已补进度块（指向本节）。

---

### 2.14 T12-04 Git、预览、导航和统一重命名生产端口（2026-10-01）

T12-01 已总装四域路由，本轮按任务卡的五条实现要求与三条验收逐条收口：对照当前工作区重新实测、
修掉一处已知范围外红与两处 Git 契约漂移、给预览测试换成无连接池客户端、新增 Python 真实托管用例，
并跑完整 E2E 与相关集成测试。全部数字为本日实测，环境：本机 bash，node v24.21.0（ABI 137）。

#### 2.14.1 生产装配与五条实现要求对照

| 要求（任务卡原文）                            | 实现位置与口径                                                                                                                                                                                                                                                                                                                 | 证据（均为真实 SQLite / 真实目录 / 真实子进程）                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主进程装配四 API；路径必须经工程根安全校验    | `domain-factories.ts#createProductionDomains`：git（aiStack + code 写端口）、preview（受控进程端口）、nav（含预览请求日志只读投影）、rename；路径一律经 `createProjectPaths`，越界抛 `PATH_ESCAPE`；进程托管经 `createControlledProcessHost({ allowedRoot: projectsDir })`                                                     | `domain-run-ports.test.ts`：四域越界 projectId 一律拒绝、进程 cwd 越界拒绝、工程内目录链接（junction）拒绝读出；Git 域凭据/自动提交策略走真实 setting 表                                                                      |
| 重命名事务化（registry/occurrence/anchor）    | `packages/registry` 的 occurrence AST 索引 + `executeRename` 五执行器按 `EXECUTION_ORDER`（code-ast → doc-replace → memory-update → logic-recalc → anchor-sync），备份事务区 + 原子写，任一步失败整体回滚；代码栏只按 AST 位置改写，无全局文本替换                                                                             | 同文件 24 项："执行事务：代码/文档/记忆/DSL/锚点/注册表一并同步，且不误伤注释与局部变量（E2E-16）"、"一键撤销后全部还原（E2E-17）"；E2E-15/16/17 独立用例全过                                                                 |
| 预览后端受控进程托管                          | `BackendRunner`：端口先预分配再注入 `PORT`/`HOST`/`PYTHONUNBUFFERED` 环境变量（两边必然一致）、`waitForBackend` 15s 就绪探测（进程秒退即快速失败）、start/stop/restart；`LogStream` 结构化日志 + `preview:log` 常驻事件；端口冲突顺延并在 notice 说明；依赖安装走 installer 端口                                               | 同文件：Node demo 905ms、Python demo 836ms，表单请求 `source=backend`、回显端口与预分配一致、日志可查；端口顺延用例断言 4173 占用 → 4174 + notice；未装配进程端口时七个后托管方法如实报 `NOT_SUPPORTED`（静态/Mock 不受影响） |
| Git 凭据与破坏性操作                          | `GitCredentialStore` 只走 DPAPI 且按项目 `scoped()` 前缀隔离；令牌经 `buildAuthEnv` 注入环境变量（不入 argv、不落日志，结果 `logs` 出口统一脱敏）；DPAPI 不可用时凭据方法如实报 `NOT_SUPPORTED`；删除分支 / 强制推送 / 回滚前自动建 `backup/` 快照分支（`createSafetySnapshot`）；冲突解决结果必须经 code 域写端口落盘（D-04） | `domain-run-ports.test.ts`：DPAPI 不可用不降级明文；`e2e-24` 断言回滚计划含快照分支、argv 全程无 password/--askpass/Authorization（E2E-07 同口径断言）                                                                        |
| 页面/元素 Ctrl+点击、反向跳转、关系图同上下文 | nav 域 `sourceOf(projectId)` 每次按当前项目装配锚点（`code_anchor` 表）、页面（DSL 目录）、代码、文档与预览请求日志；渲染层 `production-ports.ts` 的 `commitJump` / `reverseJump` 在返回时校验活动项目未变才执行定位导航                                                                                                       | 同文件："Ctrl 跳转命中锚点、反向跳回设计器、统计与关系图有真实数据"；E2E-06 断言登录按钮首个目标为 AuthController.login                                                                                                       |

#### 2.14.2 三条验收的证据

| 验收（任务卡原文）                                                           | 证据                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 临时真实仓库全流程（init→修改→diff→提交→分支→冲突→解决→回滚→stash），无终端  | `e2e/domain/e2e-24-git-production-flow.test.ts`：全部经生产域路由 + 真实 git 子进程完成；冲突制造后合并进入冲突态，解决结果经写入管线落盘且冲突标记消失；回滚含快照分支；单次 7.9s（本日实测，git 速度环境敏感见 E2E 清单 §4） |
| Node/Python demo：静态/联动可访问、表单到真实后端、API 面板可重放可复制 cURL | `domain-run-ports.test.ts`：静态预览可访问、未匹配接口走 Mock、请求日志/`toCurl`/`replayRequest` 全链路；Node demo 与 Python demo（标准库 `http.server`，经受控进程端口启动）表单请求都打到真实后端并回显正确 body             |
| E2E-06/07/08/15/16/17                                                        | 全部通过；且 `pnpm test:e2e` 完整套件 **14 文件 / 55 项**全绿（2026-10-01 实测）                                                                                                                                               |

#### 2.14.3 本轮修掉的真实缺陷（4 处）与新增

1. **渲染层 lint 3 处 `import()` 类型注解**（`git-api.tsx` 1 处、`production-ports.ts` 2 处）：
   违反 `@typescript-eslint/consistent-type-imports`，改为顶层 `import type`。
2. **预览测试的 undici 连接池陈旧 socket**（§2.13.4 注① 的根因，本轮修复）：预览服务"同端口 stop → start"
   后立即用全局 `fetch` 请求，undici 连接池会把上一个（已被 `closeAllConnections` 销毁的）keep-alive socket
   拿来发请求，稳定复现 `read ECONNRESET`；本机 10 行脚本复现，插 20ms 间隔即可规避——典型池化竞态而非代码逻辑错误。
   生产转发路径本就是裸 `node:http`（`forwardToBackend`）不受影响；测试改为 `agent: false` 的无池 HTTP 客户端，
   整文件连跑 3 次全绿。**上一版本轮 `-t` 单跑可过、整文件必挂的现象即此因**。
3. **`buildAuthEnv` BatchMode 回归**：工作区未提交改动把 `-o BatchMode=yes` 改成无条件注入——
   带口令的 ed25519 私钥 + BatchMode = ssh 立即失败（BatchMode 禁止一切交互提示，口令只能经 ssh-agent 提供），
   与既有契约测试（带口令时不得含 BatchMode、notes 提示 ssh-agent）直接矛盾。已恢复条件注入，
   保留本轮加入的单引号转义改进（含空格/单引号的密钥路径不再坏参）。
4. **`isBackupBranch` 过度放宽**：被改成 `startsWith('backup/')`，用户自己的 `backup/latest` 分支会被误当
   快照列进回滚清单。收紧为 `/^backup\/\d/`：同时兼容旧 `backup/YYYYMMDD-HHMMSS` 与 git 域安全快照的
   `backup/<ISO 时间戳>-<序号>[-标签]`（两者时间段均以数字开头），并拒绝任意 `backup/*` 命名。

新增：**Python demo 真实托管用例**（FR-PRV-04 两类运行时）——探测按证据文件数取最优（先撤 Node 的
package.json），`python app.py` 经受控进程端口启动，表单请求 `source=backend` 且端口一致；本机无解释器时
以启动日志为据 `ctx.skip` 并给出证据，不把环境缺失伪装成产品缺陷。

#### 2.14.4 门禁实测（2026-10-01）

| 命令 / 范围                                                | 结果                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`（`--max-warnings 0`）                          | ✅ 零 error 零 warning                                                                                                |
| `pnpm -r typecheck`                                        | ✅ 17 个 workspace 零错误                                                                                             |
| `apps/desktop-electron` 主进程全套                         | ✅ **336/337**（唯一失败为未跟踪的 updater 看门狗用例断言文案不匹配，属 T12-09 在途工作，见 §2.13.4 注②，本轮未代改） |
| `packages/git` / `preview` / `registry` + renderer runtime | ✅ **296/296**（含修复后的 2 项 git 契约测试）                                                                        |
| `pnpm test:e2e`（完整套件）                                | ✅ **14 文件 / 55 项全绿**（含 E2E-06/07/08/15/16/17 与 E2E-24）                                                      |
| `pnpm format:check`                                        | 本任务涉及文件全部转绿；工作区其余不合文件均属同工作区其他在途任务的未提交改动（与 §2.13.4 同一批），本轮不代改       |

> T12-04 状态结论：五条实现要求与三条验收在当前工作区**全部成立**；§2.13.4 注①（domain-run-ports 静态预览红）
> 已由本轮修复闭环，注②（updater）仍待其任务卡收口。任务卡已补进度块（指向本节）。

---

## 3. 未完成 / 未达标项（如实列出）

| 项                                             | 现状                                      | 阻塞原因                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 下一步                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tauri `cargo clippy` 零 warning                | **已完成**（2026-09-22，2026-09-30 复验） | ~~本机无 Rust 工具链~~ **已解除**：Rust 1.98.1 就位，`cargo check` / `clippy -D warnings` / `cargo test`（24/24）全绿，见 §2.11.6。2026-09-30 在**无 MSVC**的机器上以非官方 `x86_64-pc-windows-gnu` 路径复验：`cargo check` / `clippy --all-targets -- -D warnings` / `cargo build` 均为退出码 0（`cargo test` 的**执行**在该路径下受阻，见 §2.11.8）                                                                                                                                                                                                             | 已闭环（Rust 单测执行仍需 MSVC 工具链）                                                                                                                                     |
| 双形态 NSIS 安装包产出与体积实测               | 未产出                                    | **Electron 二进制已就位**（2026-09-15），其安装包可随时产出；Tauri 侧缺 MSVC C++ 生成工具（Tauri 唯一官方支持的 linker，见 L-09）                                                                                                                                                                                                                                                                                                                                                                                                                                 | Electron：`pnpm build:electron` + `pnpm release:manifest`；Tauri：取得管理员权限装齐工具链后 `pnpm build:tauri`                                                             |
| 侧车随包分发（Tauri 发行形态）                 | 未做                                      | 开发期侧车用 PATH 上的 `node`；发行包需把 `dist/sidecar/**` 与 ABI 同代的 `node.exe` 一起打进 `bundle.resources`。代码侧已就位（`resolve_node` 优先采用侧车目录下的 `node.exe`），缺的是打包配置与一次实测                                                                                                                                                                                                                                                                                                                                                        | 在 `tauri.conf.json` 补 `bundle.resources`，随包 Node ≥24（ABI 137），然后实测一次启动                                                                                      |
| Tauri 实机 GUI 冒烟（窗口 / 首屏渲染）         | **已执行**（2026-09-30）                  | ~~本机为无人值守会话，无真实桌面交互~~ **已解除**：在真实桌面会话（session 1）中启动 `everyone-coding.exe`，窗口标题 `EveryoneCoding`、`Responding=True`、`msedgewebview2.exe` 渲染进程就位，**侧车随应用启动并真实建库**（34 表 / 6 迁移 / 1 行本地用户），**关闭窗口 5 秒内干净退出、无孤儿进程**（并以这次真机走查发现并修掉一个 P0 死锁，见 §2.11.8）。仅剩"人工点一遍"（建项目 → 开设计器 → 预览）                                                                                                                                                           | 人工走查一次（无需再解决环境）                                                                                                                                              |
| NFR-P-01 冷启动 ≤5s、NFR-P-05 双形态内存       | 未实测                                    | 同上（需真实安装包）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 安装后按 `docs/PERF-REPORT.md §3` 的方法测                                                                                                                                  |
| 真机多端编译（Flutter / hvigor / cargo tauri） | 未执行                                    | 本机无三套工具链                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 装齐后按 `docs/E2E-CHECKLIST.md M-04` 走查；缺工具链时客户端已给出引导与待验清单                                                                                            |
| 全程不打开终端的人工录像走查（FR-SET-08）      | 未完成                                    | 本机为无人值守环境，无法录像                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 交付前人工走查一次：新建项目 → S1 → S2 → 设计器 → 提交 → 预览                                                                                                               |
| 四端口真实装配后的页面走查（Wave 9 遗留）      | 已完成（方法层面）                        | 2026-09-17/18：**四个域全部装配且方法全通——settings 16/16、workspace 19/19、docs 20/20、auth 14/14（合计 69/69）**，设置页 / 工作台 / 文档中心 / 账号页均可真实使用（含 `.ecpkg` 归档往返、按模板新建、从 Git 导入、离线模式）。2026-09-18 补：`importFromGit` 的克隆/扫描/落库**三阶段进度经域事件通道实时回传**（此前因回调无法跨进程而全程无反馈）。剩余为**外部条件**而非代码缺口：邮箱验证 / OAuth 授权需服务端邮件能力与真实第三方凭据，端到端走查见 M-07                                                                                                   | 见 `docs/E2E-CHECKLIST.md M-07`（含逐域状态）                                                                                                                               |
| 邮箱链接验证（E2E-01 的「验证」环节）          | **已实现**（2026-09-23）                  | ~~服务端不含邮件投递与验签~~ 已补齐：令牌单次有效 + 过期拒绝 + 60s 冷却限流，落地页由服务自托管（见 §2.12）                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 真机发信走 `docs/E2E-CHECKLIST.md M-01`                                                                                                                                     |
| 真机 OAuth（GitHub / Google / 微信）           | 未执行                                    | 需真实 OAuth 应用凭据与浏览器交互                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 见 `docs/E2E-CHECKLIST.md M-02`                                                                                                                                             |
| 服务端容器化验证                               | 未执行                                    | 本机无 Docker 运行环境                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `services/account` 的 `Dockerfile` / `docker-compose.yml` 已就绪                                                                                                            |
| `pnpm test:e2e` 的 E2E-01 / E2E-02 断言过时    | **已修复**（2026-09-30）                  | 本任务之前为 3 项红：Wave 9 收口把 account 契约对齐为 `{ identity, tokens }`（`services/account/src/__tests__/contract.test.ts` 的头部注释与断言即为此口径），而 `e2e/services/e2e-01-account.test.ts`、`e2e/services/e2e-02-oauth.test.ts` 仍在读旧的扁平字段 → `expected undefined to be truthy`（`body.userId` / `body.accessToken`）与 `expected 400 to be 200`。**服务端行为本身正确**（实测 register 201 且 body 为 `{identity, tokens, workspaceId, planId}`，`/api/auth/refresh` 回扁平令牌对）                                                           | 已按契约改断言；`pnpm test:e2e` 恢复 **42/42 全绿**                                                                                                                         |
| `tsc -p e2e/tsconfig.json`（独立工程类型检查） | **已修复**（2026-09-30，零 error）        | 本任务之前为 4 项 error：`e2e/domain/e2e-24-git-production-flow.test.ts` 引用了 `@ec/shell-api` 已不再导出的 `DomainRouter` / `DomainRouterContext`（路由签名的事实源早已迁到主进程域运行时 `apps/desktop-electron/src/main/domain/runtime.ts`），并直引 e2e 工程解析不到的 `better-sqlite3` 类型；另有一处 `conflicted?.blocks[0]?.index` 因 `blocks: unknown[]` 而报 TS2339。该文件由 `985b02b`（E2E-22/24）引入，晚于 §2.7.5 那次"零 error"记录；**CI 不跑这一步**（`.github/workflows/ci.yml` 的 typecheck 只执行 `pnpm typecheck`，e2e 不在 workspace 包内） | 已修：路由类型改从主进程 runtime 引；DB 类型改用 `ReturnType<typeof openBusinessDb>`；`conflicts` 改用 `@ec/git` 的 `ConflictFile`。E2E-24 实跑仍绿（真实 git 全流程 5.1s） |

> 上述各项**均已在对应文档中给出可复制的命令与判定标准**，不是"待补充"。验收口径上，
> 这些属于"环境缺失导致未能执行"，与"功能未实现/未达标"是两件事，本报告不做混同。

---

## 4. 验收操作手册（复制即用）

```bash
# 0) 环境（本机 bash shim 不注入 PATH，必须显式设置）
export PATH="/c/Users/f2595/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:/c/Users/f2595/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Windows/System32:/c/Windows:/usr/bin:/bin:$PATH"
cd /d/code/program/everyoneCoding
NODE24="/c/Users/f2595/AppData/Local/Author Software/nvm/installs/v24.20.0/node.exe"

# 1) 全仓单测（不含 e2e）
"$NODE24" node_modules/vitest/vitest.mjs run

# 2) 21 条 E2E 验收用例
"$NODE24" node_modules/vitest/vitest.mjs run -c e2e/vitest.config.ts

# 3) 静态检查
"$NODE24" node_modules/eslint/bin/eslint.js . --ext .ts,.tsx --max-warnings 0
"$NODE24" node_modules/typescript/bin/tsc -p e2e/tsconfig.json
corepack pnpm -r typecheck

# 4) 覆盖率门禁（六核心模块 ≥70%）
corepack pnpm quality-gate

# 5) 性能基准（7 项，结果写 perf/last-run.md）
corepack pnpm perf

# 6) 版本一致性与发布清单
corepack pnpm version:check
corepack pnpm release:manifest -- --dir release-artifacts --base-url https://update.example.internal --channel stable --notes "v0.1.0"
```

---

## 5. 遗留问题与责任人

| #    | 遗留问题                                                                                                                                                                                                                                                                                                                         | 影响                                                                                 | 责任人                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| L-01 | 装机环境缺 **MSVC C++ 生成工具** / Flutter / DevEco / Docker，导致双形态安装包、真机编译、容器化验证无法执行。~~缺 Rust~~ **已于 2026-09-22 部分闭环**：Rust 1.98.1 就位，`cargo check` / `clippy -D warnings` / `cargo test` 均可本机执行（见 §2.11.6）                                                                         | 阻塞 NFR-P-01/05/09 的最终确认与 M-04/M-06                                           | 环境负责人（以管理员身份装 MSVC 生成工具的 C++ 工作负载）                                  |
| L-02 | ~~Electron 二进制被 pnpm 阻止下载~~ **已于 2026-09-15 闭环**：改用 `ELECTRON_MIRROR` 直取 npmmirror（12s 完成），并固化为 `prepare:native` / `dev.mjs` 自动流程                                                                                                                                                                  | 已解除                                                                               | 已闭环                                                                                     |
| L-09 | ~~Tauri Rust 侧前置条件受权限阻塞~~ **注记更新（2026-09-22）**：`cargo check / clippy / test` 已可跑（Rust 1.98.1 就位，"本机无 Rust 工具链"的表述已过时）。仍缺的是 **MSVC C++ 生成工具**——Tauri 官方只支持 MSVC linker，需要管理员权限安装                                                                                     | 仅阻塞 `pnpm build:tauri`（安装包产出）与真机编译                                    | 需主人以管理员身份执行（见 `docs/DEV-SETUP.md §2.3`；脚本 `scripts/setup-rust-tauri.ps1`） |
| L-03 | ~~本机 git 子进程极慢（≈18s/次）~~ **已于 2026-09-15 解除**：进程恢复 1.3s/次，git 集成 3/3（152s）、模块覆盖率 75.71% 达标（见 `docs/TEST-REPORT.md §1.2`）。超时环境变量 `EC_GIT_IT_TIMEOUT_MS` 保留（防环境再劣化）                                                                                                           | 历史影响已消除                                                                       | 已闭环                                                                                     |
| L-04 | 人工录像走查（FR-SET-08）与四端口页面走查未做                                                                                                                                                                                                                                                                                    | 验收签字前必须完成                                                                   | 产品/验收人                                                                                |
| L-05 | ~~邮箱链接验证未实现~~ **已于 2026-09-23 闭环**：服务端补 `account_email_token` / `account_email_outbox` 迁移、邮件投递端口（outbox/webhook）、`/api/auth/email/{verify,verify/confirm,status}` 与**自托管的验证落地页** `GET /verify-email`；客户端补 `confirmEmailVerification` / `emailVerified` 与账号页验证面板。详见 §2.12 | 已解除（真机发信仍需真实 SMTP/webhook）                                              | 已闭环（手工走查见 `docs/E2E-CHECKLIST.md M-01`）                                          |
| L-06 | Tauri `pubkey` 与更新端点仍是占位值                                                                                                                                                                                                                                                                                              | 对外发版前必须替换，否则更新验签全失败                                               | 发版负责人（见 `docs/RELEASE.md §3.2`）                                                    |
| L-07 | `packages/ui/.quarantine/`、`apps/renderer/.quarantine/` 等开发期隔离目录仍在仓库内                                                                                                                                                                                                                                              | 仓库整洁度                                                                           | 主人手动清理（safe-delete 拦截了脚本删除）                                                 |
| L-08 | 仓库尚未 `git init`                                                                                                                                                                                                                                                                                                              | 无法用版本历史回溯                                                                   | 主人决定何时初始化                                                                         |
| L-10 | Tauri 形态不暴露**同步签名的域端口**（`MemoryApi` / `PipelineApi`）：Tauri 渲染层没有同步 IPC 原语，用异步往返伪装同步会读到上一拍的数据（属伪造），故如实不注入，两个页面保留装配引导                                                                                                                                           | 记忆中心 / 流水线页在 Tauri 下走异步口；两域功能本身不受影响（`domain.invoke` 全通） | 若必须等价，需为 Tauri 增加同步 IPC 方案并承担阻塞渲染进程的风险（当前判定为不划算）       |
| L-11 | 侧车在 Tauri 发行形态下需要**随包分发的 Node 运行时**；当前只走 PATH，故发行包尚未自包含                                                                                                                                                                                                                                         | 阻塞 Tauri 发行形态（安装后即用）                                                    | 见 `docs/CAPABILITY-MATRIX.md §4`：补 `bundle.resources` + ABI 同代的 `node.exe`           |
