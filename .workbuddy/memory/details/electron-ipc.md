# Electron 域通道（IPC / 事件 / 同步端口 / 项目上下文）详细记录

> 索引见 `../MEMORY.md §Electron 域通道`。本文件是被移出 MEMORY.md 的细节。

- **扩域四处同步**（少一处不通）：`shell-api` 的 `DOMAIN_KINDS`/`DOMAIN_RPC_METHODS` →
  主进程 `domains/<域>-domain.ts` → `domain-factories.ts` 的 `routers` →
  渲染层 `runtime/production-ports.ts` 适配器 + `__EC_*__` 槽位。
- **跨进程只有请求/响应**：函数传不过去（克隆抛 `An object could not be cloned`）。进度走
  `ec:domain:event`，信封 `DomainEvent` 复用请求 requestId；域实现只调 `ctx.emit(payload)`。
  新增域事件三件套：shell-api 定载荷 + `is*Event()` 守卫、通道进 `EVENT_CHANNELS`、preload 进
  `PRELOAD_METHOD_KEYS`。未登记进 `DOMAIN_EVENT_PAYLOAD_GUARDS` 的事件会被渲染层静默丢弃。
  `ratio: null`＝不确定进度，不准假装 100%。
- **同步签名端口走独立通道**（`MemoryApi`/`PipelineApi`）。链路五处：`DOMAIN_SYNC_METHODS`
  （独立白名单，默认拒绝）→ `createDomainRuntime.invokeSync` → IPC `ec:domain:invokeSync`
  （`ipcMain.on`）→ preload `domain.invokeSync` → `createDomainSyncCaller`。
- **`registerAllIpc` 的 `wrapped` 必须转发 `ipc.on`/`removeAllListeners`**：否则同步通道从未注册，
  渲染层 `sendSync` 无对端应答会**永久阻塞整个渲染进程**。只在真机现形。
- **`createProductionDomains` 的 `emit` 必须接真实 sink**：给 `() => {}` 会让 `fs.watch` 类事件
  静默进黑洞。无请求归属的事件用固定哨兵 requestId（preload 丢弃缺 id 的事件）。
- **项目上下文**：`runtime/project-context.ts` 单点持有活跃项目；适配器经 `withProject()` 注入
  `projectId`，未打开项目时抛 `INVALID_ARGUMENT` 且**请求根本不发出**；切项目用 `key={project.id}` 整棵卸载。
- **AI 侧新增** `AiStackHandle`（`ai-control.ts` 定义、域工厂消费）：唯一用途是 usage 域的预算
  回灌（`budget.configure`）。主进程经 `aiRuntime.handle` 传给域工厂——**别传 null**，
  否则预算护栏接不上网关。
- **渲染层性能测试用「毫秒 + DOM 行数」两个量**，禁止用 jsdom 报帧率（jsdom 无真实合成器，数字是假的）。
- `dev.mjs` 两层 GPU 兜底，**不要提前清 `ELECTRON_RUN_AS_NODE`**（它是"是否嵌入宿主"判据）。
  产物 `.cjs`；better-sqlite3 需 Node/Electron 两套 ABI 共存。
