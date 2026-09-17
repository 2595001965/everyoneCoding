/**
 * @ec/registry —— 浏览器安全入口（渲染层引用）。
 *
 * 与 `@ec/ai` / `@ec/git` / `@ec/pipeline` 的条件入口同一模式：`exports.browser` 指向本文件，
 * Vite 解析 `@ec/registry` 时走这里，**不包含**会引入 `typescript` 编译器的模块。
 *
 * 被排除的（Node 侧专用）：
 * - `occurrence/ast/**`（TS 编译器 API / Python / Java 解析器）
 * - `occurrence/index-builder`（依赖 AST 调度器）
 *
 * 换句话说，渲染层拿到的能力是：
 * **命名规则 + 冲突检测 + 影响面分析 + 四栏 diff + 触发防抖 + 事务编排 + 迁移预览脚本解析**
 * （全部为纯逻辑 / 纯数据）；真正的索引构建与文件读写由外壳注入端口完成
 * （`globalThis.__EC_RENAME__`，见 `features/rename/rename-api.tsx`）。
 */

export * from './ids';

/* T7-01 注册表与命名 */
export * from './registry-model';
export * from './registry-repo';
export * from './naming/glossary';
export * from './naming/pinyin';
export * from './naming/identifier';
export * from './naming/presets';
export * from './naming/rule-engine';
export * from './conflict-check';

/* T7-02 出现位置索引（纯数据层：类型 + 文档 / 记忆 / 逻辑扫描 + 风险分级） */
export * from './occurrence/types';
export * from './occurrence/text-utils';
export * from './occurrence/semantic';
export * from './occurrence/risk-classifier';
export * from './occurrence/doc-scanner';
export * from './occurrence/memory-scanner';
export * from './occurrence/logic-scanner';

/* T7-03 触发与影响面 */
export * from './rename-trigger';
export * from './impact-analyzer';

/* T7-04 事务化执行（执行器本体为纯逻辑，端口由外壳注入） */
export * from './unified-diff';
export * from './rename-event';
export * from './rename-transaction';
export * from './executors';

/* T7-05 迁移 / 别名 / 批处理 */
export * from './migration';
export * from './alias-manager';
export * from './batch-rename';
