/**
 * S3 技术文档模板（T5-04 / FR-PIPE-06 / FR-PIPE-07）。
 *
 * 八项内容：技术选型（含理由与权衡）、系统架构（Mermaid 分层图 + 部署图）、
 * 模块划分、数据模型（Mermaid ER + 表结构清单）、接口设计（OpenAPI 3.0 草案）、
 * 安全设计、性能与容量估算、测试策略。
 *
 * - `buildTechDocPrompt`：提示词渲染（技术选型问卷结果 + 需求文档 + 记忆约束）；
 * - `checkTechDocCompleteness`：八项标题完整性校验；
 * - `extractOpenApiDraft`：从 yaml/json 围栏提取 OpenAPI 草案（供 T6-05 Mock Server 消费）；
 * - `findForbiddenTech`：禁止技术后置校验器（检测到即触发重新生成并告警）。
 *
 * 纯数据 + 纯函数，浏览器安全。
 */

export const TECH_DOC_SECTIONS = [
  '技术选型',
  '系统架构',
  '模块划分',
  '数据模型',
  '接口设计',
  '安全设计',
  '性能与容量估算',
  '测试策略',
] as const;

export type TechDocSection = (typeof TECH_DOC_SECTIONS)[number];

export interface TechDocPromptInput {
  projectName: string;
  /** 技术选型问卷结果（structured.stack 的文本） */
  stack: string;
  /** 目标端组合（写入 structured.targetPlatforms） */
  targetPlatforms: readonly string[];
  /** 需求文档全文（八项要素的 Markdown） */
  requirementDoc: string;
  /** 项目记忆已声明的技术栈（与问卷冲突时需给出对比说明） */
  declaredStack?: string | null | undefined;
  /** 记忆中的禁止技术（后置校验与强约束句式双保险） */
  forbidden: readonly string[];
  /** 用户补充指令 */
  instruction?: string | undefined;
}

const SECTION_HEADING_PATTERN = /^#{1,3}\s*(.+?)\s*$/;

/** 渲染提示词：问卷结果 + 记忆约束前置，禁止技术用强约束句式 */
export function buildTechDocPrompt(input: TechDocPromptInput): { system: string; user: string } {
  const forbiddenLines = input.forbidden.map(
    (item) => `- 【强约束】禁止使用 ${item}。此条来自记忆，违反即返工。`,
  );
  const stackLines = [
    ...input.targetPlatforms.map((platform) => `- 目标端：${platform}`),
    ...input.stack.split('\n').map((line) => `- ${line}`),
  ];

  const system = [
    '你是 EveryoneCoding 的技术架构师。你的任务是基于需求文档与技术选型问卷，输出**结构化技术文档**。',
    '',
    '## 输出契约',
    '输出一份完整的 Markdown 技术文档，**必须包含以下八个部分**（小节标题必须逐字出现）：',
    ...TECH_DOC_SECTIONS.map((section, index) => `${index + 1}. ## ${section}`),
    '',
    '- 技术选型：给出选型理由与权衡（问卷结果必须逐条遵守，冲突时给对比说明而非覆盖）；',
    '- 系统架构：Mermaid 分层图（flowchart）**和**部署图各一个代码块；',
    '- 数据模型：Mermaid erDiagram 代码块 + 表结构清单（字段、类型、约束）；',
    '- 接口设计：**OpenAPI 3.0 草案**（yaml 格式，用 ```yaml 围栏包裹，info.openapi 必须是 "3.0.0" 或 3.0.x）；',
    '- 性能与容量估算：给出量化估算（QPS、存储增长、内存预算）。',
    '',
    '## 硬约束',
    '1. 技术选型必须严格遵守问卷结果与项目记忆已声明技术栈；两者冲突时，在「技术选型」小节给出对比说明，**不得直接覆盖记忆**。',
    '2. 记忆中的禁止技术绝不可出现在方案中（含依赖与命令示例）。',
    '3. OpenAPI 草案必须结构合法（paths / components 齐全，operation 至少含 summary）。',
    '4. 不要臆造第三方服务与依赖；确有必要时写进「风险与假设」并由决策说明承担。',
    ...(input.forbidden.length > 0
      ? ['', '## 禁止事项（来自记忆，违反即返工）', ...forbiddenLines]
      : []),
  ].join('\n');

  const userLines = [
    `项目名：${input.projectName}`,
    '',
    '## 技术选型问卷结果（必须逐条遵守）',
    ...stackLines,
  ];
  if (
    input.declaredStack !== null &&
    input.declaredStack !== undefined &&
    input.declaredStack.trim().length > 0
  ) {
    userLines.push('', '## 项目记忆已声明的技术栈（冲突时对比说明）', input.declaredStack);
  }
  userLines.push('', '## 需求文档（输入）', input.requirementDoc);
  if (input.instruction !== undefined && input.instruction.trim().length > 0) {
    userLines.push('', `## 用户补充指令（优先级最高）`, input.instruction.trim());
  }
  userLines.push('', '请输出完整的 Markdown 技术文档。');

  return { system, user: userLines.join('\n') };
}

