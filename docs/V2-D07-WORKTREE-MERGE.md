# V2-D07 验收记录

日期：2026-10-02

## 前置核验

- 已读取 docs/tasks/00-通用上下文与执行约定.md、本卡和 docs/PRD-EveryoneCoding-V2.md 的 §2.3、§10.2、§10.3、V2-E2E-20。
- 执行时（2026-10-02）D06 状态为“已实现待验收”。2026-10-03 前置复核：D05 的 23 个计量/接线测试文件共 226 项通过；D06 的 4 个定向文件共 20 项通过，含 5 项真实子进程协调器测试；七个 TypeScript 工程检查通过。D05、D06 现均已验收。

## 实现

- TaskWriteService 复用既有 WritePipeline，为每个写任务建立独立 Git worktree 或非 Git 隔离副本；非 Git 项目不自动 init/commit。
- dirty Git 项目要求显式选择 head 或 current 基线；current 只读复制未提交、未跟踪和删除状态，不执行 reset、clean、stash 或远端 push。
- 任务持久化基线哈希、读集、写集、接口契约哈希、排他资源、租约 fencing token、变更日志、快照 journal 和合入结果。
- 合入前重新校验读依赖、契约版本和写集；同文件或接口依赖变化进入 conflicted，展示 base/ours/theirs，不覆盖原目录新修改。
- 真实文件落盘仍由 WritePipeline 完成：CAS + 原子写 + 事务快照；验证失败或进程中断按所有权补偿，若文件已不属于本任务则保留现场。
- 依赖锁、DDL/迁移、generated 目录及显式共享数据库资源按任务排他协调；工作副本清理需要用户确认且不强制删除 dirty worktree。
- 生产 `code` 域把 D06 的 AgentStore owner 注入 TaskWriteService：Agent 任务的 plan 先落在任务副本，带 `taskId` 的 apply 只能走安全合入；非任务的 Git/重命名/代码端口继续复用原 WritePipeline，任务恢复只在当前 fencing owner 下补偿。

## 验证

测试命令：
node ./node_modules/vitest/vitest.mjs run apps/desktop-electron/src/main/**tests**/task-write.test.ts apps/desktop-electron/src/main/**tests**/task-write-recovery.test.ts packages/ai/src/write/**tests**/write-pipeline.test.ts --reporter=dot
node ./node_modules/vitest/vitest.mjs run apps/desktop-electron/src/main/**tests**/domain-content-ports.test.ts --reporter=dot
node ./node_modules/typescript/bin/tsc -p apps/desktop-electron/tsconfig.json --noEmit
node ./node_modules/typescript/bin/tsc -p packages/ai/tsconfig.json --noEmit
node ./node_modules/typescript/bin/tsc -p packages/git/tsconfig.json --noEmit

结果：D07 核心测试 3 个文件、31 项通过；生产域集成测试另有 17 项通过，证明 Agent 计划包含任务副本绑定、确认前原目录不变、合入后任务状态为 merged。Electron、@ec/ai、@ec/git TypeScript 检查通过。Vitest 仅报告 Vite CJS/import.meta 警告，不影响测试结果。

覆盖证据：

- 非 Git 项目：原目录不生成 .git，确认前不写入，环境文件/数据库文件不复制到副本。
- 真实 Git：dirty 仓库显式选择基线，staged、untracked、删除状态及 HEAD 保持不变。
- 冲突：同文件后一任务暂停并保留两侧内容；不同文件的接口契约变化触发重新验证。
- 外部修改：独立 Node 子进程在合入前或验证期间修改文件时，旧计划被拒绝或补偿，外部内容保留。
- 崩溃恢复：真实子进程强杀后由新 owner 按 journal 补偿；后续外部修改不被回滚，重复恢复幂等；过期 owner 不能继续写。
- 资源协调：依赖锁、DDL/迁移和共享数据库资源排他；取消任务只释放自身副本且不清场用户目录。

2026-10-03 复核：在真实共享目录事务准备后，由独立 Node 子进程抢先改写目标文件，合入报告 conflicted 并保留外部内容；被阻止的计划不会进入 queued。`WritePipeline` 的前置检测与 CAS 间隙现在也返回冲突路径，任务快照会持久化冲突两侧。D07 核心测试复跑 31 项，D06 多进程协调与 code-agent 测试 6 项通过；Electron、@ec/ai、@ec/git TypeScript 检查通过。
