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

结果：4 个测试文件、18 项通过。`coordinator-process.test.ts` 使用 `child_process.spawn` 启动独立 Node worker；worker 连接同一个真实 SQLite 文件，迁移后各自构造 `AgentStore`、`AgentCoordinator`、`AgentGatewayControl`、`BudgetGuard` 和 `RequestQueue`。受控本地上游把调用写入独立进程共享的日志文件，不调用真实收费服务。

- 两个协调器进程竞争，数据库只登记一个 owner；另一进程提交相同幂等键得到原 task。强杀 owner 后，新 fencing token 为 2，任务进入 unknown/reconciliation，调用日志仍只有一次。
- 第一个任务的共享日预算预占成功；第二个进程环境下提交的任务因共享预占被拒绝，上游没有第二次调用。
- provider QPS=1 时，两次调用开始至少间隔 850ms。
- 从独立进程提交取消/暂停命令，只影响目标 task；其他 session 继续运行。显式恢复从持久化 checkpoint 派发一次，测试确认日志总计两次（原始调用和明确恢复调用），没有恢复风暴或隐式重试。
- Electron code-domain 接线测试确认同一幂等键只调用一次模型，并且 `taskSnapshot` 重连返回持久事件和 cursor，使用最新 cursor 订阅不会重放旧事件。
- D07 写入和崩溃恢复回归另有 12 项通过，其中包含过期旧 owner 无法写入的 fencing 检查。

静态检查：D06 改动文件 ESLint、Prettier、`packages/ai` TypeScript 检查和 `git diff --check` 通过。D07 修复测试中的 Git CommitInput 字段后，Electron 全量 strict TypeScript 检查已在 2026-10-02 复核通过；D05 前置计量验收仍未完成，因此 D06 继续保持“已实现待验收”。

## 前置 D05 核验

运行 `metering-flow.test.ts`、网关 client、migrator 和 provider/model/route migration 四个测试文件：总计 21 项中 18 项通过，D05 的 `metering-flow.test.ts` 5 项中 3 项失败。失败项分别是缓存价格快照币种/完整性不符、Anthropic 流式 token 期望 12 而实际 15、以及取消/断流预期空 cost 但实际写入 incomplete estimate。因此 D05 仍为待办，尚不能确认其验收；本记录仅确认 D06 自身的受控测试结果，不替 D05 更改状态。
