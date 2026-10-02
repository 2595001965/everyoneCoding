# V2-D07 验收记录

日期：2026-10-02

## 前置核验

- 已读取 docs/tasks/00-通用上下文与执行约定.md、本卡和 docs/PRD-EveryoneCoding-V2.md 的 §2.3、§10.2、§10.3、V2-E2E-20。
- D06 当前状态为“已实现待验收”：持久化 Session/Task、单写协调器、租约/fencing、事件恢复和共享网关队列已落地；D05 前置仍有待验收项，因此不把 D06 标为最终验收完成。

## 实现

- TaskWriteService 复用既有 WritePipeline，为每个写任务建立独立 Git worktree 或非 Git 隔离副本；非 Git 项目不自动 init/commit。
- dirty Git 项目要求显式选择 head 或 current 基线；current 只读复制未提交、未跟踪和删除状态，不执行 reset、clean、stash 或远端 push。
- 任务持久化基线哈希、读集、写集、接口契约哈希、排他资源、租约 fencing token、变更日志、快照 journal 和合入结果。
- 合入前重新校验读依赖、契约版本和写集；同文件或接口依赖变化进入 conflicted，展示 base/ours/theirs，不覆盖原目录新修改。
- 真实文件落盘仍由 WritePipeline 完成：CAS + 原子写 + 事务快照；验证失败或进程中断按所有权补偿，若文件已不属于本任务则保留现场。
- 依赖锁、DDL/迁移、generated 目录及显式共享数据库资源按任务排他协调；工作副本清理需要用户确认且不强制删除 dirty worktree。

## 验证

测试命令：
node ./node_modules/vitest/vitest.mjs run apps/desktop-electron/src/main/__tests__/task-write.test.ts apps/desktop-electron/src/main/__tests__/task-write-recovery.test.ts packages/ai/src/write/__tests__/write-pipeline.test.ts --reporter=dot
node ./node_modules/typescript/bin/tsc -p apps/desktop-electron/tsconfig.json --noEmit
node ./node_modules/typescript/bin/tsc -p packages/ai/tsconfig.json --noEmit
node ./node_modules/typescript/bin/tsc -p packages/git/tsconfig.json --noEmit

结果：3 个测试文件、29 项通过；Electron、@ec/ai、@ec/git TypeScript 检查通过。Vitest 仅报告 Vite CJS/import.meta 警告，不影响测试结果。

覆盖证据：

- 非 Git 项目：原目录不生成 .git，确认前不写入，环境文件/数据库文件不复制到副本。
- 真实 Git：dirty 仓库显式选择基线，staged、untracked、删除状态及 HEAD 保持不变。
- 冲突：同文件后一任务暂停并保留两侧内容；不同文件的接口契约变化触发重新验证。
- 外部修改：独立 Node 子进程在合入前或验证期间修改文件时，旧计划被拒绝或补偿，外部内容保留。
- 崩溃恢复：真实子进程强杀后由新 owner 按 journal 补偿；后续外部修改不被回滚，重复恢复幂等；过期 owner 不能继续写。
- 资源协调：依赖锁、DDL/迁移和共享数据库资源排他；取消任务只释放自身副本且不清场用户目录。
