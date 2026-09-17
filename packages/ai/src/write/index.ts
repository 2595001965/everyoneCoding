/**
 * 代码写入管线与只读约束（T4-05）对外 API。
 *
 * 分层：
 * - `write-types`：工作区文件端口与计划/结果契约
 * - `apply-strategy/*`：三种模式（新建 / 增量补丁 / 预览）的策略实现
 * - `write-pipeline`：计划编排、冲突检测、事务写与事件广播
 * - `diff-view-model`：可交互差异模型（按文件 / 按块选择）
 * - `read-only-guard`：运行时拦截 + 静态扫描（D-04 的机器可验证口径）
 * - `external-change-watcher`：外部改动检测与提示
 *
 * 硬约束：不存在"用户手动编辑代码"的模式（FR-AI-11）。
 */

export * from './write-types';
export * from './apply-strategy/patch';
export * from './apply-strategy/preview';
export { planCreateEntry } from './apply-strategy/create';
export * from './write-pipeline';
export * from './diff-view-model';
export * from './read-only-guard';
export * from './external-change-watcher';
