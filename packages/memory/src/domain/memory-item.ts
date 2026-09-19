import { z } from 'zod';
import { newUlid } from '@ec/data';
import type { MemoryItemRow } from '@ec/data';

import { ownershipWarnings, validateOwnership, MEMORY_SCOPES, type MemoryScope } from './scope';

/**
 * 五层记忆条目（FR-MEM-01 ~ FR-MEM-07，字段对齐 PRD §6.2 的 `memory_item`）。
 *
 * 领域模型用 camelCase，落库用 snake_case，二者由 `toRow` / `fromRow` 显式转换，
 * 避免把 SQL 细节（JSON 文本、BLOB、0/1）泄漏到业务代码里。
 */

/* ------------------------------ 枚举 ------------------------------ */

export const MEMORY_STATUSES = ['active', 'archived', 'superseded'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** 问题记忆的处置状态（FR-MEM-05：未解决 / 已解决 / 已规避） */
export const ISSUE_STATUSES = ['unsolved', 'solved', 'mitigated'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const MEMORY_SOURCE_TYPES = [
  'manual',
  'auto_chat',
  'auto_design',
  'doc_import',
  'ai_summary',
] as const;
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  unsolved: '未解决',
  solved: '已解决',
  mitigated: '已规避',
};

export const MEMORY_STATUS_LABELS: Record<MemoryStatus, string> = {
  active: '生效中',
  archived: '已归档',
  superseded: '已被取代',
};

/* ------------------------------ 领域类型 ------------------------------ */

export interface MemoryItem {
  id: string;
  userId: string;
  scope: MemoryScope;
  projectId: string | null;
  featureId: string | null;
  pageId: string | null;
  elementId: string | null;
  issueId: string | null;
  title: string;
  /** 正文（Markdown） */
  content: string;
  /** 结构化数据（逻辑结构摘要、流程、接口清单等） */
  structured: Record<string, unknown> | null;
  tags: string[];
  sourceType: MemorySourceType;
  /** 来源引用：对话 id / 文档 id + 段落 / commit sha */
  sourceRef: string | null;
  /** 0–1；自动写入为模型置信度，手动为 1.0 */
  confidence: number;
  /** 1–5 */
  importance: number;
  status: MemoryStatus;
  /** 仅 scope=issue 有效 */
  issueStatus: IssueStatus | null;
  pinned: boolean;
  /** 乐观锁版本 */
  version: number;
  createdAt: number;
  updatedAt: number;
  /** 向量（sqlite-vec），未生成时为 null */
  embedding: number[] | null;
}

export interface CreateMemoryInput {
  userId: string;
  scope: MemoryScope;
  title: string;
  projectId?: string | null;
  featureId?: string | null;
  pageId?: string | null;
  elementId?: string | null;
  issueId?: string | null;
  content?: string;
  structured?: Record<string, unknown> | null;
  tags?: string[];
  sourceType?: MemorySourceType;
  sourceRef?: string | null;
  confidence?: number;
  importance?: number;
  status?: MemoryStatus;
  issueStatus?: IssueStatus | null;
  pinned?: boolean;
  id?: string;
  createdAt?: number;
}

export class MemoryInvariantError extends Error {
  readonly violations: ReturnType<typeof validateOwnership>;

  constructor(message: string, violations: ReturnType<typeof validateOwnership> = []) {
    super(message);
    this.name = 'MemoryInvariantError';
    this.violations = violations;
    Object.setPrototypeOf(this, MemoryInvariantError.prototype);
  }
}

/* ------------------------------ zod ------------------------------ */

export const structuredSchema: z.ZodType<Record<string, unknown> | null> = z
  .record(z.unknown())
  .nullable();

export const memoryItemSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    scope: z.enum(MEMORY_SCOPES),
    projectId: z.string().nullable(),
    featureId: z.string().nullable(),
    pageId: z.string().nullable(),
    elementId: z.string().nullable(),
    issueId: z.string().nullable(),
    title: z.string().min(1),
    content: z.string(),
    structured: structuredSchema,
    tags: z.array(z.string()),
    sourceType: z.enum(MEMORY_SOURCE_TYPES),
    sourceRef: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    importance: z.number().int().min(1).max(5),
    status: z.enum(MEMORY_STATUSES),
    issueStatus: z.enum(ISSUE_STATUSES).nullable(),
    pinned: z.boolean(),
    version: z.number().int().min(1),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    embedding: z.array(z.number()).nullable(),
  })
  .superRefine((item, ctx) => {
    for (const violation of validateOwnership(item.scope, {
      project_id: item.projectId,
      feature_id: item.featureId,
      page_id: item.pageId,
      element_id: item.elementId,
      issue_id: item.issueId,
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [violation.field],
        message: violation.message,
      });
    }
    if (item.scope === 'issue' && item.issueStatus === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issueStatus'],
        message: '问题记忆必须带 issueStatus',
      });
    }
    if (item.scope !== 'issue' && item.issueStatus !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issueStatus'],
        message: '仅问题记忆可带 issueStatus',
      });
    }
  });

