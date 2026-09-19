import { z } from 'zod';

import type { NoteKind as LegacyNoteKind } from '../dsl/types';

/**
 * 备注与批注领域模型（T4-01 / FR-ANN-01 ~ FR-ANN-07）。
 *
 * 三级备注：元素级 / 页面级 / 功能级；六种类型；富文本 JSON + checkbox 清单 + 代码片段。
 *
 * 设计约束：
 * - 本文件**只放类型与纯函数**，不引入 React 与任何 IO，可在 node 环境直接测试；
 * - 「禁止事项」是硬约束：`mustFollow = true`，优先级强制为 5 且**不允许人工下调**，
 *   上下文组装（T4-02）与代码生成（T4-04）据此把强约束句式前置；
 * - 与设计器 DSL 的 `PageNote`（Wave 3 的简化结构）保持可双向转换，
 *   转换函数放在本文件末尾，避免两套模型各自漂移。
 */

/* ------------------------------ 枚举 ------------------------------ */

/** 备注挂载目标（三级） */
export const NOTE_TARGET_TYPES = ['element', 'page', 'feature'] as const;
export type NoteTargetType = (typeof NOTE_TARGET_TYPES)[number];

export const NOTE_TARGET_LABELS: Record<NoteTargetType, string> = {
  element: '元素备注',
  page: '页面备注',
  feature: '功能备注',
};

