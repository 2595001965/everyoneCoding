# EveryoneCoding 项目长期约定

> 只留「文档里没有、容易踩坑」的硬约束。细节见 `docs/DEV-SETUP.md`、`docs/ACCEPTANCE-REPORT.md`、`docs/tasks/`。

## 定位与现状
Windows 桌面端 AI 全栈开发工作台（Tauri 2 / Electron 双形态），链路：需求→界面→技术文档→代码。
基线 `docs/PRD-EveryoneCoding.md` v1.3；`docs/tasks/00~12` 已落地；2026-09-15 门禁全绿（2188 项）。
未闭环＝「环境缺失/权限不足」项，见验收报告 §3/§5：docx/pdf 覆盖、图片 OCR、Tauri 形态域端口(69 方法)与 AI 栈仍 `NOT_SUPPORTED`（`bridge.ts` 报 capabilities=false，需落 Rust 或 sidecar）、`pnpm dev:electron` 人工 GUI 走查需真实桌面会话。

## 工程硬规则
- **双入口包**：`@ec/core` 等有 `exports.browser`（排除 `node:zlib`、better-sqlite3 等 Node 侧模块）；`apps/renderer/vite.config.ts` 的 alias 必须指 `browser.ts`。新增包同步维护。
- **依赖方向**：`core` 不得依赖 `@ec/pipeline`；特性间禁止直接 import，走 `features/workspace/workspace-events.ts`。
- **渲染层**只 import `@ec/shell-api`，禁止 `@tauri-apps/*` 与 `electron`。测试性能用「毫秒 + DOM 行数」，禁止 jsdom 报帧率。
- **设计器**：不得依赖 `@ec/memory`（better-sqlite3 污染浏览器构建），外部能力经 `store/ports.ts` 注入；DSL 加字段必须同步 `dsl/schema.ts`(zod)，否则静默剥离。
- TS strict；pnpm workspace；包名 `@ec/*`；跨包只走单一入口；迁移 `-- migration/-- up/-- down`。
- `.gitignore`：`release/`、安装包扩展名、`.tmp-*`（**只匹配目录**）。`.gitattributes` 钉 `*.bat eol=crlf`、`*.gbk -text`。许可 **Apache-2.0 且仓库公开**，`LICENSE`+`NOTICE` 随产物分发。
- 新增导航必须同步 `layout/navigation.ts` + `packages/core/src/command-catalog.ts` + `i18n/*` + `AppIcon`，否则 `command-catalog.test.ts` 红。

## Electron 域通道
- **扩域四处同步**（少一处不通）：`shell-api` 的 `DOMAIN_KINDS`/`DOMAIN_RPC_METHODS` → 主进程 `domains/<域>-domain.ts` → `domain-factories.ts` 的 `routers` → 渲染层 `runtime/production-ports.ts` 适配器 + `__EC_*__` 槽位。
- **跨进程只有请求/响应**：函数传不过去（Electron 克隆抛 `An object could not be cloned`）。进度走 `ec:domain:event`，信封 `DomainEvent` 复用请求 requestId；域实现只调 `ctx.emit(payload)`。新增域事件三件套：shell-api 定载荷 + `is*Event()` 守卫、通道进 `EVENT_CHANNELS`、preload 进 `PRELOAD_METHOD_KEYS`。未登记进 `DOMAIN_EVENT_PAYLOAD_GUARDS` 的事件会被渲染层静默丢弃。`ratio: null`＝不确定进度，不准假装 100%。
- **同步签名端口走独立通道**（`MemoryApi`/`PipelineApi`，消费方写入后立刻同步读回）。链路五处：`DOMAIN_SYNC_METHODS`（独立白名单，默认拒绝）→ `createDomainRuntime.invokeSync` → IPC `ec:domain:invokeSync`（`ipcMain.on`）→ preload `domain.invokeSync` → `createDomainSyncCaller`。外壳没有 `invokeSync` 就不注入这两个端口。
- **`registerAllIpc` 的 `wrapped` 必须转发 `ipc.on`/`removeAllListeners`**：否则用 `on` 注册的同步通道从未注册，渲染层 `sendSync` 无对端应答会**永久阻塞整个渲染进程**。只在真机现形。
- **`createProductionDomains` 的 `emit` 必须接真实 sink**：给 `() => {}` 会让 `fs.watch` 类事件静默进黑洞。无请求归属的事件用固定哨兵 requestId（preload 会丢弃缺 id 的事件）。
- **项目上下文**：`runtime/project-context.ts` 单点持有活跃项目；适配器经 `withProject()` 注入 `projectId`，未打开项目时抛 `INVALID_ARGUMENT` 且**请求根本不发出**；切项目用 `key={project.id}` 整棵卸载。
- `dev.mjs` 两层 GPU 兜底，**不要提前清 `ELECTRON_RUN_AS_NODE`**（它是"是否嵌入宿主"判据）。产物 `.cjs`；better-sqlite3 需 Node/Electron 两套 ABI 共存。

