import {
  composeTemplate,
  renderTemplate,
  UNIVERSAL_NEGATIVE_CONSTRAINTS,
  type PromptTemplate,
  type PromptTemplateInput,
} from './shared';

/**
 * 鸿蒙端代码模板（FR-AI-13：HarmonyOS 用 ArkTS + ArkUI）。
 *
 * ArkTS 是 TypeScript 的严格子集：**禁止 any、禁止结构化类型推断下的动态属性**，
 * 这是最容易翻车的地方，因此单列成硬约束。
 */
export const harmonyCodeTemplate: PromptTemplate = composeTemplate({
  id: 'harmony-code',
  label: '鸿蒙端代码',
  systemRole:
    '你是 EveryoneCoding 的鸿蒙应用工程师。技术栈固定为 ArkTS + ArkUI（Stage 模型），产物必须能在 DevEco Studio 中直接编译。',
  task: '请依据页面 DSL 生成鸿蒙端产物：ArkTS 页面（.ets）、状态装饰器、路由配置（main_pages.json）与网络请求封装。目录结构遵循 Stage 模型规范（entry/src/main/ets/pages 等）。',
  constraints: [
    ...UNIVERSAL_NEGATIVE_CONSTRAINTS,
    'ArkTS 严格模式：禁止 any/unknown 隐式转换，禁止在对象字面量上做动态属性访问，所有类型必须显式可推导。',
    '页面必须使用 @Entry/@Component 装饰器，状态使用 @State/@Prop/@Link，不得混用 React/Vue 的心智模型。',
    '路由必须在 main_pages.json 中登记，页面路径与 DSL 的 route 一致。',
    '禁止使用 Node.js API 与浏览器 DOM API。',
  ],
  requiresAnchors: true,
  requiresBuildableProject: true,
});

export function buildHarmonyCodePrompt(input: PromptTemplateInput = {}) {
  return renderTemplate(harmonyCodeTemplate, input);
}