/** 六类备注（颜色区分，禁止事项红色并自动提升优先级） */
export const NOTE_TYPES = [
  'business_rule',
  'validation',
  'interaction',
  'todo',
  'question',
  'forbidden',
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const NOTE_STATUSES = ['open', 'resolved'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export interface NoteTypeMeta {
  label: string;
  /** 角标 / 卡片主色（浅色主题下对比度均 ≥ 4.5:1） */
  color: string;
  /** 浅色底（角标背景） */
  background: string;
  /** 未人工干预时的基础优先级（1–5） */
  basePriority: number;
  /** 是否硬约束（禁止事项）：优先级锁死为 5 且上下文置顶 */
  mustFollow: boolean;
}

export const NOTE_TYPE_META: Record<NoteType, NoteTypeMeta> = {
  business_rule: {
    label: '业务规则',
    color: '#2563eb',
    background: '#dbeafe',
    basePriority: 4,
    mustFollow: false,
  },
  validation: {
    label: '校验要求',
    color: '#0e7490',
    background: '#cffafe',
    basePriority: 4,
    mustFollow: false,
  },
  interaction: {
    label: '交互说明',
    color: '#7c3aed',
    background: '#ede9fe',
    basePriority: 3,
    mustFollow: false,
  },
  todo: {
    label: '待办',
    color: '#b45309',
    background: '#fef3c7',
    basePriority: 2,
    mustFollow: false,
  },
  question: {
    label: '疑问',
    color: '#475569',
    background: '#e2e8f0',
    basePriority: 2,
    mustFollow: false,
  },
  forbidden: {
    label: '禁止事项',
    color: '#dc2626',
    background: '#fee2e2',
    basePriority: 5,
    mustFollow: true,
  },
};

/** 硬约束备注（禁止事项）—— 上下文组装时的强约束句式前缀 */
export const HARD_CONSTRAINT_PREFIX = '【禁止】';

/* --------------------------- 富文本结构 --------------------------- */

export const INLINE_MARKS = ['bold', 'italic', 'code', 'strike'] as const;
export type InlineMark = (typeof INLINE_MARKS)[number];

/** 行内片段：同一段文字上的若干标记 */
export interface TextSpan {
  text: string;
  marks: InlineMark[];
}

export type RichTextBlock =
  | { type: 'paragraph'; spans: TextSpan[] }
  | { type: 'heading'; level: 1 | 2 | 3; spans: TextSpan[] }
  | { type: 'bullet-list'; items: TextSpan[][] }
  | { type: 'ordered-list'; items: TextSpan[][] };

export interface RichTextDocument {
  type: 'doc';
  blocks: RichTextBlock[];
}

export interface NoteChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface NoteCodeBlock {
  id: string;
  /** 语言标记（渲染高亮与注释风格选择用） */
  language: string;
  code: string;
}

/* ------------------------------ 实体 ------------------------------ */

/** 备注的一次修改留痕（FR-ANN-07 变更留痕） */
export interface NoteRevision {
  version: number;
  /** 本次修改后的标题 / 类型 / 状态 */
  title: string;
  type: NoteType;
  status: NoteStatus;
  content: RichTextDocument;
  checklists: NoteChecklistItem[];
  codeBlocks: NoteCodeBlock[];
  /** 相对上一版的字段级变更摘要，如 ['content', 'checklists'] */
  changedFields: string[];
  /** 变更人（AI 或用户标识） */
  editor: string;
  createdAt: number;
}

export interface Note {
  id: string;
  projectId: string;
  targetType: NoteTargetType;
  /** 目标 id（元素 id / 页面 id / 功能 id） */
  targetId: string;
  /** 备注类型（六选一） */
  type: NoteType;
  title: string;
  content: RichTextDocument;
  checklists: NoteChecklistItem[];
  codeBlocks: NoteCodeBlock[];
  status: NoteStatus;
  /** 生效优先级 1–5（由类型基础优先级与人工调整共同决定；禁止事项恒为 5） */
  priority: number;
  /** 人工指定的优先级（禁止事项下不生效） */
  manualPriority: number | null;
  /** 乐观锁版本号，每次修改 +1 */
  version: number;
  /** 首次创建时间 */
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  createdBy: string;
  /** 历史版本（不含当前版本），按 version 升序 */
  history: NoteRevision[];
}

export interface CreateNoteInput {
  projectId: string;
  targetType: NoteTargetType;
  targetId: string;
  type?: NoteType;
  title?: string;
  content?: RichTextDocument;
  /** 纯文本快捷入口（自动切成段落块） */
  text?: string;
  checklists?: NoteChecklistItem[];
  codeBlocks?: NoteCodeBlock[];
  manualPriority?: number | null;
  createdBy?: string;
  id?: string;
  createdAt?: number;
}

export interface UpdateNoteInput {
  type?: NoteType;
  title?: string;
  content?: RichTextDocument;
  checklists?: NoteChecklistItem[];
  codeBlocks?: NoteCodeBlock[];
  manualPriority?: number | null;
  status?: NoteStatus;
}

export interface NoteFilter {
  projectId?: string;
  targetType?: NoteTargetType | readonly NoteTargetType[];
  targetId?: string;
  type?: NoteType | readonly NoteType[];
  status?: NoteStatus | readonly NoteStatus[];
  /** 标题 / 正文 / 清单纯文本的关键字过滤 */
  text?: string;
}

/** 上下文注入用的备注视图（T4-02 消费） */
export interface ContextNote {
  id: string;
  targetType: NoteTargetType;
  targetId: string;
  type: NoteType;
  typeLabel: string;
  /** 硬约束（禁止事项）—— 生成时必须用强约束句式 */
  mustFollow: boolean;
  priority: number;
  /** 展平后的纯文本（含标题、正文、清单、代码片段） */
  text: string;
  title: string;
  checklists: NoteChecklistItem[];
  codeBlocks: NoteCodeBlock[];
  version: number;
  updatedAt: number;
}

/** 上下文目标：给出元素即可自动带上其所属页面与功能 */
export interface NoteContextTarget {
  projectId: string;
  elementId?: string | null;
  pageId?: string | null;
  featureId?: string | null;
}

/* ------------------------------ zod ------------------------------ */

const inlineMarkSchema = z.enum(INLINE_MARKS);

const textSpanSchema: z.ZodType<TextSpan> = z.object({
  text: z.string(),
  marks: z.array(inlineMarkSchema),
});

const richTextBlockSchema: z.ZodType<RichTextBlock> = z.union([
  z.object({ type: z.literal('paragraph'), spans: z.array(textSpanSchema) }),
  z.object({
    type: z.literal('heading'),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    spans: z.array(textSpanSchema),
  }),
  z.object({ type: z.literal('bullet-list'), items: z.array(z.array(textSpanSchema)) }),
  z.object({ type: z.literal('ordered-list'), items: z.array(z.array(textSpanSchema)) }),
]);

export const richTextDocumentSchema: z.ZodType<RichTextDocument> = z.object({
  type: z.literal('doc'),
  blocks: z.array(richTextBlockSchema),
});

export const checklistItemSchema: z.ZodType<NoteChecklistItem> = z.object({
  id: z.string().min(1),
  text: z.string(),
  checked: z.boolean(),
});

export const codeBlockSchema: z.ZodType<NoteCodeBlock> = z.object({
  id: z.string().min(1),
  language: z.string(),
  code: z.string(),
});

const noteRevisionSchema: z.ZodType<NoteRevision> = z.object({
  version: z.number().int().min(1),
  title: z.string(),
  type: z.enum(NOTE_TYPES),
  status: z.enum(NOTE_STATUSES),
  content: richTextDocumentSchema,
  checklists: z.array(checklistItemSchema),
  codeBlocks: z.array(codeBlockSchema),
  changedFields: z.array(z.string()),
  editor: z.string(),
  createdAt: z.number().int(),
});

export const noteSchema: z.ZodType<Note> = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  targetType: z.enum(NOTE_TARGET_TYPES),
  targetId: z.string().min(1),
  type: z.enum(NOTE_TYPES),
  title: z.string(),
  content: richTextDocumentSchema,
  checklists: z.array(checklistItemSchema),
  codeBlocks: z.array(codeBlockSchema),
  status: z.enum(NOTE_STATUSES),
  priority: z.number().int().min(1).max(5),
  manualPriority: z.number().int().min(1).max(5).nullable(),
  version: z.number().int().min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  resolvedAt: z.number().int().nullable(),
  createdBy: z.string(),
  history: z.array(noteRevisionSchema),
});

