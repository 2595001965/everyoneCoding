/**
 * 数据库迁移出口（T7-05）。
 *
 * - `ddl-generator`：提示词构造 + AI 输出解析（D-08：脚本只能由 AI 生成）
 * - `safety-check`：SQL 高危检测（DROP / 类型变更 / NOT NULL 收紧 → 二次确认）
 * - `migration-preview`：SQL 预览 + 影响行数估算 + 锁表 / 耗时风险
 * - `migration-executor`：确认后一键执行（流式日志、失败自动回滚、记录 rename 事件与提交）
 */

export * from './ddl-generator';
export * from './safety-check';
export * from './migration-preview';
export * from './migration-executor';
