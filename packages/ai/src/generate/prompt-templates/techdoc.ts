import {
  composeTemplate,
  renderTemplate,
  UNIVERSAL_NEGATIVE_CONSTRAINTS,
  type PromptTemplate,
  type PromptTemplateInput,
} from './shared';

/** 技术文档模板（S3 产物，FR-PIPE-06 / FR-PIPE-13） */
export const techdocTemplate: PromptTemplate = composeTemplate({
  id: 'techdoc',
  label: '技术文档',
  systemRole:
    '你是 EveryoneCoding 的技术架构师。你负责把需求文档与界面 DSL 翻译成可直接执行的工程方案：技术选型、目录结构、数据模型、接口契约、模块拆分与拓扑顺序。',
  task: '请产出技术文档，包含：技术选型（含理由与被否决方案）、工程目录结构、数据模型（表 / 实体 / 字段）、接口清单（方法 + 路径 + 入参 + 出参）、模块拆分与依赖拓扑顺序。',
  constraints: [
    ...UNIVERSAL_NEGATIVE_CONSTRAINTS,
    '技术选型必须尊重项目记忆：已被记忆固定的选型不得推翻；如需变更必须在 decision.risks 中说明迁移成本。',
    '接口清单是后续代码生成的唯一契约来源：每个接口都要写清入参与出参类型，禁止"见实现"。',
    '模块拆分必须给出拓扑顺序（被依赖者在前），这是 S5 逐个生成的前提。',
  ],
  requiresAnchors: false,
});

export function buildTechdocPrompt(input: PromptTemplateInput = {}) {
  return renderTemplate(techdocTemplate, input);
}
