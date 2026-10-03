# V2 契约基线（V2-T01 交付）

> 任务：[V2-T01 — 核验基线并建立公共契约](tasks/V2-AI-Tasks.md)。日期：2026-10-01。
> 本文是后续任务的契约引用文档：现状/缺口简表、契约文件清单、迁移顺序与领域边界、后续写集分工。
> 契约代码：`packages/core/src/v2/`（经 `@ec/core` 的 `index.ts` 与 `browser.ts` 双入口导出）。
>
> **2026-10-02 执行说明**：本文保留 T01 交付时的快照与旧 T 编号，不是当前待办清单。后续按 [V1 遗留与 V2 增量任务](tasks/V2-AI-Tasks.md) 的 D00～D16 执行，旧编号映射见该文 §5。T02/T03 已有实现。**D00（2026-10-02）已收口两处路由集成差额**：core 公共路由（ULID+slash 键）与 ai 生产路由（上游名+colon 句柄）的分层口径与单点转换落在 `packages/ai/src/domain/model-route.ts`（`coreRouteOfModelRoute` / `modelRouteOfCoreRoute` / `persistentRouteKeyOf`，两键空间不得互相解析）；`planApply` 默认配置改按完整路由（模型名+声明渠道）比较，同名换渠道经 `providerSwitch` 提示确认。证据：`packages/ai/src/domain/__tests__/model-route.test.ts`、`remote-config.test.ts`、`ai-control-route.test.ts`、renderer `DiffPreview.test.tsx`。既有 schema/纯函数继续复用，不能据本文历史缺口重复建设；数据库迁移编号以实际目录为准（0009 为并行任务在途新增）。

## 1. 生产链路核验简表（2026-10-01 实测工作区）

核验方式：三路只读探查（AI 链路 / 项目-预览-写入链路 / 外壳-数据层链路）+ 直接读源码。
结论分四级：**已实现**（真实生产链路可跑）/ **部分**（有能力但有硬缺口）/ **仅类型** / **未实现**。