## 领域口径（踩过的，别再犯）
- **`ArtifactStore` 产物是平坦布局 + 阶段前缀**：`<projectId>/pipeline/s1-<前缀>-v<n>.md`，无阶段子目录。
- **pipeline 合法序列**：`startStage → submitForReview → confirm`（`confirm` 不接受 `running`）；`advance(from,to)` 要求 `from` 已 confirmed 且相邻。
- **`designer.createPage` 必须用 `@ec/designer/dsl` 的 `createEmptyPage`**，不要手写对象字面量：漏 `projectId`/`viewport`/`apiDeps`/`notes`/`anchors` 或把 `state` 写成 `states` 时文件落盘成功、`listPages` 也列得出，但渲染层 zod 校验必失败 ⇒ 新建项目打开设计器直接报错。合法性唯一判据是 `deserializePageDsl(JSON.stringify(envelope))`。**`condensePage(dsl)` 收 PageDsl 本体**（读 `dsl.tree`），不是 `{dslVersion,page}` 信封。
- **`element`/`feature` 行必须登记**：`code_anchor.element_id`、`memory_item.feature_id` 是指向 `feature` 表的外键，缺行只在特定数据形状下报 `FOREIGN KEY constraint failed`。
- **`memory_item` 必填列**：`user_id`/`scope`/`title`/`content`/`source_type`/`created_at`/`updated_at` 全 NOT NULL（直接写 SQL 时最易漏 `source_type`）。`id` 不能只用时间戳（同毫秒撞唯一约束，已改为带 projectId）。
- **`note` 表两套枚举禁止互转**：`note_type`（六类）vs `note.kind`（design|note|comment）；正文存 `content`，富文本/清单/代码片段/历史进 `payload_json`。领域规则只在 `@ec/designer/notes`（子入口闭包只允许 zod，有 purity 测试）。
- **外部改动检测不采信 `fs.watch` 的 filename**（Windows 上常报目录名且重复上报）：事件只当触发器 + 250ms 合并 + 「路径→size/mtime」索引比对；自身写入在**写入前**抑制（含 `.ec-tmp` 临时路径）。
- **上下文"空块不伪装"**：每块 `content` 非空 ⟺ `items` 非空；空项目组装时只有 `instruction` 有内容，其余块必须带 `skipped`。`ContextPanel`/`CodeView` 的生产挂载页是 `/code`（`pages/CodePage.tsx`）。
- **代码写入只有一条路**：`WritePipeline` 的 `plan → preview → apply`；`requestRework` 返回 `void`，计划走**已登记**的域事件 `code:write-plan`。
- **快照域名不能直接当文件名**：领域名是自由字符串（`pipeline:<projectId>`），Windows 上 `:` 被解释成 NTFS 备用数据流 —— 写入/读取/exists 全都"成功"，但 `readdir` 永远列不出该条目 ⇒ 脏快照检测静默失效、崩溃恢复在 Windows 上整体失灵（POSIX 上完全复现不出）。`CrashRecovery.snapshotPath` 已把非 `[A-Za-z0-9._-]` 替换为 `_`；逻辑域名仍存信封 `domain` 字段，`detectPending` 按信封字段匹配。

## `.bat` 铁律（`scripts/`）
必须 **GBK(cp936) + CRLF + 无 BOM**。转码：`node 规范 CRLF` + `iconv -f UTF-8 -t GBK`。
**禁止** Read/Write 往返 GBK 文件；**禁止** PowerShell `ReadAllText(UTF8)+WriteAllText(936)`（满篇 `?`）。
验收：GBK 汉字数与源件一致、`0x3F` 字节为 0。延时用 `ping`；不用 `tasklist /V`；`taskkill /FI WINDOWTITLE` 无匹配也返 0，不能当成功判据。
`start-desktop.bat` 故意不清 `ELECTRON_RUN_AS_NODE`；dev 默认不弹 DevTools（`EC_ELECTRON_DEVTOOLS=1` 开启）。

## 命令与启动
`pnpm lint` / `-r typecheck` / `test` / `test:e2e` / `quality-gate` / `perf`；CI 在 `ci/*.yml`（未接远端）。
启动：`dev:renderer`(5173) / `dev:electron` / `dev:tauri`。出包前必换 `tauri.conf.json` 的 `updater.pubkey`。
**`dev:electron` 不代起渲染层**：它只编译并拉起 Electron 主进程，必须先另开终端跑 `pnpm dev:renderer`，否则主进程报
`-102 ERR_CONNECTION_REFUSED`。渲染层 `strictPort: true`（`apps/renderer/vite.config.ts`），端口被占会直接失败而非漂移。
（沙盒里跑 `vite` dev **卡在 "Re-optimizing dependencies"** 不 bind 端口，别在沙盒里验证这条链路。）