/** 严格校验：字段 + 归属不变量，失败抛 MemoryInvariantError */
export function assertMemoryInvariants(item: MemoryItem): void {
  const parsed = memoryItemSchema.safeParse(item);
  if (parsed.success) return;
  throw new MemoryInvariantError(
    `记忆条目不合法（${item.scope}）：${parsed.error.issues.map((issue) => issue.message).join('；')}`,
    validateOwnership(item.scope, {
      project_id: item.projectId,
      feature_id: item.featureId,
      page_id: item.pageId,
      element_id: item.elementId,
      issue_id: item.issueId,
    }),
  );
}

/** 宽松解析：仅做类型收口，不校验归属（用于读取历史/导入数据） */
export function parseMemoryItem(raw: unknown): MemoryItem {
  return memoryItemSchema.parse(raw);
}

/* ------------------------------ 状态机 ------------------------------ */

const MEMORY_TRANSITIONS: Record<MemoryStatus, readonly MemoryStatus[]> = {
  active: ['archived', 'superseded'],
  archived: ['active', 'superseded'],
  superseded: ['active'],
};

const ISSUE_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  unsolved: ['solved', 'mitigated'],
  solved: ['mitigated'],
  mitigated: ['solved'],
};

export class MemoryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryStateError';
    Object.setPrototypeOf(this, MemoryStateError.prototype);
  }
}

export function canTransitionStatus(from: MemoryStatus, to: MemoryStatus): boolean {
  return from === to || MEMORY_TRANSITIONS[from].includes(to);
}

export function canTransitionIssueStatus(from: IssueStatus, to: IssueStatus): boolean {
  return from === to || ISSUE_TRANSITIONS[from].includes(to);
}

/**
 * 校验状态流转合法性。
 * @param explicit 显式重开（solved/mitigated → unsolved）必须由调用方声明，
 *                 普通入口不得隐式把已解决的问题打回未解决。
 */
export function assertStatusTransition(
  from: MemoryStatus,
  to: MemoryStatus,
  options: { explicit?: boolean } = {},
): void {
  if (canTransitionStatus(from, to)) return;
  // 唯一需要显式声明的非法路径：superseded → archived 之外，其余均为硬拒绝
  if (options.explicit) return;
  throw new MemoryStateError(
    `非法状态流转：${MEMORY_STATUS_LABELS[from]} → ${MEMORY_STATUS_LABELS[to]}`,
  );
}

export function assertIssueStatusTransition(
  from: IssueStatus,
  to: IssueStatus,
  options: { explicit?: boolean } = {},
): void {
  if (canTransitionIssueStatus(from, to)) return;
  if (options.explicit) return;
  throw new MemoryStateError(
    `非法状态流转：${ISSUE_STATUS_LABELS[from]} → ${ISSUE_STATUS_LABELS[to]}（重开已解决的问题需显式调用 reopen）`,
  );
}

/* ------------------------------ 序列化 ------------------------------ */

export function parseStructured(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function serializeStructured(
  value: Record<string, unknown> | null | undefined,
): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((tag): tag is string => typeof tag === 'string');
  } catch {
    return [];
  }
}

