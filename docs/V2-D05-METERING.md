# V2-D05 验收记录

日期：2026-10-02

## 实现

- 在 OpenAI 与 Anthropic 流适配器中保留协议 usage 的输入/输出、缓存读、缓存写 TTL 桶与推理子集；`message_delta` 的 `stop_reason: null` 不会提前结束 Anthropic 流。
- AiGateway 为每个实际上游调用建立独立 attempt，共享逻辑请求身份；接线复用 `@ec/core` 的 usage 规范化、token 估算与 `computeUsageCost`，保存实际路由和不可变价格快照。未知用量/价格保留为未知，不折算成零。
- AttemptStore 以 SQLite 持久化 attempt、usage 事件和 cursor，并维护既有 usage record 投影；最终用量更正替换原估算，重复事件和重复更正幂等。事件序号按用户分配，迁移增加 `(user_id, sequence)` 唯一约束。
- 新增 UsageRepo 对新 attempt 与既有 usage 记录的聚合查询；连接测试和后台调用接入 attempt 记录及现有 execution-owner 控制。
- 新增暂态上下文预览，从 Usage API / shell RPC 到网关估算下一次有效输入及费用区间；输入有大小限制，不落库、不写 usage attempt，也不把历史消费累计当作当前上下文。

## 验证

- D00 前置核验：core V2 contracts（28 项）、model-route（5）、ai-control-route（6）、remote-config（18）、provider/model/route migration（3）、DiffPreview（3）、local mode（5）均通过，路由键转换和同名换渠道差异已覆盖。
- 定向回归共 19 个测试文件、193 项通过，其中 `metering-flow.test.ts` 的 5 个流/持久化场景覆盖：缓存桶及推理子集、最终更正与重复更正、429 实际重试分别记录、取消/断流缺 usage、SQLite 关闭重开后的 attempt/cursor 恢复与按用户序号隔离。其余回归覆盖协议映射、网关、迁移、UsageRepo、运行时与 shell/renderer 接口，以及暂态上下文预览。
- 测试仅使用受控 SSE 夹具、固定虚构价格和本地临时 SQLite，不调用真实上游或发生实际扣费；虚构金额断言用于确认复用 core 纯函数，不构成新定价公式。
- TypeScript 检查通过：`packages/core`、`packages/ai`、`packages/data`、`packages/shell-api`、`apps/renderer`。D07 修复测试中的 Git CommitInput 字段后，Electron 全量 strict 检查已在 2026-10-02 复核通过；D05 自身无类型错误。
- `git diff --check` 通过。`pnpm` 启动被本机 NVM delegated-script identity 检查拒绝，本轮通过仓库 `node_modules` 中的 Vitest/TypeScript 入口运行检查。

## 状态

D05 的代码接线及定向回归已完成，待项目验收；真实 UI 手工验收和真实渠道请求留给整体验收流程。任务清单仅更新 D05 状态与本卡执行记录，保留其余并行任务的改动。