| 领域           | 现状                                                                                                                                      | 级别              | 关键证据与缺口                                                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目导入       | blank/template/git_import/doc_import 四类；Git 克隆走系统 git CLI、代码根可外置（code-root pointer）、失败补偿                            | 已实现（V1 范围） | `packages/core/src/project/git-import.ts`、`apps/desktop-electron/src/main/domain/workspace.ts:675`。**无本地文件夹/ZIP 接入**（T04）；`ProjectProfile` 在 core/git-import 与 preview/project-detector 同名异义（T05 消歧） |
| 预览/运行      | 真实子进程托管（PORT 注入/就绪探测/重启）+ 静态服务 + Mock（OpenAPI 围栏），来源优先级 后端>Mock>静态                                     | 已实现（单实例）  | `packages/preview/src/backend/runner.ts`、`preview-domain.ts`。实例按 projectId 键控、状态纯内存、**无 runtimeId**（T06 引入）；请求日志环形 500 条不落盘                                                                   |
| 写入管线       | plan→preview→apply 三段式；apply 前重读盘比对 before，tmp+fsync+rename 原子写；快照逆序回滚；`CodeWritePort` 单写入口                     | 已实现（进程内）  | `packages/ai/src/write/write-pipeline.ts`、`code-domain.ts:454`。**无基线/租约/变更集**，计划不可跨进程重放（T13）                                                                                                          |
| 锚点/导航      | 三重锚定（声明/注释标记/AST）+ syncState 三态 + 正反向跳转                                                                                | 已实现            | `packages/ai/src/anchors/`、`nav-domain.ts`。无 sourceRef 内容指纹/revision，校验态落库即丢，commitSha 恒空（T08 补）                                                                                                       |
| 接口索引       | 页面 DSL `apiDeps: string[]` 生成期记录 + nav 域正则解析 + OpenAPI 围栏 Mock 匹配                                                         | 仅生成期记录      | **无真实 HTTP 路由台账**（T09）。可复用地基：`packages/registry/src/occurrence/ast/`（TS 真编译器 API、作用域感知 Occurrence 索引）                                                                                         |
| Provider/Model | provider/model 表 ULID PK + provider_id FK；model.name 无唯一约束，同名模型已可跨 Provider                                                | 已实现（弱约束）  | `packages/ai/src/repo/provider-repo.ts`、migrations/0003。**全链路只引用 modelId 单键**（purpose 绑定/IPC/usage），provider 反查——T02 复合身份的改造面                                                                      |
| 用量计量       | `Usage{promptTokens,completionTokens,totalTokens}` 三字段；Anthropic 缓存并入 prompt；金额 REAL 美元；每次调用一条 usage_record           | 部分              | `packages/ai/src/core/usage.ts`。**无 attempt/logicalRequest、无缓存 TTL 分桶、无推理 token、无估算/最终标记**（T11）；有单价缺失护栏（complete=false 显「—」，不猜价）                                                     |
| 网关           | 预算（日/月）、per-provider 限流、指数退避重试、容灾降级、GatewayEvent 9 类                                                               | 已实现            | `packages/ai/src/gateway/`。容灾切换记录实际路由（`candidatesFor`），但 attempt 粒度缺失使其无法支撑计费（T11/T19）                                                                                                         |
| 远程配置       | 自建 URL + Ed25519 验签；provider 目录+默认模型名；本地优先 applier                                                                       | 已实现            | `packages/ai/src/remote-config/`。默认模型按**模型名**回写（T02 需改为路由键）                                                                                                                                              |
| 会话/多窗口    | AI 对话态全内存（AbortController/续写前缀 Map）；无会话实体；单实例锁单窗口；流水线 checkpoint 是唯一持久化"会话式"状态                   | 未实现（V2 范围） | `code-domain.ts:137`。T12 持久化 Session/Task、T14 多窗口                                                                                                                                                                   |
| 平台服务端     | Fastify：auth/email/verify、匿名用量上报壳、release check                                                                                 | 部分              | `services/account/src/app.ts`。**无 Provider 目录/价格/账务端点**（T17–T19 拟新增）                                                                                                                                         |
| 外壳契约       | 15 域 RPC 白名单 + 40 AI 方法；`DomainRpcError{code,message,retryable}`；事件 `DomainEvent{requestId,domain,payload}` 无 eventId/seq/去重 | 已实现（V1 形态） | `packages/shell-api/src/domain-control.ts`。**无 traceId、无事件幂等**——新领域用 `v2/errors.ts`、`v2/events.ts`，T12/T23 收口接线                                                                                           |
| 双外壳         | Electron 主进程与 Tauri 侧车共用同一份 `createHeadlessRuntime`；D08 把 Memory/Pipeline 渲染端口改为异步 RPC 并接入 Tauri；当前机器缺 Rust/Cargo，原生构建待验 | D08 实现已接线；原生验收待环境 | `bootstrap.ts`、`sidecar/service.ts`、`desktop-tauri/src/bridge.ts`、`renderer/src/runtime/production-ports.ts` |
| 数据层         | better-sqlite3；26 位 ULID 主键；INTEGER ms 时间戳；迁移框架 up/down 事务化 + djb2 checksum；24 表（0001–0007）                           | 已实现            | `packages/data/src/ids.ts`、`migrator.ts`。renderer 生产源码无 Node 依赖泄漏（实测 grep）                                                                                                                                   |

## 2. 公共契约文件清单（packages/core/src/v2/）

全部只依赖 zod，禁 Node/宿主依赖（测试有源码守卫）。每文件含 TS interface + zod schema + 关键纯函数。

