import { insertChild, moveNode, removeNode, replaceNode, walkElements } from '../dsl/traverse';
import type { ElementNode, PageDsl } from '../dsl/types';
import { diffSize, diffTrees, type DslTreeDiff } from './diff-ops';

/**
 * 设计稿快照与增量 patch 链（T3-10 要点 1/2）。
 *
 * 存储策略：
 * - 首次快照为**全量基线**（`kind: 'base'`）；
 * - 之后每个快照只存**结构化操作列表**（`kind: 'delta'`），来自 `diffToOps`；
 * - 每 `BASELINE_EVERY`（默认 20）个 delta 落一次新的全量基线，避免回放链过长。
 *
 * 与流水线阶段产物（T5-01 的 StageArtifact）**完全独立**：设计稿快照只属于设计器，
 * 不写 pipeline 相关表（见任务卡要点 5）。
 */

export const BASELINE_EVERY = 20;

/** DSL 增量操作 */
export type DslOp =
  | { op: 'setPage'; fields: Partial<PageDsl> }
  | { op: 'removeNode'; id: string }
  | { op: 'insertNode'; parentId: string; index: number; node: ElementNode }
  | { op: 'moveNode'; id: string; parentId: string; index: number }
  | { op: 'updateNode'; id: string; fields: Partial<ElementNode> }
  /** 兜底：变更过大时整体替换（仍是「一次 patch」，避免生成脆弱的长操作链） */
  | { op: 'replaceDsl'; dsl: PageDsl };

/** 生成增量操作；变更过大或包含复杂重排时退化为整树替换 */
export function diffToOps(previous: PageDsl, next: PageDsl, options: { maxOps?: number } = {}): DslOp[] {
  const maxOps = options.maxOps ?? 40;
  const diff = diffTrees(previous, next);
  if (diffSize(diff) > maxOps) return [{ op: 'replaceDsl', dsl: next }];

  const ops: DslOp[] = [];

  // 页面级字段
  const pageFields: Partial<PageDsl> = {};
  if (diff.pageChanged.includes('name')) pageFields.name = next.name;
  if (diff.pageChanged.includes('route')) pageFields.route = next.route;
  if (diff.pageChanged.includes('platform')) pageFields.platform = next.platform;
  if (diff.pageChanged.includes('featureId')) pageFields.featureId = next.featureId ?? null;
  if (diff.pageChanged.includes('viewport')) pageFields.viewport = next.viewport;
  if (diff.stateChanged) pageFields.state = next.state;
  if (diff.eventsChanged) pageFields.events = next.events;
  if (diff.apiDepsChanged) pageFields.apiDeps = next.apiDeps;
  if (diff.anchorsChanged) pageFields.anchors = next.anchors;
  if (diff.notesChanged) pageFields.notes = next.notes;
  if (Object.keys(pageFields).length > 0) ops.push({ op: 'setPage', fields: pageFields });

  // 删除：深度大的先删，避免父节点被删后子节点找不到
  const depthOf = new Map(walkElements(previous.tree).map((entry) => [entry.node.id, entry.depth]));
  const removed = [...diff.removed].sort((a, b) => (depthOf.get(b.id) ?? 0) - (depthOf.get(a.id) ?? 0));
  for (const entry of removed) ops.push({ op: 'removeNode', id: entry.id });

  // 新增：只插入「最上层」的新增节点（整棵子树一起插入），避免子孙重复插入
  const addedIds = new Set(diff.added.map((entry) => entry.id));
  const topAdded = diff.added
    .filter((entry) => entry.parentId === null || !addedIds.has(entry.parentId))
    .sort((a, b) => a.index - b.index);
  for (const entry of topAdded) ops.push({ op: 'insertNode', parentId: entry.parentId ?? previous.tree.id, index: entry.index, node: entry.node });

  // 移动：两段处理——目标父节点已存在的先做，目标父节点是本次新增的放后面
  const existingIds = new Set(walkElements(previous.tree).map((entry) => entry.node.id));
  const firstPhase = diff.moved.filter((entry) => entry.parentId !== null && (existingIds.has(entry.parentId) || entry.parentId === previous.tree.id));
  const secondPhase = diff.moved.filter((entry) => !firstPhase.includes(entry));
  const byDepth = (a: { id: string }, b: { id: string }): number => (depthOf.get(a.id) ?? 0) - (depthOf.get(b.id) ?? 0);
  for (const entry of [...firstPhase].sort(byDepth)) {
    ops.push({ op: 'moveNode', id: entry.id, parentId: entry.parentId ?? previous.tree.id, index: entry.index });
  }
  for (const entry of [...secondPhase].sort(byDepth)) {
    ops.push({ op: 'moveNode', id: entry.id, parentId: entry.parentId ?? previous.tree.id, index: entry.index });
  }

  // 修改：避免把 type 变更当普通字段（type 变更用整树替换更稳）
  for (const entry of diff.modified) {
    const fields: Partial<ElementNode> = {};
    for (const key of entry.changedKeys) {
      if (key === 'type') continue;
      (fields as Record<string, unknown>)[key] = (entry.after as unknown as Record<string, unknown>)[key];
    }
    if (Object.keys(fields).length > 0) ops.push({ op: 'updateNode', id: entry.id, fields });
  }

  return ops;
}