export class NoteValidationError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'NoteValidationError';
    this.issues = issues;
  }
}

/** 严格校验：schema 不通过直接抛错（写入口统一调用） */
export function assertNoteValid(note: Note): void {
  const parsed = noteSchema.safeParse(note);
  if (parsed.success) return;
  throw new NoteValidationError(
    `备注不合法：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`,
    parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  );
}

/** 宽松解析（读历史 / 导入数据） */
export function parseNote(raw: unknown): Note {
  return noteSchema.parse(raw);
}

/* ---------------------------- 富文本纯函数 ---------------------------- */

export function emptyDocument(): RichTextDocument {
  return { type: 'doc', blocks: [{ type: 'paragraph', spans: [] }] };
}

export function plainSpan(text: string): TextSpan {
  return { text, marks: [] };
}

export function spansToText(spans: readonly TextSpan[]): string {
  return spans.map((span) => span.text).join('');
}

export function textToSpans(text: string): TextSpan[] {
  return text.length === 0 ? [] : [plainSpan(text)];
}

/** 纯文本 → 文档：空行分段；`- ` / `1. ` 前缀识别为清单 */
export function documentFromText(text: string): RichTextDocument {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: RichTextBlock[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', spans: textToSpans(paragraph.join('\n')) });
    paragraph = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flush();
      const previous = blocks.at(-1);
      const item = textToSpans(bullet[1] ?? '');
      if (previous !== undefined && previous.type === 'bullet-list') previous.items.push(item);
      else blocks.push({ type: 'bullet-list', items: [item] });
      continue;
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      flush();
      const previous = blocks.at(-1);
      const item = textToSpans(ordered[1] ?? '');
      if (previous !== undefined && previous.type === 'ordered-list') previous.items.push(item);
      else blocks.push({ type: 'ordered-list', items: [item] });
      continue;
    }
    paragraph.push(line);
  }
  flush();

  return { type: 'doc', blocks: blocks.length > 0 ? blocks : [{ type: 'paragraph', spans: [] }] };
}

