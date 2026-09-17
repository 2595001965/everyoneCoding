/**
 * 上下文引擎（T4-02）与 Token 预算裁剪（T4-03）对外 API。
 *
 * 分层：
 * - `context-types`：块契约与数据端口（八类块 + 指令 / 依赖契约两类工程块）
 * - `blocks/*`：十类块的构建实现（端口缺失时优雅跳过）
 * - `context-engine`：组装编排、提示词渲染、超限重试
 * - `token-budget` / `trimmer` / `truncate-report`：配额、裁剪与省略报告
 * - `context-panel-model`：面板视图模型（勾选 / 编辑 / token 分布）
 *
 * 浏览器安全：本目录不 import `@ec/data`、`@ec/memory`、`@ec/designer`，
 * 一切外部数据都经 `ContextSources` 端口注入。
 */

export * from './context-types';
export * from './token-budget';
export * from './truncate-report';
export * from './trimmer';
export * from './context-engine';
export * from './context-panel-model';

export { buildLongtermBlock } from './blocks/longterm';
export { buildProjectBlock } from './blocks/project';
export { buildFeatureBlock } from './blocks/feature';
export { buildPageBlock } from './blocks/page';
export { buildElementChainBlock } from './blocks/element-chain';
export { buildNoteBlock } from './blocks/note';
export { buildIssueBlock } from './blocks/issue';
export { buildDocumentBlock, documentWeight } from './blocks/document';
export { buildCodeBlock, codeWeight } from './blocks/code';
export { buildDependencyContractBlock, describeContracts } from './blocks/dependency-contract';
export { buildMemoryBlock, memoryItemWeight, formatMemoryItem } from './blocks/shared';
export type { MemoryBlockConfig } from './blocks/shared';
