import { z } from 'zod';

/**
 * Code Anchor 领域模型（T4-06）。
 *
 * 字段严格对齐 PRD §6.2 的 `code_anchor` 表：
 * `id / project_id / element_id / page_id / feature_id / file_path / symbol /
 *  start_line / end_line / kind / commit_sha`。
 *
 * 领域对象用 camelCase，落库用 snake_case（与 @ec/memory 的 MemoryItem ↔ Row 同一约定），
 * 由 `toCodeAnchorRow` / `fromCodeAnchorRow` 显式转换。
 *
 * 本文件被 T4-04 的输出契约（锚点声明）与 T4-05 的写入管线共同依赖，
 * 因此放在 anchors/ 下而不是 generate/ 下，避免 T4-04 反向依赖 T4-06 的其余实现。
 */

/** 锚点种类（PRD §6.2 的 kind 枚举） */
export const ANCHOR_KINDS = [
  'controller',
  'service',
  'dto',
  'repo',
  'sql',
  'test',
  'route',
] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export const ANCHOR_KIND_LABELS: Record<AnchorKind, string> = {
  controller: '控制器',
  service: '服务',
  dto: '数据传输对象',
  repo: '数据访问',
  sql: '数据库脚本',
  test: '单元测试',
  route: '路由',
};

export const ANCHOR_SYNC_STATES = ['synced', 'drift_detected', 'missing'] as const;
export type AnchorSyncState = (typeof ANCHOR_SYNC_STATES)[number];

export const ANCHOR_SYNC_LABELS: Record<AnchorSyncState, string> = {
  synced: '已同步',
  drift_detected: '位置漂移',
  missing: '锚点丢失',
};

/** 三重锚定的达成情况（T4-06 要点 2） */
export interface AnchorEvidence {
  /** ① AI 生成输出中的 anchors 声明 */
  declared: boolean;
  /** ② 代码注释标记 `// @everyonecoding:anchor <elementId>` */
  commentMarker: boolean;
  /** ③ AST 解析校验通过 */
  astVerified: boolean;
}

export interface CodeAnchor {
  id: string;
  projectId: string;
  elementId: string | null;
  pageId: string | null;
  featureId: string | null;
  filePath: string;
  symbol: string | null;
  startLine: number | null;
  endLine: number | null;
  kind: AnchorKind;
  commitSha: string | null;
  syncState: AnchorSyncState;
  /** 不一致原因 / 漂移说明（面板展示） */
  syncDetail: string | null;
  evidence: AnchorEvidence;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAnchorInput {
  projectId: string;
  filePath: string;
  kind: AnchorKind;
  symbol?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  elementId?: string | null;
  pageId?: string | null;
  featureId?: string | null;
  commitSha?: string | null;
  id?: string;
  now?: number;
}

/* ------------------------------ zod ------------------------------ */

export const anchorKindSchema = z.enum(ANCHOR_KINDS);

export const codeAnchorSchema: z.ZodType<CodeAnchor> = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  elementId: z.string().nullable(),
  pageId: z.string().nullable(),
  featureId: z.string().nullable(),
  filePath: z.string().min(1),
  symbol: z.string().nullable(),
  startLine: z.number().int().min(1).nullable(),
  endLine: z.number().int().min(1).nullable(),
  kind: anchorKindSchema,
  commitSha: z.string().nullable(),
  syncState: z.enum(ANCHOR_SYNC_STATES),
  syncDetail: z.string().nullable(),
  evidence: z.object({
    declared: z.boolean(),
    commentMarker: z.boolean(),
    astVerified: z.boolean(),
  }),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

/** AI 生成输出里的锚点声明（T4-04 的 anchors 字段） */
export const anchorDeclarationSchema = z.object({
  elementId: z.string().min(1),
  filePath: z.string().min(1),
  symbol: z.string().min(1),
  kind: anchorKindSchema,
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

export type AnchorDeclaration = z.infer<typeof anchorDeclarationSchema>;

export class AnchorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnchorValidationError';
    Object.setPrototypeOf(this, AnchorValidationError.prototype);
  }
}

export function assertAnchorValid(anchor: CodeAnchor): void {
  const parsed = codeAnchorSchema.safeParse(anchor);
  if (parsed.success) return;
  throw new AnchorValidationError(
    `锚点不合法：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`,
  );
}

/* ------------------------------ 序列化 ------------------------------ */

/** 与 PRD §6.2 `code_anchor` 表逐字段对齐的落库行 */
export interface CodeAnchorRow {
  id: string;
  project_id: string;
  element_id: string | null;
  page_id: string | null;
  feature_id: string | null;
  file_path: string;
  symbol: string | null;
  start_line: number | null;
  end_line: number | null;
  kind: AnchorKind;
  commit_sha: string | null;
  created_at: number;
  updated_at: number;
}

export function toCodeAnchorRow(anchor: CodeAnchor): CodeAnchorRow {
  return {
    id: anchor.id,
    project_id: anchor.projectId,
    element_id: anchor.elementId,
    page_id: anchor.pageId,
    feature_id: anchor.featureId,
    file_path: anchor.filePath,
    symbol: anchor.symbol,
    start_line: anchor.startLine,
    end_line: anchor.endLine,
    kind: anchor.kind,
    commit_sha: anchor.commitSha,
    created_at: anchor.createdAt,
    updated_at: anchor.updatedAt,
  };
}

export function fromCodeAnchorRow(row: CodeAnchorRow): CodeAnchor {
  return {
    id: row.id,
    projectId: row.project_id,
    elementId: row.element_id,
    pageId: row.page_id,
    featureId: row.feature_id,
    filePath: row.file_path,
    symbol: row.symbol,
    startLine: row.start_line,
    endLine: row.end_line,
    kind: row.kind,
    commitSha: row.commit_sha,
    // 落库不保存校验态：回读时按"待校验"处理，由 T4-06 的校验流程重新判定
    syncState: 'synced',
    syncDetail: null,
    evidence: { declared: true, commentMarker: false, astVerified: false },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------ 工厂 ------------------------------ */

export function createCodeAnchor(input: CreateAnchorInput): CodeAnchor {
  const now = input.now ?? Date.now();
  const anchor: CodeAnchor = {
    id: input.id ?? `anc-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: input.projectId,
    elementId: input.elementId ?? null,
    pageId: input.pageId ?? null,
    featureId: input.featureId ?? null,
    filePath: input.filePath,
    symbol: input.symbol ?? null,
    startLine: input.startLine ?? null,
    endLine: input.endLine ?? null,
    kind: input.kind,
    commitSha: input.commitSha ?? null,
    syncState: 'synced',
    syncDetail: null,
    evidence: { declared: true, commentMarker: false, astVerified: false },
    createdAt: now,
    updatedAt: now,
  };
  assertAnchorValid(anchor);
  return anchor;
}