/** 文档 → 纯文本（清单加前缀，便于搜索与上下文注入） */
export function documentToText(doc: RichTextDocument): string {
  return doc.blocks
    .map((block) => {
      switch (block.type) {
        case 'paragraph':
          return spansToText(block.spans);
        case 'heading':
          return `${'#'.repeat(block.level)} ${spansToText(block.spans)}`;
        case 'bullet-list':
          return block.items.map((item) => `- ${spansToText(item)}`).join('\n');
        case 'ordered-list':
          return block.items.map((item, index) => `${index + 1}. ${spansToText(item)}`).join('\n');
        default:
          return '';
      }
    })
    .filter((line) => line.length > 0)
    .join('\n\n');
}

/**
 * 在行内片段上切换标记（加粗 / 斜体 / 行内代码 / 删除线）。
 *
 * 语义：先把 `[start, end)` 切出来，若该区间**每一段都带此标记**则移除，否则整体加上。
 * 空区间直接原样返回（避免产生空片段）。
 */
export function toggleMarkInSpans(
  spans: readonly TextSpan[],
  start: number,
  end: number,
  mark: InlineMark,
): TextSpan[] {
  if (end <= start) return spans.map((span) => ({ text: span.text, marks: [...span.marks] }));

  type Slice = { text: string; marks: InlineMark[]; inRange: boolean };
  const slices: Slice[] = [];
  let cursor = 0;
  for (const span of spans) {
    const spanStart = cursor;
    const spanEnd = cursor + span.text.length;
    cursor = spanEnd;
    if (spanEnd <= start || spanStart >= end) {
      slices.push({ text: span.text, marks: [...span.marks], inRange: false });
      continue;
    }
    const localStart = Math.max(0, start - spanStart);
    const localEnd = Math.min(span.text.length, end - spanStart);
    const head = span.text.slice(0, localStart);
    const middle = span.text.slice(localStart, localEnd);
    const tail = span.text.slice(localEnd);
    if (head.length > 0) slices.push({ text: head, marks: [...span.marks], inRange: false });
    if (middle.length > 0) slices.push({ text: middle, marks: [...span.marks], inRange: true });
    if (tail.length > 0) slices.push({ text: tail, marks: [...span.marks], inRange: false });
  }

  const targets = slices.filter((slice) => slice.inRange);
  const allMarked = targets.length > 0 && targets.every((slice) => slice.marks.includes(mark));

  const merged: TextSpan[] = [];
  for (const slice of slices) {
    const marks = slice.inRange
      ? allMarked
        ? slice.marks.filter((item) => item !== mark)
        : slice.marks.includes(mark)
          ? slice.marks
          : [...slice.marks, mark]
      : slice.marks;
    const previous = merged.at(-1);
    if (previous !== undefined && sameMarks(previous.marks, marks)) previous.text += slice.text;
    else merged.push({ text: slice.text, marks });
  }
  return merged;
}

