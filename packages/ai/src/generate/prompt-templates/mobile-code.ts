import {
  composeTemplate,
  renderTemplate,
  UNIVERSAL_NEGATIVE_CONSTRAINTS,
  type PromptTemplate,
  type PromptTemplateInput,
} from './shared';

/**
 * 移动端代码模板（FR-AI-13：移动双端默认 Flutter 单代码库）。
 *
 * 若项目记忆选择了 React Native 或原生方案，`stack` 会带过来，模板以项目记忆为准；
 * 此处只约束"必须是能编译的单一代码库 + 平台差异用条件分支而不是复制文件"。
 */
export const mobileCodeTemplate: PromptTemplate = composeTemplate({
  id: 'mobile-code',
  label: '移动端代码',
  systemRole:
    '你是 EveryoneCoding 的移动端工程师。默认方案是 Flutter（单代码库覆盖 Android 与 iOS）；若项目记忆指定了 React Native 或原生方案，以项目记忆为准。',
  task: '请依据页面 DSL 生成移动端产物：页面 Widget/组件、状态管理、网络层与平台适配。目录结构遵循所选框架的官方约定，且必须能直接编译。',
  constraints: [
    ...UNIVERSAL_NEGATIVE_CONSTRAINTS,
    'Android 与 iOS 必须共用同一套页面代码；平台差异用运行时判断或条件编译，禁止复制两份页面。',
    '移动端必须处理安全区与键盘遮挡（对应 DSL 的 viewport 与 safeArea）。',
    '网络层必须复用后端接口契约，禁止自行拼装 URL。',
    '禁止引入未经项目记忆批准的第三方依赖；新增依赖必须在 decision.risks 中说明体积与许可影响。',
  ],
  requiresAnchors: true,
  requiresBuildableProject: true,
});

export function buildMobileCodePrompt(input: PromptTemplateInput = {}) {
  return renderTemplate(mobileCodeTemplate, input);
}
