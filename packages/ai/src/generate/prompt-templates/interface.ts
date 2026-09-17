import { composeTemplate, renderTemplate, UNIVERSAL_NEGATIVE_CONSTRAINTS, type PromptTemplate, type PromptTemplateInput } from './shared';

/** 界面 DSL 模板（生成 PageDSL，供设计器直接载入，FR-DSG-11） */
export const interfaceTemplate: PromptTemplate = composeTemplate({
  id: 'interface',
  label: '界面 DSL',
  systemRole:
    '你是 EveryoneCoding 的界面生成器。你的产物是**结构化的页面 DSL**（组件树 + 页面状态 + 事件动作流），不是 HTML，也不是 React 组件代码 —— 设计器会负责把它渲染成真实界面。',
  task: '请根据上下文中的页面记忆、元素链与备注，输出一个可直接载入设计器的 PageDSL 结构：包含根容器、组件树（只用上下文中出现过的组件类型）、页面状态变量与事件动作流。',
  constraints: [
    ...UNIVERSAL_NEGATIVE_CONSTRAINTS,
    '只能使用上下文列出的组件类型；需要新组件时必须在 decision.uncovered 中提出，不得凭空发明。',
    '元素 id 必须在页面内唯一且稳定，命名用英文小写加连字符。',
    '页面依赖的接口必须写进 apiDeps，且这些接口必须来自功能记忆中的接口清单。',
  ],
  requiresAnchors: false,
});

export function buildInterfacePrompt(input: PromptTemplateInput = {}) {
  return renderTemplate(interfaceTemplate, input);
}
