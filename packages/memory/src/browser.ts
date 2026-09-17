/**
 * @ec/memory —— 浏览器安全入口（`exports.browser` 条件解析）。
 *
 * 只暴露 **domain 层**（五层模型 / 层级 / 冲突 / 继承覆盖的纯常量与纯函数），
 * 供渲染层记忆中心使用：LAYER_LABELS、MEMORY_LAYERS、layerOf、
 * CONFLICT_STRATEGY_LABELS、MemoryItem、MemoryStatus、IssueStatus 等。
 *
 * 不进浏览器构建的模块（根入口仍导出，Node 侧消费）：
 * - `repo/*`、`service/*`：依赖 @ec/data → better-sqlite3；
 * - `search/*`、`auto/*`、`io/*`、`debug-loop/*`、`condenser/*`：依赖 better-sqlite3
 *   或经端口注入的 Node 能力。
 *
 * 背景（Wave 2 遗留缺陷的修复）：渲染层记忆中心曾经根入口引用本包，
 * 把 @ec/data（better-sqlite3 / node:fs）拉进浏览器构建导致 vite build 失败。
 * 渲染层对 repo 层类型（MemoryPatch / ChangeLogRecord）的引用是 **type-only**，
 * 这里用 `export type` 再导出（编译期擦除，零运行时依赖）。
 */

export * from './domain/scope';
export * from './domain/memory-item';
export * from './domain/conflict';
export * from './domain/inheritance';

/* service 层的分区块常量（渲染层编辑器表单用）：
 * 这 4 个文件对 repo 层的引用全部是 `import type`（编译期擦除），
 * 运行时只依赖 domain 纯函数与 @ec/data 的 newUlid（browser 入口），浏览器安全。 */
export { FEATURE_SECTION_LABELS } from './service/feature-memory';
export { ISSUE_SECTION_LABELS } from './service/issue-memory';
export { PAGE_SECTION_LABELS } from './service/page-memory';
export { PROJECT_SECTION_TITLES } from './service/project-memory';

/* repo 层纯类型再导出（渲染层 import type 使用；编译期擦除，不引入 Node 依赖） */
export type { MemoryPatch, ChangeLogRecord } from './repo/memory-repo';