| 文件                | 内容                                                                                                                                                                                                                                                                                                                    | 主要消费任务    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `primitives.ts`     | `Ulid`/`isUlid`（Crockford Base32 校验，不含 I/L/O/U）、`EpochMs`、`ProvenanceKind`（measured/reported/estimated/inferred/unknown）、`SourceRevision{gitCommit,contentHash}`、行级 `revision`                                                                                                                           | 全部            |
| `money.ts`          | 定点微单位金额（1e-6 币种单位）、`addMoney` 跨币种拒绝、十进制字符串↔微单位精确转换（无浮点）                                                                                                                                                                                                                           | T17/T18/T21     |
| `errors.ts`         | `V2ErrorEnvelope{code,message,retryable,traceId,details}` = 现有 16 码 + 新增 `STALE_BASE/CONFLICT/UNAVAILABLE/RATE_LIMITED/BUDGET_EXCEEDED/PRICE_UNKNOWN`；`toV2ErrorEnvelope` 兼容既有 RPC 错误对象                                                                                                                   | 全部新领域      |
| `events.ts`         | `V2EventEnvelope{eventId,sequence,dedupKey,…}`；平台六类事件常量（request.accepted/output.delta/usage.updated/request.completed/request.failed/bill.settled）；`createEventDeduplicator`（eventId+dedupKey LRU 去重）                                                                                                   | T11/T12/T14/T19 |
| `provider-model.ts` | `ProviderModelRoute{providerId,modelId}`、`providerModelKeyOf`（`{pid}/{mid}` 键）、`ProviderModelInfo`（canonicalVendor/canonicalModel 只作官方参考，不当路由键）。**D00：modelId=本地 model 行 ULID；ai 生产路由（上游名+colon 句柄）经 `@ec/ai` `coreRouteOfModelRoute/modelRouteOfCoreRoute` 单点转换，两键不互解** | T02/T03/T17     |
| `usage.ts`          | `ProtocolUsageReport→NormalizedUsage`（缓存拆分/补齐、推理子集、未知=null）、`CacheHitRate`（measured \| not_applicable 三种原因）、`UsageAttempt`（logicalRequest/attempt 两级、待对账状态、终态须 endedAt）                                                                                                           | T11/T19/T21     |
| `api-endpoint.ts`   | `normalizePathTemplate`（`:id`→`{id}`、去查询串）、`ApiRouteIdentity`（serviceId+method+normalizedPath）、`ApiEndpoint`（createdAtSource 三分：tool_event/git_inferred/unknown，unknown 禁带 createdAt）、`ApiRelation`（证据四类+置信度）                                                                              | T09/T10/T15     |
| `element-anchor.ts` | `SourceRef`（POSIX 相对路径）、`ElementAnchor`（runtimeId≠源码节点、sourceRevision、confidence 四级、unresolved 必须给原因、exact 必须有 sourceRef）                                                                                                                                                                    | T07/T08         |
| `runtime.ts`        | `RuntimeInstance`（runtimeId 键控、服务端口映射、健康路径、ready 须有服务与 startedAt）                                                                                                                                                                                                                                 | T06/T12/T13     |
| `project-source.ts` | `v2SourceKind`（existing_folder/copied_folder/git_clone/zip_extract）、`ProjectSource`、`SourceDetection`+`SubProjectDetection`（证据、supportLevel、置信度）、`RunPlan`（**strict 模式只允许 envVarNames，schema 层拒绝环境变量值**）                                                                                  | T04/T05         |
| `agent.ts`          | `AgentSession/AgentTask`（生命周期 10 态、readSet/writeSet、ContextSnapshot、BudgetSpec）、`WriteChangeSet`（改名见 §5）、`WriteLease`+`assertFencingToken`                                                                                                                                                             | T12/T13/T15     |
| `billing.ts`        | `PriceVersion`（不可变版本、平台价/官方价双来源+证据、0 与 null 语义分离、缓存写费率固定 full_rate）、`computeUsageCost`（PRD §9.3 公式全整数实现）、钱包/预占/流水载荷（available=posted−held 不变量进 schema）                                                                                                        | T17/T18/T19/T21 |