/** 应用增量操作，得到新的 DSL（纯函数） */
export function applyOps(dsl: PageDsl, ops: readonly DslOp[]): PageDsl {
  let current = dsl;
  for (const op of ops) {
    switch (op.op) {
      case 'replaceDsl':
        current = op.dsl;
        break;
      case 'setPage':
        current = { ...current, ...op.fields };
        break;
      case 'removeNode': {
        const result = removeNode(current.tree, op.id);
        current = { ...current, tree: result.root };
        break;
      }
      case 'insertNode': {
        const result = insertChild(current.tree, op.parentId, op.node, op.index);
        if (result.inserted) current = { ...current, tree: result.root };
        break;
      }
      case 'moveNode': {
        const result = moveNode(current.tree, op.id, op.parentId, op.index);
        if (result.moved) current = { ...current, tree: result.root };
        break;
      }
      case 'updateNode': {
        current = {
          ...current,
          tree: replaceNode(current.tree, op.id, (node) => ({ ...node, ...op.fields })),
        };
        break;
      }
    }
  }
  return current;
}

export type SnapshotReason = 'auto' | 'manual' | 'milestone';

export interface SnapshotMeta {
  id: string;
  pageId: string;
  createdAt: number;
  reason: SnapshotReason;
  /** 触发说明（中文），如「阶段确认」「AI 生成完成」 */
  label?: string;
  commitSha?: string | null;
  /** 本次变更的元素数量（时间轴展示） */
  changedElements: number;
  /** 编码后的字节数（体积统计） */
  sizeBytes: number;
  kind: 'base' | 'delta';
}

interface SnapshotRecordInternal {
  meta: SnapshotMeta;
  /** kind=base 时为全量 DSL */
  dsl?: PageDsl;
  /** kind=delta 时为操作列表 */
  ops?: DslOp[];
}

export interface HistoryStoreOptions {
  idFactory?: () => string;
  /** 每多少个 delta 落一次全量基线 */
  baselineEvery?: number;
  /** patch 链最大长度（超出丢弃最旧快照，从新的基线开始） */
  maxSnapshots?: number;
}

export interface CaptureInput {
  dsl: PageDsl;
  reason: SnapshotReason;
  label?: string;
  commitSha?: string | null;
  /** 当前时间（毫秒）；默认 Date.now() */
  now?: number;
}

export interface HistoryStats {
  count: number;
  baselineCount: number;
  deltaCount: number;
  totalBytes: number;
  /** 平均每个快照字节数 */
  avgBytes: number;
  /** 相比「每次都存全量」节省的字节数 */
  savedBytes: number;
}

/**
 * 设计稿历史（快照 + 回滚）。
 *
 * 内存态实现，可选注入 `DslStorePort` 做原子落盘（外壳负责真实文件位置）。
 */
export class HistoryStore {
  private readonly records: SnapshotRecordInternal[] = [];
  private readonly baselineEvery: number;
  private readonly maxSnapshots: number;
  private readonly idFactory: () => string;
  private deltaCountSinceBaseline = 0;
  private counter = 0;
  private fullDslBytes = 0;

  constructor(options: HistoryStoreOptions = {}) {
    this.baselineEvery = options.baselineEvery ?? BASELINE_EVERY;
    this.maxSnapshots = options.maxSnapshots ?? 200;
    let index = 0;
    this.idFactory = options.idFactory ?? ((): string => `snap-${(index += 1)}`);
  }

