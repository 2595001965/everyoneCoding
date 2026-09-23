# EveryoneCoding 项目长期约定（索引版）

> 细节按主题读 `details/`：`sidecar-protocol.md`、`domain-gotchas.md`、`electron-ipc.md`、
> `env-and-shell.md`（**本机环境与环境坑，每会话先读**）；文档见 `docs/` 下 ACCEPTANCE-REPORT、
> CAPABILITY-MATRIX、DEV-SETUP、tasks/。

## 现状（2026-09-23）
Windows 桌面端 AI 全栈开发工作台（Tauri 2 / Electron 双形态：需求→界面→技术文档→代码）。
Tauri 四域 69 方法 + 11 生产能力域已经受控侧车打通，`ai`/`domain` 不再 `NOT_SUPPORTED`。
Wave 9 已收口：文档「一键转记忆」接真实 AI 摘要端口（`memory-extract`）、图片 OCR 走 Windows
内置引擎（`Windows.Media.Ocr`，见 `packages/core/src/docs/parsers/windows-ocr.ts`）、
邮箱验证与找回密码闭环、OAuth 回环 + `everyonecoding://` 双通道。
门禁基线：单测 249 文件/2586 项（本机 2575 passed / 4 env-failed）、cargo test 24/24、
clippy -D warnings、lint、17 包 typecheck、vite build 611 modules。
未闭环（外部条件）：Tauri 安装包缺 MSVC linker、侧车随包分发、实机 GUI 冒烟、真机 OAuth 凭据、Ollama。

### 高频陷阱（2026-09-23 新增，务必先看）
- **网关流块文本判别值是 `delta`，不是 `chunk`**：`AiGateway.chat()` 只发
  `delta`/`tool_call`/`usage`/`error`/`done`。曾六处手写 `type === 'chunk'`（恒假）⇒
  六个域 AI 输出恒为空串，症状是"模型返回为空，请检查模型配置"（排查方向被带偏）。
  统一走 `main/domain/ai-stream-text.ts`，别再手写判定。
- **本机跑 vitest 必须 `--no-file-parallelism`**：否则沙盒 fs 代理写临时 SSR 模块报 EPERM，
  症状是**一次只收集到一个测试文件**（极易误判成 include 写错）。
- **本机 `spawnSync`/`execFileSync` 自举 node 恒报 EBUSY**（与代码无关）：
  影响 `packages/ai/.../external-change-watcher.test.ts`（3 项）与
  `sidecar-process.test.ts`（先手工跑 `apps/desktop-electron/scripts/build-sidecar.mjs` 备好产物即可绕过）。
- `services/account` 的测试不在根 vitest include 里，必须 `cd services/account` 单独跑。

## 双形态与侧车（T13-01，最重要）
- **运行时只有一份**（Node 侧），Tauri 经**受控侧车**承载，**绝不迁进 Rust**（= 重写第二遍必漂移）。
- 域装配单一入口 `main/runtime/bootstrap.ts#createHeadlessRuntime()`，Electron 与侧车共用；**改装配只改这里**。
- 协议 NDJSON，判别字段 `t`；**字段一律 camelCase**；op/capability/event 名两侧逐字一致；
  主版本两处校验（清单 + 握手），不等即拒服务。
- **侧车 stdout 只能是协议帧**（console 改道 stderr）；**`invokeSync` 在 Tauri 不存在**，同步口如实不注入。
- DPAPI 由 Rust 提供，`SafeStorageLike` 原语同步/异步皆可。详见 `details/sidecar-protocol.md`。

## 工程硬规则
- **双入口包**：`exports.browser` 排除 `node:zlib`/better-sqlite3；renderer vite alias 必须指 `browser.ts`。
- **依赖方向**：`core` 不得依赖 `@ec/pipeline`；特性间禁止直接 import（走 `workspace-events.ts`）。
- **渲染层只 import `@ec/shell-api`**，禁 `@tauri-apps/*` 与 `electron`（唯一例外 `desktop-tauri/src/bridge.ts`）。
- **设计器不得依赖 `@ec/memory`**，能力经 `store/ports.ts` 注入；DSL 加字段必须同步 `dsl/schema.ts`(zod)。
- TS strict；pnpm workspace；`@ec/*`；跨包只走单一入口；迁移 `-- migration/-- up/-- down`。
- 许可 Apache-2.0 且公开，`LICENSE`+`NOTICE` 随产物分发；新增导航须同步 `layout/navigation.ts` +
  `command-catalog.ts` + `i18n/*` + `AppIcon`。
- **commit 粒度**：文件被多任务共改按"主进程/域"整体归并（不拆代码 hunk）；按章节追加的文档可用
  `git apply --cached --unidiff-zero` 拆章节。

## Electron 域通道
- **扩域四处同步**：`shell-api` 的 `DOMAIN_KINDS`/`DOMAIN_RPC_METHODS` → `domains/<域>-domain.ts` →
  `domain-factories.ts` 的 `routers` → 渲染层 `production-ports.ts` + `__EC_*__` 槽位。
- 跨进程只有请求/响应；进度走 `ec:domain:event`；新事件三件套＝载荷守卫 + `EVENT_CHANNELS` +
  `PRELOAD_METHOD_KEYS`，漏登记的事件被渲染层静默丢弃。
- **`registerAllIpc` 的 `wrapped` 必须转发 `ipc.on`/`removeAllListeners`**：否则 `sendSync` 永久阻塞渲染进程。
- `emit` 必须接真实 sink；`AiStackHandle` 不能传 null（预算回灌断链）。详见 `details/electron-ipc.md`。

## 领域口径（高危优先，全量见 `details/domain-gotchas.md`）
- **`setting` 表列是 `value_json`/`value_text` + `user_id` NOT NULL（没有 `value`）**：走 `createSettingStore`。
- **`designer.createPage` 必须用 `createEmptyPage`**：漏字段落盘成功但渲染层 zod 必失败 ⇒ 打开设计器即报错。
- **快照域名不能当文件名**（`:` 是 NTFS ADS 故 `readdir` 列不出）⇒ 已转义非 `[A-Za-z0-9._-]` 为 `_`。
- **篡改检出测试要落在 ZIP 压缩数据区**（按 `PK\x03\x04` 解 `dataStart` 翻字节），翻中段＝假阴性。
- **预算两端共用 `setting.usage_budget`** 且经 `onBudgetChanged` 即时回灌网关；遥测清除必须三层。

## 命令与启动
`pnpm lint` / `-r typecheck` / `test` / `test:e2e` / `quality-gate` / `perf` / `format:check`；
**push 前 `lint` 与 `format:check` 都要跑**（曾只跑 eslint 让 CI Lint job 红）。
启动 `dev:renderer`(5173) / `dev:electron` / `dev:tauri`（后两者不代起渲染层）。
**跑测试让 `node` = nvm v24.20.0（ABI 137），pnpm 转发需将其目录置于 `PATH` 前缀**；详见 `details/env-and-shell.md`。