export function serializeTags(tags: readonly string[] | undefined): string {
  return JSON.stringify([...new Set(tags ?? [])]);
}

export function blobToEmbedding(blob: Uint8Array | null | undefined): number[] | null {
  if (!blob || blob.byteLength === 0) return null;
  const buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return Array.from(new Float32Array(buffer));
}

export function embeddingToBlob(
  embedding: readonly number[] | null | undefined,
): Uint8Array | null {
  if (!embedding || embedding.length === 0) return null;
  return new Uint8Array(new Float32Array(embedding).buffer);
}

/* ------------------------------ 转换 ------------------------------ */

export function toRow(item: MemoryItem): MemoryItemRow {
  return {
    id: item.id,
    user_id: item.userId,
    scope: item.scope,
    project_id: item.projectId,
    feature_id: item.featureId,
    page_id: item.pageId,
    element_id: item.elementId,
    issue_id: item.issueId,
    title: item.title,
    content: item.content,
    structured: serializeStructured(item.structured),
    tags: serializeTags(item.tags),
    source_type: item.sourceType,
    source_ref: item.sourceRef,
    confidence: item.confidence,
    importance: item.importance,
    status: item.status,
    pinned: item.pinned ? 1 : 0,
    version: item.version,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    embedding: embeddingToBlob(item.embedding),
    issue_status: item.issueStatus,
  };
}

export function fromRow(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope,
    projectId: row.project_id,
    featureId: row.feature_id,
    pageId: row.page_id,
    elementId: row.element_id,
    issueId: row.issue_id,
    title: row.title,
    content: row.content,
    structured: parseStructured(row.structured),
    tags: parseTags(row.tags),
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    confidence: row.confidence,
    importance: row.importance,
    status: row.status,
    issueStatus: (row.issue_status ?? null) as IssueStatus | null,
    pinned: row.pinned === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    embedding: blobToEmbedding(row.embedding),
  };
}

/* ------------------------------ 工厂 ------------------------------ */

/** 按入参创建合法条目（不落库）；归属不合法直接抛错 */
export function createMemoryItem(input: CreateMemoryInput): MemoryItem {
  const now = input.createdAt ?? Date.now();
  const item: MemoryItem = {
    id: input.id ?? newUlid(now),
    userId: input.userId,
    scope: input.scope,
    projectId: input.projectId ?? null,
    featureId: input.featureId ?? null,
    pageId: input.pageId ?? null,
    elementId: input.elementId ?? null,
    issueId: input.issueId ?? null,
    title: input.title.trim(),
    content: input.content ?? '',
    structured: input.structured ?? null,
    tags: [...new Set(input.tags ?? [])],
    sourceType: input.sourceType ?? 'manual',
    sourceRef: input.sourceRef ?? null,
    // 手动写入默认为满置信度（FR-MEM-07 / PRD §6.2）
    confidence: clamp01(
      input.confidence ?? (input.sourceType && input.sourceType !== 'manual' ? 0.6 : 1),
    ),
    importance: clampImportance(input.importance ?? 3),
    status: input.status ?? 'active',
    issueStatus: input.scope === 'issue' ? (input.issueStatus ?? 'unsolved') : null,
    pinned: input.pinned ?? false,
    version: 1,
    createdAt: now,
    updatedAt: now,
    embedding: null,
  };
  assertMemoryInvariants(item);
  return item;
}

export function describeMemoryWarnings(
  item: Pick<MemoryItem, 'scope' | 'projectId' | 'featureId' | 'pageId' | 'elementId' | 'issueId'>,
): string[] {
  return ownershipWarnings(item.scope, {
    project_id: item.projectId,
    feature_id: item.featureId,
    page_id: item.pageId,
    element_id: item.elementId,
    issue_id: item.issueId,
  });
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clampImportance(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.round(value)));
}

/**
 * 标题归一化键：用于判定"同一条记忆"（冲突检测与覆盖关系）。
 * 去掉空白与常见中英标点、统一小写，使"命名规范！"与"命名规范"命中同一个键。
 */
export function normalizeTitleKey(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@[-`{-~！-～、。，；：？！""''（）【】《》]/g, '');
}
