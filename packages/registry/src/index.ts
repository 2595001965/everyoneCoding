/**
 * @ec/registry —— 统一标识注册表 + 重命名引擎（Wave 7 全量交付，T7-01 ~ T7-05）。
 *
 * 分层：
 * - `registry-model` / `registry-repo`：稳定 ID + 规范名 + 八类投影 + 别名 + 历史名 + 同步状态（T7-01）
 * - `naming/*`：命名规则引擎（七端预设、中文→英文/拼音、模板填充）（T7-01）
 * - `conflict-check`：保留字 / 冲突 / 超长 / 非法字符四类检测 + 3 个建议名（T7-01）
 * - `occurrence/*`：出现位置索引（AST 作用域感知 / 文档 / 记忆 / 逻辑结构 + 三级风险）（T7-02）
 * - `rename-trigger` / `impact-analyzer`：四处触发点 + 300ms 防抖 + 影响面三级分组（T7-03）
 * - `unified-diff` / `rename-transaction` / `executors/*` / `rename-event`：四栏 diff、
 *   事务化执行、一键撤销、rename 事件与 Git 提交（T7-04）
 * - `migration/*` / `alias-manager` / `batch-rename`：数据库迁移（D-08）、别名兼容期、批处理（T7-05）
 *
 * 约束：
 * - 跨包引用只允许通过本单一入口；渲染层走 `exports.browser`（`src/browser.ts`）；
 * - **AI 是代码与数据库脚本的唯一写入口**（D-04 / D-08）：本包只产出"变更计划 + 内容"，
 *   真正落盘由外壳注入的文件 / 文档 / 记忆 / DSL / 锚点端口完成；
 * - **AST 解析（含 `typescript` 依赖）只在 Node 侧入口导出**，浏览器入口严禁引用，
 *   否则会把 TypeScript 编译器拖进渲染层构建（同 Wave 4 的 ts-morph 结论）。
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

/* T7-02 出现位置索引 */
export * from './occurrence/types';
export * from './occurrence/text-utils';
export * from './occurrence/semantic';
export * from './occurrence/risk-classifier';
export * from './occurrence/doc-scanner';
export * from './occurrence/memory-scanner';
export * from './occurrence/logic-scanner';
export * from './occurrence/index-builder';
/* AST 解析器（Node 侧：TS 编译器 API + Python / Java 内置作用域解析器） */
export * from './occurrence/ast';

/* T7-03 触发与影响面 */
export * from './rename-trigger';
export * from './impact-analyzer';

/* T7-04 事务化执行 */
export * from './unified-diff';
export * from './rename-event';
export * from './rename-transaction';
export * from './executors';

/* T7-05 迁移 / 别名 / 批处理 */
export * from './migration';
export * from './alias-manager';
export * from './batch-rename';
