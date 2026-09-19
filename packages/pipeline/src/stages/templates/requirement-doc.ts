/**
 * S1 需求文档模板（T5-03 / FR-PIPE-05）。
 *
 * - `REQUIREMENT_DOC_SECTIONS`：八项要素（任务卡验收逐一断言）；
 * - `buildRequirementPrompt`：提示词渲染（长期记忆偏好 + 相似项目 + 禁止事项强约束句式）；
 * - `checkRequirementDocCompleteness`：标题锚点级完整性校验（生成后机器可断言）；
 * - `renderRequirementDoc`：把结构化片段渲染为完整 Markdown（测试与降级用）。
 *
 * 本文件是纯数据 + 纯函数，不 import Node IO / SQLite / React。
 */

export const REQUIREMENT_DOC_SECTIONS = [
  '项目背景',
  '目标用户',
  '功能清单',
  '用户故事',
  '业务流程图',
  '验收标准',
  '非功能要求',
  '风险与假设',
] as const;

export type RequirementDocSection = (typeof REQUIREMENT_DOC_SECTIONS)[number];

export const REQUIREMENT_DOC_SECTION_LABELS: Record<RequirementDocSection, string> = {
  项目背景: '项目背景',
  目标用户: '目标用户',
  功能清单: '功能清单',
  用户故事: '用户故事',
  业务流程图: '业务流程图',
  验收标准: '验收标准',
  非功能要求: '非功能要求',
  风险与假设: '风险与假设',
};

/** 标题锚点（按 8 项顺序渲染）；校验时按此正则匹配 */
const SECTION_HEADING_PATTERN = /^#{1,3}\s*(.+?)\s*$/;

/** 相似项目记忆摘要（T5-03 要点 1：检索 top3 相似项目的项目记忆） */
export interface SimilarProjectSummary {
  projectId: string;
  name: string;
  /** 项目记忆摘要（要点、架构、经验） */
  summary: string;
  /** 相似度 0–1 */
  score: number;
}

export interface RequirementPromptInput {
  projectName: string;
  /** 用户自然语言描述（200 字级别） */
  description: string;
  /** 长期记忆偏好（如"必须有单元测试"） */
  preferences: readonly string[];
  /** 长期记忆禁止事项（必须用强约束句式注入） */
  forbidden: readonly string[];
  /** 相似项目记忆（top3） */
  similarProjects?: readonly SimilarProjectSummary[] | undefined;
  /** 用户补充指令（追加要求 / 局部修改时注入，优先级最高） */
  instruction?: string | undefined;
}

/**
 * 渲染提示词。
 * - 系统提示词：角色 + 八项输出契约 + 禁止事项强约束（§13.2 句式："绝不可/必须…"）；
 * - 用户消息：描述 + 偏好 + 相似项目摘要。
 */
export function buildRequirementPrompt(input: RequirementPromptInput): {
  system: string;
  user: string;
} {
  const forbiddenLines = input.forbidden.map(
    (item) => `- 【强约束】${item}。此条为禁止事项，违反即返工。`,
  );
  const preferenceLines = input.preferences.map((item) => `- ${item}`);

  const system = [
    '你是 EveryoneCoding 的需求分析师。你的任务是把用户的自然语言想法转化为**结构化需求文档**。',
    '',
    '## 输出契约',
    '输出一份完整的 Markdown 需求文档，**必须包含以下八个部分**（顺序不限，但八个小节标题必须逐字出现）：',
    ...REQUIREMENT_DOC_SECTIONS.map((section, index) => `${index + 1}. ## ${section}`),
    '',
    '- 功能清单：每项功能标注优先级 P0（核心必做）/ P1（重要）/ P2（锦上添花）；',
    '- 用户故事：统一采用「作为…我希望…以便…」句式；',
    '- 业务流程图：使用 Mermaid flowchart 代码块（```mermaid 围栏）；',
    '- 验收标准：可勾选的清单（- [ ] 项）。',
    '',
    '## 硬约束',
    '1. 不要臆造事实：所有功能必须有依据，不确定的需求写进「风险与假设」。',
    '2. 八个小节标题必须逐字出现（## 项目背景 / ## 目标用户 / ## 功能清单 / ## 用户故事 / ## 业务流程图 / ## 验收标准 / ## 非功能要求 / ## 风险与假设），否则视为输出不合格。',
    '3. 业务流程图必须使用 Mermaid 的 flowchart（TD 或 LR 方向）语法。',
    ...(input.forbidden.length > 0
      ? ['', '## 禁止事项（来自长期记忆，违反即返工）', ...forbiddenLines]
      : []),
  ].join('\n');

  const userLines = [
    `项目名：${input.projectName}`,
    '',
    '## 用户想法（自然语言描述）',
    input.description,
  ];
  if (preferenceLines.length > 0)
    userLines.push('', '## 长期记忆中的偏好（必须体现）', ...preferenceLines);
  if (input.similarProjects !== undefined && input.similarProjects.length > 0) {
    userLines.push('', '## 相似项目记忆（参考其经验与教训，但不照抄）');
    for (const project of input.similarProjects) {
      userLines.push(
        `- [${project.name}]（相似度 ${project.score.toFixed(2)}）`,
        `  ${project.summary}`,
      );
    }
  }
  if (input.instruction !== undefined && input.instruction.trim().length > 0) {
    userLines.push('', `## 用户补充指令（优先级最高，必须响应）`, input.instruction.trim());
  }
  userLines.push('', '请输出完整的 Markdown 需求文档。');

  return { system, user: userLines.join('\n') };
}

