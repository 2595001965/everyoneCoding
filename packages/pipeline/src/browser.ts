/**
 * @ec/pipeline —— 浏览器安全入口（渲染层引用）。
 *
 * 与 @ec/ai 的 browser 条件入口同一模式：`exports.browser` 指向本文件，
 * Vite 解析 `@ec/pipeline` 时走这里，**不包含** persistence / recovery 两个
 * Node 侧模块（它们值引用 @ec/data → better-sqlite3，会污染浏览器构建）。
 *
 * 内容：全部纯数据 / 纯逻辑 / 端口注入模块（阶段定义、状态机、产物台账、
 * S1/S3/S4/S5 阶段与模板、契约注入、生成队列），均为浏览器安全。
 * 持久化与崩溃恢复由外壳在 Node 端装配，渲染层经 `PipelineApi` 端口间接使用。
 */

export * from './stage-defs';
export * from './pipeline-machine';
export * from './artifact-store';

export * from './stages/topo-sort';
export * from './stages/dependency-graph';
export * from './stages/s4-split';
export * from './stages/tech-choice-questionnaire';
export * from './stages/templates/requirement-doc';
export * from './stages/templates/tech-doc';
export * from './stages/contract-injector';
export * from './stages/generation-queue';
export * from './stages/s1-requirement';
export * from './stages/s3-techdoc';
export * from './stages/multi-platform-generator';
export * from './stages/s5-generate';
