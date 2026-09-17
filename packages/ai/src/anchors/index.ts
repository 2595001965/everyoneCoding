/**
 * Code Anchor 管理与校验（T4-06）对外 API。
 *
 * 三重锚定：
 * 1. AI 生成时声明 anchor（`anchorDeclarationSchema`，来自 T4-04 的输出契约）
 * 2. 代码注释标记 `// @everyonecoding:anchor <elementId>`（comment-marker）
 * 3. AST 解析校验（ast-verify，适配器可注入；默认多语言符号索引器）
 *
 * 另外提供：锚点仓库（对齐 PRD §6.2 `code_anchor` 表）、漂移重定位与候选推荐（reassociate）。
 */

export * from './anchor-model';
export * from './comment-marker';
export * from './ast-verify';
export * from './anchor-repo';
export * from './reassociate';
