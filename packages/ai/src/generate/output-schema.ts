import { z } from 'zod';

import { anchorDeclarationSchema, type AnchorDeclaration } from '../anchors/anchor-model';

/**
 * 结构化输出契约（T4-04 要点 1 / FR-AI-05）。
 *
 * 模型必须按这份契约返回 JSON：文件清单 + 锚点声明 + 变更说明 + 决策说明。
 * 契约文本会**前置**写进系统提示词（§13.2：角色与输出契约前置），
 * 解析器（parser.ts）也按同一份 zod schema 收口 —— 契约与校验永远同源。
 */

/* ------------------------------ 类型 ------------------------------ */

export const FILE_ACTIONS = ['create', 'patch', 'delete'] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

export const FILE_ACTION_LABELS: Record<FileAction, string> = {
  create: '新建文件',
  patch: '增量补丁',
  delete: '删除文件',
};

export interface GeneratedFile {
  /** 工作区相对路径（正斜杠） */
  path: string;
  /** create/patch 时为完整内容或补丁文本；delete 时为空串 */
  content: string;
  action: FileAction;
  /** 语言标记（用于语法高亮与注释风格选择） */
  language: string;
}

export interface ReferencedMemory {
  id: string;
  title: string;
  /** 记忆层级（长期 / 项目 / 功能 / 页面 / 问题） */
  layer: string;
}

/** 决策说明（NFR-U-02：引用记忆 / 选型理由 / 风险 / 未覆盖点 四要素 100% 覆盖） */
export interface GenerationDecision {
  referencedMemory: ReferencedMemory[];
  rationale: string;
  risks: string[];
  uncovered: string[];
}

/** 生成结果（唯一结构化出口） */
export interface GenerationOutput {
  files: GeneratedFile[];
  anchors: AnchorDeclaration[];
  /** 变更说明（面向人，可直接展示在结果页顶部） */
  summary: string;
  /** 附加说明（注意事项、后续步骤等） */
  notes: string;
  decision: GenerationDecision;
}

/* ------------------------------ zod ------------------------------ */

const pathSchema = z
  .string()
  .min(1)
  // 拒绝绝对路径与向上越界：生成物只能落在项目工作区内（NFR-S-05）
  .refine((value) => !/^([a-zA-Z]:|[\\/])/.test(value), { message: '文件路径必须是工作区相对路径' })
  .refine((value) => !value.split(/[\\/]/).includes('..'), {
    message: '文件路径不得越出工作区（禁止 ..）',
  });

/**
 * 注意两个坑：
 * 1. 这些 schema 带 `.default()`，**输入**类型与输出类型不同（输入允许缺字段，输出必填）。
 *    这里统一把第三个类型参数声明为 `unknown`，既保留输出侧的精确类型，
 *    又不让 zod 的输入类型把调用方逼到 `as` 上。
 * 2. 因为有 `.default()`，空对象 `{}` 也能通过校验 —— 而模型输出里到处都是空对象字面量
 *    （代码块里的 `class A {}`）。因此追加 refine：必须至少有一项实质内容，
 *    否则 `{}` 会被误判为"解析成功"，把真正的代码块挡在降级路径之外。
 */
export const generatedFileSchema: z.ZodType<GeneratedFile, z.ZodTypeDef, unknown> = z.object({
  path: pathSchema,
  content: z.string(),
  action: z.enum(FILE_ACTIONS),
  language: z.string().default('ts'),
});

export const referencedMemorySchema: z.ZodType<ReferencedMemory, z.ZodTypeDef, unknown> = z.object({
  id: z.string().min(1),
  title: z.string(),
  layer: z.string(),
});

export const generationDecisionSchema: z.ZodType<GenerationDecision, z.ZodTypeDef, unknown> =
  z.object({
    referencedMemory: z.array(referencedMemorySchema).default([]),
    rationale: z.string().default(''),
    risks: z.array(z.string()).default([]),
    uncovered: z.array(z.string()).default([]),
  });

