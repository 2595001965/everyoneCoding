# V2-D06 验收记录

日期：2026-10-02

## 实现

- code-domain 的生成、改写和续写走持久化 `agent_session` / `agent_task`，会话快照返回任务状态、事件和可续订 cursor；幂等键重复提交返回同一任务。
- `AgentCoordinator` 通过 SQLite 租约和递增 fencing token 选出唯一执行 owner。owner 丢失后，接管进程将未完成请求标为未知并写对账事件，不会自动重新发送。
- 网关执行控制共用 AiGateway 的 `BudgetGuard` 和 `RequestQueue`，并将 Agent 的 Provider 请求放进普通网关使用的 Provider 队列；SQLite permit 记录跨进程预算预占、Provider QPS 窗口和未知调用占位。
- 取消、暂停、恢复和对账使用持久化命令；控制按 task 定位，不会取消同一 owner 正在运行的其他 session。恢复只接受可验证的生成检查点，并为每次任务修订使用独立 logicalRequestId。

## 验证

命令：

```text
node node_modules/vitest/vitest.mjs run packages/ai/src/agent/__tests__/coordinator-process.test.ts apps/desktop-electron/src/main/__tests__/code-agent.test.ts apps/desktop-electron/src/main/__tests__/task-write.test.ts apps/desktop-electron/src/main/__tests__/task-write-recovery.test.ts --no-file-parallelism
```

2026-10-03 复核结果：4 个测试文件、20 项通过（含后续加入的 D07 写入回归）。`coordinator-process.test.ts` 使用 `child_process.spawn` 启动独立 Node worker；worker 连接同一个真实 SQLite 文件，迁移后各自构造 `AgentStore`、`AgentCoordinator`、`AgentGatewayControl`、`BudgetGuard` 和 `RequestQueue`。受控本地上游把调用写入独立进程共享的日志文件，不调用真实收费服务。

- 两个协调器进程竞争，数据库只登记一个 owner；另一进程提交相同幂等键得到原 task。强杀 owner 后，新 fencing token 为 2，任务进入 unknown/reconciliation，调用日志仍只有一次。
- 第一个任务的共享日预算预占成功；第二个进程环境下提交的任务因共享预占被拒绝，上游没有第二次调用。
- provider QPS=1 时，两次调用开始至少间隔 850ms。
- 从独立进程提交取消/暂停命令，只影响目标 task；其他 session 继续运行。显式恢复从持久化 checkpoint 派发一次，测试确认日志总计两次（原始调用和明确恢复调用），没有恢复风暴或隐式重试。
- Electron code-domain 接线测试确认同一幂等键只调用一次模型，并且 `taskSnapshot` 重连返回持久事件和 cursor，使用最新 cursor 订阅不会重放旧事件。
- 同一命令覆盖 D07 写入和崩溃恢复回归 14 项，其中包含过期旧 owner 无法写入的 fencing 检查。

静态检查：D06 改动文件 ESLint、Prettier、`packages/ai` TypeScript 检查和 `git diff --check` 通过。2026-10-03 复核时，`packages/core`、`packages/ai`、`packages/data`、`packages/shell-api`、`apps/renderer`、`apps/desktop-electron`、`packages/git` 七个 TypeScript 工程均通过。

## 前置 D05 核验

2026-10-02 记录的 3 个计量失败项已过时。2026-10-03 用 23 个计量及接线回归文件复核，226 项全部通过；包含 `metering-flow.test.ts` 全部 5 项。D05 已通过自动化和 TypeScript 验收，D06 前置满足。

## 状态

D06 验收通过：持久化任务与单 owner 协调、共享预算/队列、隔离控制、崩溃接管和幂等重连均有真实子进程与共享 SQLite 覆盖，相关 TypeScript 工程检查通过。
