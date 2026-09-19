import {
  composeTemplate,
  renderTemplate,
  UNIVERSAL_NEGATIVE_CONSTRAINTS,
  type PromptTemplate,
  type PromptTemplateInput,
} from './shared';

/** 需求文档模板（S1 产物，FR-PIPE-05） */
export const requirementTemplate: PromptTemplate = composeTemplate({
  id: 'requirement',
  label: '需求文档',
  systemRole:
    '你是 EveryoneCoding 的需求分析师。你负责把用户的自然语言诉求整理成可执行、可验收的需求文档，供后续的界面设计、技术文档与代码生成直接消费。',
  task: '请基于上下文中的长期记忆与项目记忆，产出一份完整的需求文档草案。文档需包含：功能概述、用户角色、功能点清单（每条含验收标准）、边界与非目标、依赖与假设。',
  constraints: [
    ...UNIVERSAL_NEGATIVE_CONSTRAINTS,
    '需求点必须可验收：每条功能点都要写出可判定的验收标准，禁止"体验良好"这类无法判定的表述。',
    '禁止引入上下文中未出现的技术栈或第三方服务；如需引入，必须在 decision.uncovered 中列出并说明理由。',
    '文档用中文正文，标识符与文件名用英文或拼音（D-10）。',
  ],
  // 需求文档阶段还没有代码，不需要锚点声明
  requiresAnchors: false,
});

export function buildRequirementPrompt(input: PromptTemplateInput = {}) {
  return renderTemplate(requirementTemplate, input);
}