export const generationOutputSchema: z.ZodType<GenerationOutput, z.ZodTypeDef, unknown> = z
  .object({
    files: z.array(generatedFileSchema).default([]),
    anchors: z.array(anchorDeclarationSchema).default([]),
    summary: z.string().default(''),
    notes: z.string().default(''),
    decision: generationDecisionSchema.default({
      referencedMemory: [],
      rationale: '',
      risks: [],
      uncovered: [],
    }),
  })
  .refine(
    (value) =>
      value.files.length > 0 ||
      value.anchors.length > 0 ||
      value.summary.trim().length > 0 ||
      value.notes.trim().length > 0,
    { message: '缺少实质内容：files / anchors / summary / notes 至少要有一项' },
  );

/** 宽容解析：缺省字段补默认值，便于把"半成品"响应也纳入统计 */
export function parseGenerationOutput(raw: unknown): GenerationOutput | null {
  const parsed = generationOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 严格解析：任何不合契约的地方都返回 issue 明细（解析失败重试时反馈给模型） */
export function validateGenerationOutput(
  raw: unknown,
): { ok: true; value: GenerationOutput } | { ok: false; issues: string[] } {
  const parsed = generationOutputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}

/* ------------------------------ 契约文本 ------------------------------ */

/** 输出契约的硬性要求：三条是每个模板都必须出现的最小集 */
export const OUTPUT_CONTRACT_HARD_RULES: readonly string[] = [
  '禁止臆造接口：只能调用上下文中出现过的接口、字段与方法；不确定时必须在 decision.uncovered 中列出，而不是编造。',
  '必须输出 anchors 声明：每个新增或修改的关键符号（controller/service/dto/repo/sql/test/route）都要在 anchors 中声明 elementId、filePath、symbol 与 kind。',
  '必须给出变更说明 + 风险 + 未覆盖点：summary、decision.risks、decision.uncovered 三者缺一不可，不得写"无"。',
];

/** 供提示词直接引用的 JSON Schema 描述（结构等价于 generationOutputSchema） */
export const OUTPUT_CONTRACT_DESCRIPTION = `{
  "files": [{ "path": "相对工作区路径", "content": "文件全文或补丁文本", "action": "create|patch|delete", "language": "ts|py|java|arkts|sql|..." }],
  "anchors": [{ "elementId": "元素 id", "filePath": "同上", "symbol": "类.方法 或 函数名", "kind": "controller|service|dto|repo|sql|test|route", "startLine": 12, "endLine": 40 }],
  "summary": "本次变更说明（面向人）",
  "notes": "附加说明",
  "decision": {
    "referencedMemory": [{ "id": "记忆 id", "title": "标题", "layer": "longterm|project|feature|page|issue" }],
    "rationale": "为什么这样实现 / 这样选型",
    "risks": ["潜在风险"],
    "uncovered": ["尚未覆盖或存疑的点"]
  }
}`;

export const OUTPUT_CONTRACT_TEXT = [
  '## 输出契约（必须严格遵守）',
  '只输出一个 JSON 对象，不要包裹解释性文字；如需说明请写进 summary / notes / decision 字段。',
  '结构如下：',
  OUTPUT_CONTRACT_DESCRIPTION,
  '',
  '硬性要求：',
  ...OUTPUT_CONTRACT_HARD_RULES.map((rule, index) => `${index + 1}. ${rule}`),
].join('\n');

/** 解析失败时的降级提示（重试时反馈给模型） */
export function buildParseFeedback(issues: readonly string[], previousText: string): string {
  const head = previousText.length > 600 ? `${previousText.slice(0, 600)}…` : previousText;
  return [
    '上一次的输出不符合输出契约，解析失败。',
    '问题明细：',
    ...issues.map((issue) => `- ${issue}`),
    '',
    '请重新输出**完整且合法**的 JSON 对象（不要只输出差异部分，不要包 Markdown 代码围栏）。',
    `上次输出开头如下（供你对照）：\n${head}`,
  ].join('\n');
}
