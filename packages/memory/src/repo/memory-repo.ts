import type { Database } from 'better-sqlite3';
import {
  ConflictError,
  Repository,
  newUlid,
  type MemoryChangeLogRow,
  type MemoryItemRow,
  type MemoryStructRevisionRow,
  type Row,
} from '@ec/data';

import {
  assertIssueStatusTransition,
  assertMemoryInvariants,
  assertStatusTransition,
  createMemoryItem,
  fromRow,
  MemoryInvariantError,
  normalizeTitleKey,
  toRow,
  type CreateMemoryInput,
  type IssueStatus,
  type MemoryItem,
  type MemoryStatus,
} from '../domain/memory-item';
import {
  resolveInheritance,
  type ResolveContextRef,
  type ResolvedContext,
} from '../domain/inheritance';
import {
  LAYER_ORDER,
  layerOf,
  ownershipKeyOf,
  validateOwnership,
  type MemoryLayer,
  type MemoryOwnership,
  type MemoryScope,
} from '../domain/scope';

/**
 * 记忆仓库：五层记忆的唯一读写入口（FR-MEM-01 ~ FR-MEM-07）。
 *
 * 约定：
 * - 对外只暴露领域对象（camelCase），行映射由 domain 层完成；
 * - 所有更新走 `version` 乐观锁，冲突抛 @ec/data 的 `ConflictError`；
 * - 状态流转在仓库层强制校验，绕过状态机的写入不可能发生。
 */

export type MemoryOrderBy = 'importance' | 'updatedAt' | 'createdAt' | 'title';