/** 八项完整性校验 */
export function checkTechDocCompleteness(markdown: string): {
  missing: TechDocSection[];
  present: TechDocSection[];
} {
  const present = new Set<TechDocSection>();
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const match = SECTION_HEADING_PATTERN.exec(line.trim());
    if (match === null) continue;
    const heading = match[1]?.trim() ?? '';
    for (const section of TECH_DOC_SECTIONS) {
      if (heading === section) present.add(section);
    }
  }
  const missing = TECH_DOC_SECTIONS.filter((section) => !present.has(section));
  return { missing, present: TECH_DOC_SECTIONS.filter((section) => present.has(section)) };
}

/**
 * 从 yaml 围栏提取 OpenAPI 3.0 草案（T6-05 Mock Server 消费）。
 * 校验 info.openapi 版本；提取失败返回 null。
 */
export function extractOpenApiDraft(markdown: string): string | null {
  const pattern = /```yaml\s*\n([\s\S]*?)```/;
  const match = pattern.exec(markdown);
  if (match === null || match[1] === undefined) return null;
  const draft = match[1].trim();
  // 结构合法性初判：openapi 版本 + paths 存在
  if (!/openapi\s*:\s*["']?3\.0/i.test(draft)) return null;
  if (!/^\s*paths:/m.test(draft) && !/^\s*paths\s*:/m.test(draft)) return null;
  return draft;
}

/** 校验 OpenAPI 草案是否可被消费（供 T6-05 与测试断言） */
export function validateOpenApiDraft(draft: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!/openapi\s*:\s*["']?3\.0/i.test(draft)) issues.push('缺少 openapi: 3.0.x 声明');
  if (!/^\s*info:/m.test(draft)) issues.push('缺少 info 段');
  if (!/^\s*paths:/m.test(draft)) issues.push('缺少 paths 段');
  if (!/^\s*[A-Za-z]+\s*:/m.test(draft)) issues.push('YAML 结构异常（缺少键值对）');
  return { ok: issues.length === 0, issues };
}

/**
 * 禁止技术后置校验：检测方案中是否出现记忆禁止的技术（FR-PIPE-07）。
 * 命中即返回清单，调用方据此触发"重新生成一次 + 告警"。
 */
export function findForbiddenTech(content: string, forbidden: readonly string[]): string[] {
  if (forbidden.length === 0) return [];
  const normalized = content.replace(/\r\n?/g, '\n');
  return forbidden.filter((item) => {
    const keyword = item.trim();
    if (keyword.length === 0) return false;
    // 大小写不敏感、允许中英文括号包裹
    return new RegExp(`[（(]?${escapeRegExp(keyword)}[)）]?`, 'i').test(normalized);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