## 本机命令环境（每次会话都要用，别重新踩）
- **跑测试/门禁必须让 `node` = nvm v24.20.0**：better-sqlite3 的 Node 侧 `.node` 按 ABI 137 构建，托管 v22.22.2 是 ABI 127，用它跑测试满屏 `NODE_MODULE_VERSION ... requires 127`。首选
  `/c/Users/f2595/AppData/Local/Author Software/nvm/installs/v24.20.0/node.exe`（`.nodejs` 是会被切走的软链，只作临时手段）。
- **经 pnpm 转发的命令（`pnpm test:e2e` / `pnpm -r test` / `pnpm lint`）必须把 nvm v24 的目录放进 `PATH` 前缀**，
  只把 node.exe 的绝对路径喂给 `pnpm.cjs` 没用 —— 脚本由 pnpm 重新 spawn，子进程里裸 `node` 会解析到托管的
  v22.22.2，于是 `pnpm test:e2e` 满屏 ABI 127/137，**看起来像代码坏了**。写法：
  `export PATH="/c/Users/f2595/AppData/Local/Author Software/nvm/installs/v24.20.0:$PATH"`。
- **bash 里 corepack 版 `pnpm` shim 调不通**（basedir 是 POSIX 路径，被 node 解析成 `D:\c\Users\...`）。用真入口：
  `node "C:/Users/f2595/AppData/Local/node/corepack/v1/pnpm/9.15.9/bin/pnpm.cjs" <args>`。
- node 的脚本/参数路径**不要写 `/d/...`**（会变 `D:\d\...`），一律 `D:/code/...`。
- bash 缺 Git Bash 的 `/usr/bin`（`dirname`/`head`/`ls` not found）。需要时前置
  `/c/Users/f2595/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin`。
- **根脚本 `pnpm build:renderer` 在沙盒里会卡住不返回**（11 分钟无输出）；直接 `cd apps/renderer && node node_modules/vite/bin/vite.js build`（约 4s）。
- **包内单测要在仓库根跑**：根 `vitest.config.ts` 的 include 是 `{packages,apps}/*/src/**/*.test.{ts,tsx}`，从包目录跑会 "No test files found"（`packages/core` 例外，它有自己可用的配置）。
- **同一 message 里对同一文件发多个 `Edit` 会互相覆盖**（实测 4 个只有最后一个生效，其余"成功"但被回滚）。改同一文件必须一次一个 Edit。
- 全量并发跑单测时 `@ec/ai` 上下文性能基准会假红（判据见 `docs/TEST-REPORT.md §5.1`），不改预算。
  **根级全量单测最稳的跑法是串行**：`pnpm -r --workspace-concurrency=1 test` —— 并发下 renderer 的
  `pipeline-workspace`(6.7s)/`rename-dialog`(11.8s) 等时间敏感用例也会因 CPU 争用超时（一边跑全量一边跑 `tsc`
  就会踩到）。**另外 `pnpm -r test` 在第一个失败的包就停**（`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`），
  后面的包根本不跑，只看尾部输出会误判成"全绿"。

## 环境坑
- **D 盘过滤驱动拦 `refs/remotes`**（2026-09-17 定案）：写远端跟踪引用返 0 但文件不存在，还删掉 `refs/remotes/origin` 目录 → 长期 `[gone]`。仅 D 盘、仅 `refs/remotes`，不影响 push 本身。需给 `D:\code` 加排除（未做）。
- git 推送待登记 `~/.ssh/id_ed25519` 公钥到 GitHub。
- Tauri 坑：SAC 拦未签名 build script（等几分钟重跑）；`sp.crates.io` 不通→改 `index.crates.io`；NSIS 在 `%LOCALAPPDATA%\tauri\NSIS`。截 Tauri 窗口用 `PrintWindow(hwnd,dc,2)`。
- **git 用例超时是环境还是代码**：同时量 `git --version` 与 `where.exe git`。健康基线进程创建 ~0.5s 地板价、`git --version` ≈759ms；退化时可达 26.5s ⇒ `git-integration.test.ts` 与 `domain-workspace-git.test.ts` 必然假红。**不要改这些测试的超时预算**；临时放行用 `--testTimeout=<大值>` 或 `EC_GIT_IT_TIMEOUT_MS`。`@ec/git` 侧已核对无冗余子进程，成本就是"真实 git 进程 × 上百次调用"，没有可优化的实现空间。
