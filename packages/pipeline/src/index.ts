/**
 * @ec/pipeline —— S1–S7 状态机与阶段产物。
 *
 * 分层：
 * - `stage-defs`：七阶段静态定义（输入 / 产出物 / 完成条件 / 可否跳过）
 * - `pipeline-machine`：显式状态机（非法转移抛 InvalidTransitionError）
 * - `artifact-store`：产物版本化（每版本独立内容引用与 diff 引用，切换只改指针）
 * - `persistence`：pipeline_run / stage_artifact 表读写 + 状态快照序列化
 * - `recovery`：崩溃恢复与断点续生成（复用 @ec/core CrashRecovery）
 * - `stages/`：S1 需求文档、S3 技术选型问卷 + 技术文档、S4 拆分 DAG、S5 生成队列
 *
 * 约束：跨包引用只允许通过本单一入口，禁止深路径导入。
 */

export * from './stage-defs';
export * from './pipeline-machine';
export * from './artifact-store';
export * from './persistence';
export * from './recovery';

export * from './stages/templates/requirement-doc';
export * from './stages/templates/tech-doc';
export * from './stages/s1-requirement';
export * from './stages/tech-choice-questionnaire';
export * from './stages/s3-techdoc';
export * from './stages/topo-sort';
export * from './stages/dependency-graph';
export * from './stages/s4-split';
export * from './stages/contract-injector';
export * from './stages/generation-queue';
export * from './stages/multi-platform-generator';
export * from './stages/s5-generate';
