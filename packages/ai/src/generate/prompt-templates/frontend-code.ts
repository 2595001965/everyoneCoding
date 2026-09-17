import { composeTemplate, renderTemplate, UNIVERSAL_NEGATIVE_CONSTRAINTS, type PromptTemplate, type PromptTemplateInput } from './shared';

/**
 * Web 前端代码模板（FR-AI-13 端矩阵：Web 默认 React）。
 *
 * 关键约束：前端产物必须与设计器 DSL **零失真** —— 组件层级、状态名、接口调用
 * 都要与 DSL 对齐，否则"设计即产物"的承诺不成立。
 */
export const frontendCodeTemplate: PromptTemplate = composeTemplate({
  id: 'frontend-code',
  label: 'Web 前端代码',
  systemRole:
    '你是 EveryoneCoding 的 Web 前端工程师。技术栈默认 React 18 + TypeScript + Vite；若项目记忆指定了别的框架，以项目记忆为准。',
  task: '请依据页面 DSL 与备注生成 Web 前端产物：页面组件、状态管理、接口调用层与样式。组件层级与 DSL 元素一一对应（元素 id 保留为 data-element-id，便于锚点回写）。',
  constraints: [
    ...UNIVERSAL_NEGATIVE_CONSTRAINTS,
    '禁止引入 UI 框架（Ant Design / MUI 等）除非项目记忆明确允许；样式用项目既有的令牌变量。',
    '页面状态变量名必须与 DSL 的 state 定义一致，不得自行改名。',
    '接口调用统一走项目既有的请求封装，不得在组件里裸写 fetch。',
    '所有跟后端交互的字段必须与功能记忆中的接口契约一致。',
  ],
  requiresAnchors: true,
  requiresBuildableProject: true,
});

export function buildFrontendCodePrompt(input: PromptTemplateInput = {}) {
  return renderTemplate(frontendCodeTemplate, input);
}