测试：`packages/core/src/v2/__tests__/v2-contracts.test.ts`（28 项）——三条红线（同名模型不合并/多服务同路径不合并/未知不压扁为 0）、JSON 往返、PRD §9.3 虚构价格样例精确断言（0.027 元=27000 微单位）、RunPlan 拒绝夹带 env 值、fencing token、源码纯度守卫、browser 入口导出检查。

## 3. 迁移顺序与领域边界

### 3.1 数据库迁移 owner 与顺序

- 客户端库 `packages/data/migrations/`：现有 0001–0007。**T01 未追加任何迁移**（按卡要求不建空壳全集）。后续按依赖顺序追加，编号从 0008 起，每条必须带 down 段（框架支持回滚，`migrator.ts`）：

| 迁移  | 任务    | 内容                                                                                                               |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| 0008+ | T02     | provider/model 复合身份唯一约束（`(provider_id, name)` 等，按其实施方案）、purpose 绑定迁路由键、历史 unknown 标记 |
| 0009+ | T04     | project_source（V2 来源/授权根/修订）                                                                              |
| 0010+ | T06     | runtime_instance（实例与服务端口映射）                                                                             |
| 0011+ | T09     | api_endpoint / api_relation                                                                                        |
| 0012+ | T11     | usage_attempt（logicalRequest/attempt/规范化 usage/价格快照引用）；旧 usage_record 保留为 legacy                   |
| 0013+ | T12/T13 | agent_session / agent_task / write_changeset / write_lease / 事件游标                                              |
| —     | T08     | 锚点：扩展现有 code_anchor（sourceRevision/校验态持久化）或新表，由其实施决定                                      |
| —     | T22     | 归档/备份相关迁移                                                                                                  |

- 服务端 `services/account/migrations/`：独立序列（现有 0001–0003）。钱包/价格版本/账本/网关计量表（T17/T18）在此追加，**不与客户端库共用编号**。
- 规则不变：追加不改已发布迁移；schema.ts 与 DDL 同步；`schema.test.ts` 校验字段完备性。

### 3.2 领域边界（拟新增位置标记）