/** 完整性校验：八个小节标题逐字匹配（允许有额外小节） */
export function checkRequirementDocCompleteness(markdown: string): {
  missing: RequirementDocSection[];
  present: RequirementDocSection[];
} {
  const present = new Set<RequirementDocSection>();
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const match = SECTION_HEADING_PATTERN.exec(line.trim());
    if (match === null) continue;
    const heading = match[1]?.trim() ?? '';
    for (const section of REQUIREMENT_DOC_SECTIONS) {
      if (heading === section) present.add(section);
    }
  }
  const missing = REQUIREMENT_DOC_SECTIONS.filter((section) => !present.has(section));
  return { missing, present: REQUIREMENT_DOC_SECTIONS.filter((section) => present.has(section)) };
}

/** 抽取业务流程图里的 Mermaid 源码（供 UI 渲染；无流程图返回 null） */
export function extractMermaidFlowchart(markdown: string): string | null {
  const pattern = /```mermaid\s*\n([\s\S]*?)```/;
  const match = pattern.exec(markdown);
  return match?.[1]?.trim() ?? null;
}

/** 抽取功能清单（P0/P1/P2 优先级解析；供 UI 摘要展示） */
export function extractFeaturePriorities(
  markdown: string,
): { name: string; priority: 'P0' | 'P1' | 'P2' }[] {
  const result: { name: string; priority: 'P0' | 'P1' | 'P2' }[] = [];
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^[-*]\s*(P[0-2])\s*[:：]?\s*(.+)$/.exec(line.trim());
    if (match !== null) {
      const priority = match[1];
      if (priority === 'P0' || priority === 'P1' || priority === 'P2') {
        result.push({ name: match[2]?.trim() ?? '', priority });
      }
    }
  }
  return result;
}

/** 降级渲染：把提示词输入渲染为一份完整模板（AI 不可用时保证产物可交付） */
export function renderRequirementDoc(input: RequirementPromptInput): string {
  const now = new Date().toISOString().slice(0, 10);
  const preferences = input.preferences.length > 0 ? input.preferences.join('；') : '（无）';
  const similar =
    input.similarProjects !== undefined && input.similarProjects.length > 0
      ? input.similarProjects
          .map(
            (project) =>
              `- ${project.name}（相似度 ${project.score.toFixed(2)}）：${project.summary}`,
          )
          .join('\n')
      : '（暂无）';
  const forbidden =
    input.forbidden.length > 0 ? input.forbidden.map((item) => `- ${item}`).join('\n') : '（无）';

  return [
    `# ${input.projectName} 需求文档`,
    '',
    `> 生成日期：${now} | 来源：用户自然语言描述`,
    '',
    '## 项目背景',
    '',
    input.description,
    '',
    '## 目标用户',
    '',
    '- 主要用户：（待补充）',
    '- 使用场景：（待补充）',
    '',
    '## 功能清单',
    '',
    '- [ ] P0：核心业务流程（待细化）',
    '- [ ] P1：辅助功能（待细化）',
    '- [ ] P2：增强功能（待细化）',
    '',
    '## 用户故事',
    '',
    '- 作为**用户**，我希望**完成核心任务**，以便**达成目标**。',
    '',
    '## 业务流程图',
    '',
    '```mermaid',
    'flowchart TD',
    '    A[开始] --> B[核心流程]',
    '    B --> C[完成]',
    '```',
    '',
    '## 验收标准',
    '',
    '- [ ] 核心流程可走通',
    '- [ ] 数据可持久化',
    '',
    '## 非功能要求',
    '',
    `- 长期记忆偏好：${preferences}`,
    ...(input.forbidden.length > 0 ? ['- 禁止事项：', forbidden] : []),
    '',
    '## 风险与假设',
    '',
    '- 假设：需求以描述为准，细节由后续阶段细化。',
    '- 风险：需求变更可能影响后续阶段产物。',
    '',
    '---',
    '',
    `> 参考相似项目：\n${similar}`,
  ].join('\n');
}