function sameMarks(a: readonly InlineMark[], b: readonly InlineMark[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((mark, index) => mark === sortedB[index]);
}

/** 插入清单项 / 代码片段时生成稳定 id（注入 idFactory 便于测试） */
export function defaultIdFactory(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${counter}`;
  };
}

/* ---------------------------- 优先级与排序 ---------------------------- */

export function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.round(value)));
}

/**
 * 计算生效优先级。
 * 禁止事项（mustFollow）恒为 5，人工下调无效 —— 这是硬约束，不是 UI 偏好。
 */
export function computeNotePriority(type: NoteType, manualPriority: number | null = null): number {
  const meta = NOTE_TYPE_META[type];
  if (meta.mustFollow) return 5;
  return clampPriority(manualPriority ?? meta.basePriority);
}

/**
 * 上下文排序（FR-ANN-06 / T4-02 要点 4）：禁止事项置顶，
 * 随后按优先级降序、更新时间降序、id 升序（稳定排序）。
 */
export function sortNotesForContext<
  T extends { type: NoteType; priority: number; updatedAt: number; id: string },
>(notes: readonly T[]): T[] {
  return [...notes].sort((a, b) => {
    const hardA = NOTE_TYPE_META[a.type].mustFollow ? 1 : 0;
    const hardB = NOTE_TYPE_META[b.type].mustFollow ? 1 : 0;
    if (hardA !== hardB) return hardB - hardA;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 备注 → 上下文视图（展平纯文本，供 T4-02 直接注入提示词） */
export function toContextNote(note: Note): ContextNote {
  const meta = NOTE_TYPE_META[note.type];
  const parts: string[] = [];
  if (note.title.trim().length > 0) parts.push(note.title.trim());
  const body = documentToText(note.content);
  if (body.length > 0) parts.push(body);
  if (note.checklists.length > 0) {
    parts.push(
      note.checklists.map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`).join('\n'),
    );
  }
  for (const block of note.codeBlocks) {
    parts.push(`\`\`\`${block.language}\n${block.code}\n\`\`\``);
  }
  const text = parts.join('\n');
  return {
    id: note.id,
    targetType: note.targetType,
    targetId: note.targetId,
    type: note.type,
    typeLabel: meta.label,
    mustFollow: meta.mustFollow,
    priority: note.priority,
    text: meta.mustFollow ? `${HARD_CONSTRAINT_PREFIX}${text}` : text,
    title: note.title,
    checklists: note.checklists.map((item) => ({ ...item })),
    codeBlocks: note.codeBlocks.map((block) => ({ ...block })),
    version: note.version,
    updatedAt: note.updatedAt,
  };
}

/** 过滤匹配 */
export function noteMatchesFilter(note: Note, filter: NoteFilter): boolean {
  if (filter.projectId !== undefined && note.projectId !== filter.projectId) return false;
  if (filter.targetId !== undefined && note.targetId !== filter.targetId) return false;
  if (filter.targetType !== undefined && !matchOneOf(note.targetType, filter.targetType))
    return false;
  if (filter.type !== undefined && !matchOneOf(note.type, filter.type)) return false;
  if (filter.status !== undefined && !matchOneOf(note.status, filter.status)) return false;
  if (filter.text !== undefined && filter.text.trim().length > 0) {
    const needle = filter.text.trim().toLowerCase();
    const haystack = [
      note.title,
      documentToText(note.content),
      ...note.checklists.map((item) => item.text),
      ...note.codeBlocks.map((block) => block.code),
    ]
      .join('\n')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function matchOneOf<T>(value: T, expected: T | readonly T[]): boolean {
  return Array.isArray(expected) ? (expected as readonly T[]).includes(value) : expected === value;
}

/* --------------------- 与设计器 DSL PageNote 的互转 --------------------- */

/** 新六类 → DSL 旧四类（DSL 仅承载，语义以本模块为准） */
export function toLegacyNoteKind(type: NoteType): LegacyNoteKind {
  switch (type) {
    case 'todo':
      return 'todo';
    case 'question':
      return 'question';
    case 'forbidden':
      return 'issue';
    default:
      return 'idea';
  }
}

/** DSL 旧四类 → 新六类（导入历史数据时的无损近似） */
export function fromLegacyNoteKind(kind: LegacyNoteKind): NoteType {
  switch (kind) {
    case 'todo':
      return 'todo';
    case 'question':
      return 'question';
    case 'issue':
      return 'forbidden';
    default:
      return 'interaction';
  }
}