| 位置                                                   | 状态                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/v2/`                                | **本次新增**——公共契约（浏览器安全，双外壳/renderer 共用）                                                               |
| `services/account/src/…` 或新增 `services/catalog      | billing`                                                                                                                 | **拟新增**（T17/T18/T19 落位；沿用 Fastify 生态与现有认证，不另建身份体系） |
| 服务端网站应用                                         | **拟新增**（T20；不在桌面塞设置页代替）                                                                                  |
| 本地新领域域（preview 运行实例、接口索引、会话协调器） | T06/T09/T12 沿 `domain-control.ts` 白名单模式扩展；新域方法必须进 `DOMAIN_RPC_METHODS`，生产装配走 `domain-factories.ts` |
| shell-api 既有 15 域错误/事件结构                      | T01 不动；`V2ErrorEnvelope`/`V2EventEnvelope` 供新域使用，T23 收口时统一                                                 |

## 4. 后续写集分工（并行分支约定）

三条分支写集互不重叠，共享文件（`packages/core/src/v2/`、shell-api、data migrations、domain-factories）由集成人串行合入：

| 分支        | 任务序列                                | 主要写集                                                                                                                                             | 与他人的共享触点                                                                                    |
| ----------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 并发/身份线 | T02→T03→T11→T12→T13→T14                 | `packages/ai`（repo/purpose/gateway/usage）、`packages/data` 迁移 0008/0012/0013、`code-domain.ts`、shell-api 新增方法白名单                         | v2 契约只读引用；T11 需将 `packages/ai/core/usage.ts` 适配到 v2 口径（迁移适配层放 ai 包，不改 v2） |
| 源码线      | T04→T05→T06→T07→T08（T05 后分 T09→T10） | `packages/core/src/project`、`packages/preview`、`packages/registry`（接口索引复用 occurrence）、workspace.ts、preview-domain、renderer 预览/接口 UI | T05 消歧 `ProjectProfile`（重命名放该任务）；T09 新增 api 索引领域                                  |
| 平台线      | T17→T18→T19→T20（T21 汇合）             | `services/account` 或新服务、服务端迁移序列、renderer 设置/账单视图                                                                                  | 价格/钱包读 `v2/billing.ts`；T19 客户端平台模式经 shell-api 新方法                                  |

T15/T16 汇合源码线与并发线（依赖 T03/T08/T10/T13）；T23 收口前各域不得宣称生产可用。

## 5. 命名决策记录（避免后续撞名）

- **`WriteChangeSet` / `WriteLease`**：`ChangeSet` 已被 `packages/registry/src/rename-event.ts`（重命名域）占用，跨包同名会撞 import；V2 统一写入变更集加 `Write` 前缀。
- **`SourceDetection`**：取代 `ProjectProfile` 歧义（core/git-import 导入画像 vs preview/project-detector 运行画像两套同名类型）。旧名本任务不动，T05 消歧时收敛。
- **`v2SourceKind`**：与现有 `ProjectSourceKind`（V1 四类 blank/template/git_import/doc_import）并列；V1 值继续用于旧项目行，T04 落库时映射。
- **`ProviderModelRoute/Key`**：现有库 `model.id` 单键引用不改名；复合路由键是新契约口径，T02 迁移引用处。**D00 补记（2026-10-02）**：`ProviderModelRoute.modelId` 固定为本地 model 行 ULID（slash 键 `providerId/modelRowId`，usage/价格/账务持久化用）；ai 生产路由的 `modelId` 是上游模型名（colon 句柄 `providerId:模型名`，DB `provider_model_id` 列/远程目录引用用）；转换只走 ai 包两个函数，后续 D05/D10/D12 一律经此衔接，不得各自再拼路由字符串。

## 6. 阻塞业务项（不代替用户决定）

1. **结算币种与支付商户**：PRD §8.3 建议单币种预付、P0 人工审计式额度调整；币种代码（契约用 ISO 4217）与支付渠道需业务确认后才可发布真实目录（T17/T18 用显式测试币种夹具不受阻）。
2. **真实售价与官网价格核验**：契约只定义 `platform_published`/`official_vendor` 双来源结构；任何真实价格须运营发布并留证据（PRD 明文禁止实施 AI 代定售价）。
3. **免费额度规则**：不自动假定金额，待运营规则。
4. **并发规模默认值**（建议 3 Agent）与隐私/日志保留期：容量测试与服务上线前确认。
5. 以上均不阻塞契约与夹具实现——v2 契约对币种/价格参数化为显式配置。

## 7. T01 验证记录

- `pnpm --filter @ec/core typecheck` ✅（全仓 `-r typecheck` 除 desktop-electron 既有失败外全绿，见下）
- `vitest run --no-file-parallelism packages/core`：24 文件 304 项全过（含新增 28 项契约测试）✅
- `eslint packages/core/src/v2 packages/core/src/index.ts packages/core/src/browser.ts` ✅ 0 告警
- `prettier --check`（本次变更文件）✅
- **既有失败（与 T01 无关，未代修）**：`apps/desktop-electron/src/main/__tests__/domain-run-ports.test.ts:724` `ctx.skip(...)` 报 TS2554（Expected 0 arguments, but got 1）——该文件工作区无改动（git status 干净），属 HEAD 既有问题，疑似 vitest 类型签名差异，归属 T12-04 域测试维护方。
- 未验证：真实 renderer 浏览器装载（本任务只保证 browser 条件入口导出与纯度守卫；实际 UI 装载在 T23 联调）、Tauri/Electron 运行时行为（无 UI 变更，不适用）。
