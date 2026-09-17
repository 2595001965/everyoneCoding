/**
 * @ec/memory —— 记忆领域层：五层模型、检索、自动抽取、结构精简、导入导出。
 *
 * 分层：
 * - `domain`：层级 / 条目 / 冲突 / 继承覆盖（纯函数，无 IO）
 * - `repo`：SQLite 读写（五层记忆、变更日志、结构变更历史）
 * - `service`：四类分层记忆的业务门面（项目 / 页面 / 功能 / 问题）
 * - `search`：FTS5 + 向量双路召回与 RRF 融合（T2-03）
 * - `auto`：长期记忆自动抽取与写入策略（T2-04）
 * - `debug-loop`：Debug 循环检测与问题记忆草稿（T2-05）
 * - `condenser`：PageDSL 结构精简与分层沉淀（T2-06）
 * - `io`：记忆导入导出与冲突合并预览（T2-07）
 *
 * 约束：
 * - 跨包引用只允许通过本单一入口，禁止深路径导入；
 * - 本包**不依赖 @ec/ai**：向量化与模型调用一律经端口（`EmbeddingPort` / `ExtractionModelPort`）
 *   由外壳注入，保证领域层可在无网络环境下完整测试与降级。
 */

/* ------------------------------ domain ------------------------------ */
export * from './domain/scope';
export * from './domain/memory-item';
export * from './domain/conflict';
export * from './domain/inheritance';

/* ------------------------------- repo ------------------------------- */
export * from './repo/memory-repo';

/* ----------------------------- service ------------------------------ */
export * from './service/upsert';
export * from './service/project-memory';
export * from './service/page-memory';
export * from './service/feature-memory';
export * from './service/issue-memory';

/* ------------------------------ search ------------------------------ */
export * from './search/fts-search';
export * from './search/embedder';
export * from './search/vector-search';
export { reciprocalRankFusion } from './search/rrf';
export type { RankedList, RrfOptions, RrfContribution, RrfFused } from './search/rrf';
export * from './search/hybrid';

/* ------------------------------- auto ------------------------------- */
export * from './auto/signal-strength';
export * from './auto/extractor';
export * from './auto/write-policy';
export * from './auto/conflict-card-source';
export * from './auto/change-log';

/* ---------------------------- debug-loop ---------------------------- */
export * from './debug-loop/window-queue';
export * from './debug-loop/detector';
export * from './debug-loop/prompt-card-source';
export * from './debug-loop/draft-builder';

/* ----------------------------- condenser ---------------------------- */
export * from './condenser/page-dsl';
export * from './condenser/rules';
export * from './condenser/condenser';
export * from './condenser/diff';
export * from './condenser/layer-dispatch';
export * from './condenser/token-estimator';
export * from './condenser/sink';

/* -------------------------------- io -------------------------------- */
export * from './io/export-json';
export * from './io/export-markdown';
export * from './io/import';
export * from './io/merge-preview';
export * from './io/facade';
