import { OUTPUT_CONTRACT_HARD_RULES, OUTPUT_CONTRACT_TEXT } from '../output-schema';

/**
 * 提示词模板的共用骨架（T4-04 要点 2）。
 *
 * §13.2 的提示词策略在这里落地为固定的三段结构：
 * 1. **角色与输出契约前置** —— 契约永远在系统提示词最前面，避免"读到一半才想起要 JSON"；
 * 2. **任务描述**（用户消息）—— 说明本次要产出什么、给谁用、边界在哪；
 * 3. **硬约束清单** —— 每个模板都必须包含公共三条（禁止臆造接口 / 必须声明 anchor /
 *    必须给出变更说明+风险+未覆盖点），再叠加端专用约束与项目记忆带来的约束。
 */

/** 九类生成目标（与 AiPurpose / 端矩阵对齐） */
export const GENERATION_TARGETS = [
  'requirement',
  'interface',
  'techdoc',
  'backend-code',
  'frontend-code',
  'mobile-code',
  'harmony-code',
  'desktop-code',
  'commit-msg',
] as const;
export type GenerationTarget = (typeof GENERATION_TARGETS)[number];

export interface PromptTemplateInput {
  /** 用户补充指令（FR-PIPE-12），优先级高于默认推断 */
  instruction?: string | undefined;
  /** 项目 / 页面的技术选型（来自项目记忆；缺省时用端默认方案） */
  stack?: string | null | undefined;
  /** 项目名（用于措辞） */
  projectName?: string | undefined;
  /** 由记忆转化出的额外约束 */
  extraConstraints?: readonly string[] | undefined;
}

export interface PromptTemplate {
  id: GenerationTarget;
  /** 中文标签 */
  label: string;
  systemRole: string;
  /** 任务描述（渲染为 user 消息正文） */
  task: string;
  /** 硬约束清单（已含公共三条） */
  constraints: string[];
  outputContract: string;
  /** 该端是否必须输出 anchors 声明 */
  requiresAnchors: boolean;
  /** 该端是否必须产出可编译工程结构（FR-AI-13 各端矩阵的真实产物要求） */
  requiresBuildableProject: boolean;
}

export interface TemplateConfig {
  id: GenerationTarget;
  label: string;
  systemRole: string;
  task: string;
  /** 端专用约束（公共三条会自动追加在最前） */
  constraints?: readonly string[];
  /** 是否覆写默认输出契约（例如 commit-msg 不需要文件清单） */
  outputContract?: string | undefined;
  requiresAnchors?: boolean;
  requiresBuildableProject?: boolean;
}

export function composeTemplate(config: TemplateConfig): PromptTemplate {
  const constraints = [
    ...OUTPUT_CONTRACT_HARD_RULES.map((rule) => rule.trim()),
    ...(config.constraints ?? []),
  ];
  const template: PromptTemplate = {
    id: config.id,
    label: config.label,
    systemRole: config.systemRole,
    task: config.task,
    constraints,
    outputContract: config.outputContract ?? OUTPUT_CONTRACT_TEXT,
    requiresAnchors: config.requiresAnchors ?? true,
    requiresBuildableProject: config.requiresBuildableProject ?? false,
  };
  return template;
}

/** 渲染为可直接投喂的消息对；项目约束与用户指令在这里合并进 user 消息 */
export function renderTemplate(
  template: PromptTemplate,
  input: PromptTemplateInput = {},
): { system: string; user: string; template: PromptTemplate } {
  const system = [
    template.systemRole,
    '',
    template.outputContract,
    '',
    '## 硬约束（违反即返工）',
    ...template.constraints.map((constraint, index) => `${index + 1}. ${constraint}`),
  ].join('\n');

  const taskLines = [template.task];
  if (input.projectName !== undefined && input.projectName.length > 0) {
    taskLines.push(`项目：${input.projectName}`);
  }
  if (input.stack !== undefined && input.stack !== null && input.stack.length > 0) {
    taskLines.push(`技术选型（来自项目记忆，必须遵守）：${input.stack}`);
  }
  if (input.extraConstraints !== undefined && input.extraConstraints.length > 0) {
    taskLines.push('项目既有约定（来自记忆，必须遵守）：');
    for (const constraint of input.extraConstraints) taskLines.push(`- ${constraint}`);
  }
  if (input.instruction !== undefined && input.instruction.trim().length > 0) {
    taskLines.push(`用户补充指令（优先级最高）：${input.instruction.trim()}`);
  }

  return { system, user: taskLines.join('\n'), template };
}

/** 公共约束：禁止臆造接口 / 输出 anchor / 四要素决策（与 output-schema 同源） */
export const COMMON_CONSTRAINTS = OUTPUT_CONTRACT_HARD_RULES;

/** 通用「不要做」清单：跨端复用 */
export const UNIVERSAL_NEGATIVE_CONSTRAINTS: readonly string[] = [
  '不要输出与本次任务无关的文件；不要顺手重构既有代码。',
  '不要写 TODO / 占位实现 / 伪代码，所有函数体必须可直接运行。',
  '不要修改已生成依赖的接口签名；如需变更请在 decision.risks 中说明并给出迁移方案。',
];