export interface MemoryListQuery {
  userId?: string;
  scopes?: readonly MemoryScope[];
  /** 解析层级过滤（element = page + element_id 非空） */
  layers?: readonly MemoryLayer[];
  /** undefined 表示不过滤；null 表示筛选"该列为 NULL" */
  projectId?: string | null;
  featureId?: string | null;
  pageId?: string | null;
  elementId?: string | null;
  issueId?: string | null;
  status?: MemoryStatus | readonly MemoryStatus[];
  issueStatus?: IssueStatus;
  /** 全部命中（AND 语义） */
  tags?: readonly string[];
  pinned?: boolean;
  minImportance?: number;
  /** 本地兜底过滤：标题 / 正文 / 标签包含关键字（T2-03 检索未就绪时使用） */
  text?: string;
  orderBy?: MemoryOrderBy;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface MemoryPatch {
  title?: string;
  content?: string;
  structured?: Record<string, unknown> | null;
  tags?: readonly string[];
  sourceRef?: string | null;
  confidence?: number;
  importance?: number;
  pinned?: boolean;
  embedding?: readonly number[] | null;
  featureId?: string | null;
  pageId?: string | null;
  elementId?: string | null;
  issueId?: string | null;
}

const ORDER_COLUMN: Record<MemoryOrderBy, string> = {
  importance: 'importance',
  updatedAt: 'updated_at',
  createdAt: 'created_at',
  title: 'title',
};

interface WhereClause {
  sql: string;
  params: unknown[];
}

function buildWhere(query: MemoryListQuery): WhereClause {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const eq = (column: string, value: string | null | undefined): void => {
    // undefined = 不过滤；null = 筛选该列为 NULL
    if (value === undefined) return;
    if (value === null) {
      clauses.push(`${column} IS NULL`);
      return;
    }
    clauses.push(`${column} = ?`);
    params.push(value);
  };

  eq('user_id', query.userId ?? undefined);
  eq('project_id', query.projectId);
  eq('feature_id', query.featureId);
  eq('page_id', query.pageId);
  eq('element_id', query.elementId);
  eq('issue_id', query.issueId);
  eq('issue_status', query.issueStatus ?? undefined);

  if (query.scopes && query.scopes.length > 0) {
    clauses.push(`scope IN (${query.scopes.map(() => '?').join(', ')})`);
    params.push(...query.scopes);
  }

  if (query.layers && query.layers.length > 0) {
    const perLayer: string[] = [];
    for (const layer of query.layers) {
      if (layer === 'element') {
        perLayer.push(`(scope = 'page' AND element_id IS NOT NULL)`);
      } else if (layer === 'page') {
        perLayer.push(`(scope = 'page' AND element_id IS NULL)`);
      } else {
        perLayer.push(`(scope = ? AND element_id IS NULL)`);
        params.push(layer);
      }
    }
    clauses.push(`(${perLayer.join(' OR ')})`);
  }

  if (query.status !== undefined) {
    const statuses = Array.isArray(query.status) ? query.status : [query.status];
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
  }

  if (query.pinned !== undefined) {
    clauses.push('pinned = ?');
    params.push(query.pinned ? 1 : 0);
  }

  if (query.minImportance !== undefined) {
    clauses.push('importance >= ?');
    params.push(query.minImportance);
  }

  if (query.tags && query.tags.length > 0) {
    // tags 为 JSON 数组文本，用 LIKE 做子集匹配后由 list() 再精确过滤
    for (const tag of query.tags) {
      clauses.push('tags LIKE ?');
      params.push(`%"${tag}"%`);
    }
  }

  if (query.text && query.text.trim().length > 0) {
    const like = `%${query.text.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
    clauses.push(`(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }

  return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

export class MemoryRepo {
  private readonly repo: Repository<MemoryItemRow & Row>;
  readonly changes: MemoryChangeLogRepo;
  readonly revisions: MemoryStructRevisionRepo;

  constructor(private readonly db: Database) {
    this.repo = new Repository<MemoryItemRow & Row>(db, 'memory_item');
    this.changes = new MemoryChangeLogRepo(db);
    this.revisions = new MemoryStructRevisionRepo(db);
  }

  /** 底层句柄，供检索等模块建虚表 / 直查（不用于改写业务表） */
  get raw(): Database {
    return this.db;
  }

  /* ------------------------------ 读取 ------------------------------ */

  findById(id: string): MemoryItem | null {
    const row = this.repo.findById(id);
    // 读取路径不做不变量断言：历史数据（如通过导入写入）不应导致读取崩溃
    return row ? fromRow(row) : null;
  }

  findByIds(ids: readonly string[]): MemoryItem[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM memory_item WHERE id IN (${placeholders})`)
      .all(...ids) as MemoryItemRow[];
    return rows.map(fromRow);
  }

  list(query: MemoryListQuery = {}): MemoryItem[] {
    const where = buildWhere(query);
    const orderColumn = ORDER_COLUMN[query.orderBy ?? 'updatedAt'];
    const direction = (query.direction ?? 'desc') === 'asc' ? 'ASC' : 'DESC';
    const limit = query.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(query.limit))}` : '';
    const offset = query.offset !== undefined ? ` OFFSET ${Math.max(0, Math.floor(query.offset))}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM memory_item${where.sql} ORDER BY ${orderColumn} ${direction}${limit}${offset}`)
      .all(...where.params) as MemoryItemRow[];
    let items = rows.map(fromRow);
    if (query.tags && query.tags.length > 0) {
      items = items.filter((item) => query.tags!.every((tag) => item.tags.includes(tag)));
    }
    return items;
  }

  count(query: MemoryListQuery = {}): number {
    const where = buildWhere(query);
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM memory_item${where.sql}`).get(...where.params) as
      | { total: number }
      | undefined;
    return row?.total ?? 0;
  }

  /**
   * 分层统计：记忆中心左侧树与"进行中问题"角标使用。
   * 长期记忆始终计入（跨项目生效）；传入 projectId 时叠加该项目的各层条目。
   */
  countByLayer(userId: string, projectId?: string | null): Array<{ layer: MemoryLayer; total: number }> {
    const params: unknown[] = [userId];
    let clause = `user_id = ? AND status = 'active' AND (scope = 'longterm'`;
    if (projectId) {
      clause += ' OR project_id = ?';
      params.push(projectId);
    }
    clause += ')';

    const rows = this.db
      .prepare(
        `SELECT scope, (element_id IS NOT NULL) AS has_element, COUNT(*) AS total
         FROM memory_item WHERE ${clause}
         GROUP BY scope, has_element`,
      )
      .all(...params) as Array<{ scope: MemoryScope; has_element: number; total: number }>;

    const map = new Map<MemoryLayer, number>();
    for (const row of rows) {
      const layer = layerOf({ scope: row.scope, element_id: row.has_element === 1 ? 'x' : null });
      map.set(layer, (map.get(layer) ?? 0) + row.total);
    }
    return [...map.entries()]
      .map(([layer, total]) => ({ layer, total }))
      .sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]);
  }

  /** 同一"槽位"（同 scope + 同归属）内的全部条目 */
  findBySlot(scope: MemoryScope, ownership: Partial<MemoryOwnership>): MemoryItem[] {
    const all = this.list({
      scopes: [scope],
      projectId: ownership.project_id ?? null,
      featureId: ownership.feature_id ?? null,
      pageId: ownership.page_id ?? null,
      elementId: ownership.element_id ?? null,
      issueId: ownership.issue_id ?? null,
    });
    return all.filter((item) => ownershipKeyOf(ownershipOfItem(item)) === ownershipKeyOf(ownership));
  }

  /**
   * 写入前判重：找出与候选条目"同标题"的既有条目。
   * longterm 跨项目，故不带项目过滤；其余层级限定在自身槽位内。
   */
  findSameTitleCandidates(candidate: MemoryItem): MemoryItem[] {
    const scopeItems =
      candidate.scope === 'longterm'
        ? this.list({ userId: candidate.userId, scopes: ['longterm'] })
        : this.findBySlot(candidate.scope, ownershipOfItem(candidate));
    const key = normalizeTitleKey(candidate.title);
    return scopeItems.filter((item) => item.id !== candidate.id && normalizeTitleKey(item.title) === key);
  }

  /**
   * 上下文候选集：长期 + 当前项目 + 当前功能 + 当前页面 + 相关问题的条目。
   * 这里只做"范围收敛"（比完整继承链更宽），精确归属判断交给 resolveInheritance，
   * 好处是候选取数与层级规则解耦，后续新增层级无需改 SQL。
   */
  candidatesFor(ref: ResolveContextRef, options: { userId: string; includeInactive?: boolean }): MemoryItem[] {
    const conditions: string[] = ['user_id = ?', `scope = 'longterm'`];
    const params: unknown[] = [options.userId];

    if (ref.projectId) {
      conditions.push(`(scope = 'project' AND project_id = ?)`);
      params.push(ref.projectId);
      conditions.push(`(scope = 'issue' AND project_id = ?)`);
      params.push(ref.projectId);
      conditions.push(`(scope = 'feature' AND project_id = ?)`);
      params.push(ref.projectId);
      conditions.push(`(scope = 'page' AND project_id = ?)`);
      params.push(ref.projectId);
    }

    const statusClause = options.includeInactive ? '' : ` AND status = 'active'`;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_item WHERE (${conditions.join(' OR ')})${statusClause} ORDER BY updated_at ASC LIMIT 5000`,
      )
      .all(...params) as MemoryItemRow[];
    return rows.map(fromRow);
  }

  /** 解析上下文：候选集 + 继承覆盖（T2-01 核心 API） */
  resolveContext(ref: ResolveContextRef, options: { userId: string; includeInactive?: boolean }): ResolvedContext {
    return resolveInheritance(this.candidatesFor(ref, options), ref);
  }

  /* ------------------------------ 写入 ------------------------------ */

  insert(item: MemoryItem): MemoryItem {
    assertMemoryInvariants(item);
    this.repo.insert(toRow(item) as MemoryItemRow & Row);
    return item;
  }

  /** 便捷创建：入参校验 + 落库，返回领域对象 */
  create(input: CreateMemoryInput): MemoryItem {
    return this.insert(createMemoryItem(input));
  }

  insertMany(items: readonly MemoryItem[]): MemoryItem[] {
    const insertAll = this.db.transaction((rows: MemoryItem[]) => {
      for (const item of rows) this.insert(item);
    });
    insertAll([...items]);
    return [...items];
  }

  /** 更新字段（不含状态）；expectedVersion 传入即启用乐观锁 */
  update(id: string, patch: MemoryPatch, expectedVersion?: number): MemoryItem {
    const rowPatch: Partial<MemoryItemRow> = {};
    if (patch.title !== undefined) rowPatch.title = patch.title;
    if (patch.content !== undefined) rowPatch.content = patch.content;
    if (patch.structured !== undefined) rowPatch.structured = patch.structured === null ? null : JSON.stringify(patch.structured);
    if (patch.tags !== undefined) rowPatch.tags = JSON.stringify([...new Set(patch.tags)]);
    if (patch.sourceRef !== undefined) rowPatch.source_ref = patch.sourceRef;
    if (patch.confidence !== undefined) rowPatch.confidence = patch.confidence;
    if (patch.importance !== undefined) rowPatch.importance = patch.importance;
    if (patch.pinned !== undefined) rowPatch.pinned = patch.pinned ? 1 : 0;
    if (patch.featureId !== undefined) rowPatch.feature_id = patch.featureId;
    if (patch.pageId !== undefined) rowPatch.page_id = patch.pageId;
    if (patch.elementId !== undefined) rowPatch.element_id = patch.elementId;
    if (patch.issueId !== undefined) rowPatch.issue_id = patch.issueId;
    if (patch.embedding !== undefined) {
      rowPatch.embedding =
        patch.embedding === null ? null : new Uint8Array(new Float32Array([...patch.embedding]).buffer);
    }

    const updated = this.repo.update(id, rowPatch as Partial<MemoryItemRow & Row>, expectedVersion);
    if (!updated) throw new Error(`记忆条目不存在：${id}`);
    return fromRow(updated);
  }

  /** 仅更新向量（T2-03 写入后回填，避免整条替换） */
  setEmbedding(id: string, embedding: readonly number[] | null): void {
    const blob = embedding === null ? null : new Uint8Array(new Float32Array([...embedding]).buffer);
    this.db.prepare('UPDATE memory_item SET embedding = ? WHERE id = ?').run(blob, id);
  }

  /**
   * 移动层级（FR-MEM-21 批量"移动层级"）。
   *
   * 层级即 `scope` + 归属列的组合，属于结构性变更，因此：
   * - 先按目标 scope 做归属不变量校验，非法组合直接拒绝（不会写出"挂不上任何上下文"的孤儿记忆）；
   * - 进入/离开 issue 层时同步维护 `issue_status`，避免出现"已离开问题层却仍带处置状态"；
   * - 支持乐观锁，批量移动时由调用方逐条传入版本。
   */
  moveLayer(
    id: string,
    target: {
      scope: MemoryScope;
      projectId?: string | null;
      featureId?: string | null;
      pageId?: string | null;
      elementId?: string | null;
      issueId?: string | null;
    },
    expectedVersion?: number,
  ): MemoryItem {
    const current = this.require(id);
    const ownership: MemoryOwnership = {
      project_id: target.projectId ?? null,
      feature_id: target.featureId ?? null,
      page_id: target.pageId ?? null,
      element_id: target.elementId ?? null,
      issue_id: target.issueId ?? (target.scope === 'issue' ? (current.issueId ?? `ISSUE-${newUlid().slice(-6)}`) : null),
    };
    const violations = validateOwnership(target.scope, ownership);
    if (violations.length > 0) {
      throw new MemoryInvariantError(
        `无法移动到该层级：${violations.map((violation) => violation.message).join('；')}`,
        violations,
      );
    }

    const rowPatch: Partial<MemoryItemRow> = {
      scope: target.scope,
      project_id: ownership.project_id,
      feature_id: ownership.feature_id,
      page_id: ownership.page_id,
      element_id: ownership.element_id,
      issue_id: ownership.issue_id,
      issue_status: target.scope === 'issue' ? (current.issueStatus ?? 'unsolved') : null,
    };
    const updated = this.repo.update(id, rowPatch as Partial<MemoryItemRow & Row>, expectedVersion);
    if (!updated) throw new Error(`记忆条目不存在：${id}`);
    return fromRow(updated);
  }

  /** 状态流转（active / archived / superseded），非法流转抛 MemoryStateError */
  setStatus(id: string, next: MemoryStatus, options: { expectedVersion?: number; explicit?: boolean } = {}): MemoryItem {
    const current = this.require(id);
    assertStatusTransition(current.status, next, options);
    const rowPatch: Partial<MemoryItemRow> = { status: next };
    if (current.scope === 'issue' && (next === 'archived' || next === 'superseded')) {
      // 归档问题记忆时同步把处置状态落到 solved/mitigated，避免"已归档但仍显示未解决"
      rowPatch.issue_status = current.issueStatus === 'unsolved' ? 'mitigated' : current.issueStatus;
    }
    const updated = this.repo.update(id, rowPatch as Partial<MemoryItemRow & Row>, options.expectedVersion);
    if (!updated) throw new Error(`记忆条目不存在：${id}`);
    return fromRow(updated);
  }

  /** 问题记忆状态流转；重开（solved/mitigated → unsolved）必须显式声明 */
  setIssueStatus(
    id: string,
    next: IssueStatus,
    options: { explicit?: boolean; expectedVersion?: number } = {},
  ): MemoryItem {
    const current = this.require(id);
    if (current.scope !== 'issue') throw new Error(`条目 ${id} 不是问题记忆，无法设置 issueStatus`);
    assertIssueStatusTransition(current.issueStatus ?? 'unsolved', next, options);
    if (options.expectedVersion !== undefined) {
      const updated = this.repo.update(id, { issue_status: next } as Partial<MemoryItemRow & Row>, options.expectedVersion);
      if (!updated) throw new Error(`记忆条目不存在：${id}`);
      return fromRow(updated);
    }
    this.db.prepare('UPDATE memory_item SET issue_status = ?, updated_at = ? WHERE id = ?').run(next, Date.now(), id);
    return this.require(id);
  }

  /** 解决后沉淀：标记已解决并按需归档（FR-MEM-16） */
  resolveIssue(id: string, outcome: IssueStatus, options: { archive?: boolean; explicit?: boolean } = {}): MemoryItem {
    const resolved = this.setIssueStatus(id, outcome, {
      ...(options.explicit !== undefined ? { explicit: options.explicit } : {}),
    });
    if (!options.archive) return resolved;
    return this.setStatus(id, 'archived');
  }

  /** 软删除语义：记忆表无 deleted_at，archived 即"可恢复的删除" */
  remove(id: string): boolean {
    return this.repo.remove(id);
  }

  /** 撤销自动写入：先尝试物理删除，条目已不存在则返回 false */
  undoCreate(id: string): boolean {
    return this.remove(id);
  }

  /** 乐观锁冲突探测（供测试与 UI 提示复用） */
  static isConflictError(error: unknown): error is ConflictError {
    return error instanceof ConflictError;
  }

  private require(id: string): MemoryItem {
    const item = this.findById(id);
    if (!item) throw new Error(`记忆条目不存在：${id}`);
    return item;
  }
}

/** 条目归属字段提取（导出版本避免循环依赖） */
export function ownershipOfItem(item: MemoryItem): MemoryOwnership {
  return {
    project_id: item.projectId,
    feature_id: item.featureId,
    page_id: item.pageId,
    element_id: item.elementId,
    issue_id: item.issueId,
  };
}

/* --------------------------- 变更日志仓库 --------------------------- */

export interface ChangeLogRecord {
  id: string;
  userId: string;
  memoryId: string;
  action: MemoryChangeLogRow['action'];
  policy: string | null;
  sourceType: string | null;
  sourceConversationId: string | null;
  sourceSnippet: string | null;
  before: unknown;
  after: unknown;
  detail: unknown;
  createdAt: number;
}

export interface AppendChangeLogInput {
  userId: string;
  memoryId: string;
  action: MemoryChangeLogRow['action'];
  policy?: string | null;
  sourceType?: string | null;
  sourceConversationId?: string | null;
  sourceSnippet?: string | null;
  before?: unknown;
  after?: unknown;
  detail?: unknown;
  createdAt?: number;
}

/** 记忆变更日志（FR-MEM-12）：审计自动写入、撤销、冲突解决与层级移动 */
export class MemoryChangeLogRepo {
  private readonly repo: Repository<MemoryChangeLogRow & Row>;

  constructor(db: Database) {
    this.repo = new Repository<MemoryChangeLogRow & Row>(db, 'memory_change_log');
  }

  append(input: AppendChangeLogInput): ChangeLogRecord {
    const row: MemoryChangeLogRow = {
      id: newUlid(),
      user_id: input.userId,
      memory_id: input.memoryId,
      action: input.action,
      policy: input.policy ?? null,
      source_type: input.sourceType ?? null,
      source_conversation_id: input.sourceConversationId ?? null,
      source_snippet: input.sourceSnippet ?? null,
      before_json: input.before === undefined ? null : JSON.stringify(input.before),
      after_json: input.after === undefined ? null : JSON.stringify(input.after),
      detail_json: input.detail === undefined ? null : JSON.stringify(input.detail),
      created_at: input.createdAt ?? Date.now(),
    };
    this.repo.insert(row as MemoryChangeLogRow & Row);
    return toChangeLogRecord(row);
  }

  list(options: { userId?: string; memoryId?: string; limit?: number; offset?: number } = {}): ChangeLogRecord[] {
    const where: Partial<MemoryChangeLogRow> = {};
    if (options.userId) where.user_id = options.userId;
    if (options.memoryId) where.memory_id = options.memoryId;
    return this.repo
      .findWhere(where as Partial<MemoryChangeLogRow & Row>, {
        orderBy: 'created_at DESC',
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
      })
      .map(toChangeLogRecord);
  }

  count(options: { userId?: string; memoryId?: string } = {}): number {
    const where: Partial<MemoryChangeLogRow> = {};
    if (options.userId) where.user_id = options.userId;
    if (options.memoryId) where.memory_id = options.memoryId;
    return this.repo.count(where as Partial<MemoryChangeLogRow & Row>);
  }

  /** 撤销动作：写一条反向记录，保留完整轨迹（不删原记录） */
  appendUndo(record: ChangeLogRecord, userId: string): ChangeLogRecord {
    return this.append({
      userId,
      memoryId: record.memoryId,
      action: 'undo',
      policy: record.policy,
      sourceType: record.sourceType,
      sourceConversationId: record.sourceConversationId,
      sourceSnippet: record.sourceSnippet,
      before: record.after,
      after: record.before,
      detail: { undoOf: record.id, originalAction: record.action },
    });
  }
}

function toChangeLogRecord(row: MemoryChangeLogRow): ChangeLogRecord {
  return {
    id: row.id,
    userId: row.user_id,
    memoryId: row.memory_id,
    action: row.action,
    policy: row.policy,
    sourceType: row.source_type,
    sourceConversationId: row.source_conversation_id,
    sourceSnippet: row.source_snippet,
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    detail: parseJson(row.detail_json),
    createdAt: row.created_at,
  };
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/* --------------------------- 结构变更仓库 --------------------------- */

export interface StructRevisionRecord {
  id: string;
  memoryId: string;
  pageId: string;
  revision: number;
  tokenEstimate: number;
  truncated: boolean;
  summary: Record<string, unknown>;
  diff: unknown;
  createdAt: number;
}

export interface AppendStructRevisionInput {
  memoryId: string;
  pageId: string;
  summary: Record<string, unknown>;
  tokenEstimate: number;
  truncated?: boolean;
  diff?: unknown;
  createdAt?: number;
}

/** 页面逻辑结构变更历史（FR-MEM-18：保留最近 N 次） */
export class MemoryStructRevisionRepo {
  readonly keep = 5;
  private readonly repo: Repository<MemoryStructRevisionRow & Row>;

  constructor(db: Database) {
    this.repo = new Repository<MemoryStructRevisionRow & Row>(db, 'memory_struct_revision');
  }

  /** 追加一版并裁剪历史（默认保留最近 5 次） */
  append(input: AppendStructRevisionInput, keep: number = this.keep): StructRevisionRecord {
    const latest = this.list(input.memoryId, 1)[0];
    const row: MemoryStructRevisionRow = {
      id: newUlid(),
      memory_id: input.memoryId,
      page_id: input.pageId,
      revision: (latest?.revision ?? 0) + 1,
      token_estimate: input.tokenEstimate,
      truncated: input.truncated ? 1 : 0,
      summary_json: JSON.stringify(input.summary),
      diff_json: input.diff === undefined ? null : JSON.stringify(input.diff),
      created_at: input.createdAt ?? Date.now(),
    };
    this.repo.insert(row as MemoryStructRevisionRow & Row);
    this.prune(input.memoryId, keep);
    return toRevisionRecord(row);
  }

  list(memoryId: string, limit?: number): StructRevisionRecord[] {
    return this.repo
      .findWhere({ memory_id: memoryId }, { orderBy: 'revision DESC', ...(limit !== undefined ? { limit } : {}) })
      .map(toRevisionRecord);
  }

  /** 最近 N 次（默认 5 次），按时间正序返回便于 UI 展示时间轴 */
  recent(memoryId: string, keep: number = this.keep): StructRevisionRecord[] {
    return this.list(memoryId, keep).reverse();
  }

  latest(memoryId: string): StructRevisionRecord | null {
    return this.list(memoryId, 1)[0] ?? null;
  }

  private prune(memoryId: string, keep: number): void {
    const rows = this.list(memoryId);
    for (const row of rows.slice(Math.max(1, keep))) {
      this.repo.remove(row.id);
    }
  }
}

function toRevisionRecord(row: MemoryStructRevisionRow): StructRevisionRecord {
  return {
    id: row.id,
    memoryId: row.memory_id,
    pageId: row.page_id,
    revision: row.revision,
    tokenEstimate: row.token_estimate,
    truncated: row.truncated === 1,
    summary: (parseJson(row.summary_json) as Record<string, unknown> | null) ?? {},
    diff: parseJson(row.diff_json),
    createdAt: row.created_at,
  };
}
