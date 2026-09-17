/**
 * 提示词模板、结构化输出与多轮修正（T4-04）对外 API。
 *
 * 分层：
 * - `prompt-templates/*`：九类模板（需求 / 界面 / 技术文档 / 后端 / Web / 移动 / 鸿蒙 / 桌面 / 提交信息）
 * - `output-schema`：统一输出契约（files / anchors / summary / decision）与 zod 校验
 * - `parser`：四级解析（JSON → 围栏 JSON → Markdown 代码块降级 → 原样文本）
 * - `generator`：流式生成、中断保留、续写、解析失败重试一次
 * - `revision`：多轮修正的轮次记录与单独回退
 * - `decision-card`：决策说明四要素模型
 *
 * 浏览器安全：本目录不 import Node IO / SQLite / React，可被渲染层安全引用。
 */

export * from './output-schema';
export * from './parser';
export * from './generator';
export * from './revision';
export * from './decision-card';
export * from './prompt-templates';