  /** 创建快照：首张 / 每 N 张为全量基线，其余为增量 patch */
  capture(input: CaptureInput): SnapshotMeta {
    const now = input.now ?? Date.now();
    this.counter += 1;
    const previous = this.latestDsl();

    if (previous === null || this.deltaCountSinceBaseline >= this.baselineEvery) {
      const sizeBytes = byteLength(JSON.stringify(input.dsl));
      this.fullDslBytes = Math.max(this.fullDslBytes, sizeBytes);
      const meta: SnapshotMeta = {
        id: this.idFactory(),
        pageId: input.dsl.id,
        createdAt: now,
        reason: input.reason,
        changedElements: previous === null ? walkElements(input.dsl.tree).length : 0,
        sizeBytes,
        kind: 'base',
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
      };
      this.records.push({ meta, dsl: input.dsl });
      this.deltaCountSinceBaseline = 0;
      this.trim();
      return meta;
    }

    const diff: DslTreeDiff = diffTrees(previous, input.dsl);
    const ops = diffToOps(previous, input.dsl);
    const encoded = JSON.stringify(ops);
    const meta: SnapshotMeta = {
      id: this.idFactory(),
      pageId: input.dsl.id,
      createdAt: now,
      reason: input.reason,
      changedElements: diff.added.length + diff.removed.length + diff.moved.length + diff.modified.length,
      sizeBytes: byteLength(encoded),
      kind: 'delta',
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
    };
    this.records.push({ meta, ops });
    this.deltaCountSinceBaseline += 1;
    this.trim();
    return meta;
  }

  /** 快照元信息列表（时间正序） */
  list(pageId?: string): SnapshotMeta[] {
    return this.records
      .filter((record) => pageId === undefined || record.meta.pageId === pageId)
      .map((record) => ({ ...record.meta }));
  }

  size(): number {
    return this.records.length;
  }

  /** 最近一次快照对应的 DSL（用于增量 diff 与回滚前对比） */
  latestDsl(): PageDsl | null {
    const last = this.records[this.records.length - 1];
    if (last === undefined) return null;
    return this.materialize(last.meta.id);
  }

  /** 回放：从最近基线开始按顺序应用 delta，重建指定快照的完整 DSL */
  materialize(snapshotId: string): PageDsl | null {
    const index = this.records.findIndex((record) => record.meta.id === snapshotId);
    if (index === -1) return null;

    let baseIndex = index;
    while (baseIndex > 0 && this.records[baseIndex]?.meta.kind !== 'base') baseIndex -= 1;
    const base = this.records[baseIndex];
    if (base === undefined || base.dsl === undefined) return null;

    let dsl = base.dsl;
    for (let cursor = baseIndex + 1; cursor <= index; cursor += 1) {
      const record = this.records[cursor];
      if (record === undefined) continue;
      if (record.meta.kind === 'base' && record.dsl !== undefined) {
        dsl = record.dsl;
        continue;
      }
      if (record.ops !== undefined) dsl = applyOps(dsl, record.ops);
    }
    return dsl;
  }

  /**
   * 回滚到指定快照：**回滚前先把当前状态存为快照**（保证回滚本身可再次撤销）。
   * @returns 回滚后的 DSL，快照不存在时返回 null
   */
  rollback(snapshotId: string, options: { now?: number; currentDsl?: PageDsl } = {}): PageDsl | null {
    const target = this.materialize(snapshotId);
    if (target === null) return null;
    const current = options.currentDsl ?? this.latestDsl();
    const now = options.now;

    // 回滚前先把「当前状态」存为快照，因此回滚本身可以再回滚回去（T3-10 验收项）
    if (current !== null && !sameDsl(current, target)) {
      this.capture({
        dsl: current,
        reason: 'manual',
        label: '回滚前自动备份',
        ...(now !== undefined ? { now } : {}),
      });
    }
    this.capture({
      dsl: target,
      reason: 'manual',
      label: `回滚到 ${snapshotId}`,
      ...(now !== undefined ? { now } : {}),
    });
    return target;
  }

  stats(): HistoryStats {
    const totalBytes = this.records.reduce((sum, record) => sum + record.meta.sizeBytes, 0);
    const baselineCount = this.records.filter((record) => record.meta.kind === 'base').length;
    const fullBytes = this.fullDslBytes * this.records.length;
    return {
      count: this.records.length,
      baselineCount,
      deltaCount: this.records.length - baselineCount,
      totalBytes,
      avgBytes: this.records.length === 0 ? 0 : Math.round(totalBytes / this.records.length),
      savedBytes: Math.max(0, fullBytes - totalBytes),
    };
  }

  /** 清空历史 */
  clear(): void {
    this.records.length = 0;
    this.deltaCountSinceBaseline = 0;
    this.counter = 0;
  }

  private trim(): void {
    while (this.records.length > this.maxSnapshots) {
      this.records.shift();
      this.deltaCountSinceBaseline = this.records.filter((record) => record.meta.kind === 'delta').length;
    }
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 深拷贝（快照中保存的节点必须是独立副本，避免被后续编辑污染） */
export function deepCloneSubtree(node: ElementNode): ElementNode {
  return JSON.parse(JSON.stringify(node)) as ElementNode;
}

/** 结构等价判定（用于避免无意义的回滚快照） */
export function sameDsl(a: PageDsl, b: PageDsl): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
