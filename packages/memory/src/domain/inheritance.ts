import { detectConflicts, flattenStructured, ownershipOf } from './conflict';
import { normalizeTitleKey, type MemoryItem } from './memory-item';
import { LAYER_ORDER, layerOf, type MemoryLayer, type MemoryOwnership } from './scope';

/**
 * 继承与覆盖解析（FR-MEM-06 / PRD §2.1、§13.2）。
 *
 * 规则：
 * 1. 下层自动携带其全部上层记忆，按 `长期 → 项目 → 功能 → 页面 → 元素 → 问题` 排序（越靠后越具体）；
 * 2. **同标题**冲突视为"同一条记忆"，下层整体接管（上层条目被覆盖，不再进入上下文）；
 * 3. **同 structured 叶子路径**冲突按路径覆盖：下层在该路径上胜出，上层条目其余键仍然生效；
 * 4. 同层内冲突（同层重复）以 `updatedAt` 新者胜、再以 `importance` 高者胜；
 * 5. 所有覆盖关系都产出可溯源记录（胜者 id / 败者 id / 层级 / 字段名），供 UI 标注"这条来自哪一层"。
 */

export interface ResolveContextRef {
  /** 项目上下文；长期记忆无需项目也可解析（projectId 传空串表示"仅长期记忆"） */
  projectId: string;
  featureId?: string | null;
  pageId?: string | null;
  elementId?: string | null;
  issueId?: string | null;
}

export interface ConflictTrace {
  /** 冲突键：`title:<key>` 或 `structured:<path>` */
  key: string;
  /** 冲突字段名（title 或 structured 叶子路径） */
  field: string;
  kind: 'title' | 'structured';
  /** 胜出（更具体）条目 */
  winnerId: string;
  winnerTitle: string;
  winnerLayer: MemoryLayer;
  /** 被覆盖的上层条目 —— 即"这条来自哪一层"的来源 */
  loserId: string;
  loserTitle: string;
  loserLayer: MemoryLayer;
  /** 胜者取值 */
  winnerValue: unknown;
  /** 被覆盖的上层取值 */
  loserValue: unknown;
  /** 是否同层冲突（无法用层级裁决，按更新时间裁决） */
  sameLayer: boolean;
}

export interface CoverageMark {
  winnerId: string;
  winnerTitle: string;
  winnerLayer: MemoryLayer;
  /** 被该条覆盖的上层条目 id 列表 */
  overriddenIds: string[];
  /** 冲突字段名列表 */
  fields: string[];
}

export interface ResolvedContext {
  ref: ResolveContextRef;
  /** 参与解析的层级（按继承顺序） */
  layers: MemoryLayer[];
  /** 分层视图（仅含出现的层级） */
  byLayer: Array<{ layer: MemoryLayer; label: string; items: MemoryItem[] }>;
  /** 全部候选条目，已按层级升序排序 */
  candidates: MemoryItem[];
  /** 真正进入 AI 上下文的条目（按层级升序 = 提示词顺序） */
  effective: MemoryItem[];
  /** 被下层整体接管的条目（title 冲突败者） */
  overridden: MemoryItem[];
  /** 按路径覆盖的明细（structured 冲突败者的某些路径失效） */
  pathOverrides: Array<{ itemId: string; paths: string[]; by: string }>;
  /** 冲突溯源记录 */
  conflicts: ConflictTrace[];
  /** 每个胜者的覆盖汇总（UI 徽标数据源） */
  coverage: CoverageMark[];
}

/** 条目是否落在解析范围内（自身层级链上任一归属命中） */
export function isRelevantTo(item: MemoryItem, ref: ResolveContextRef): boolean {
  switch (item.scope) {
    case 'longterm':
      return true;
    case 'project':
      return Boolean(ref.projectId) && item.projectId === ref.projectId;
    case 'feature':
      return (
        Boolean(ref.projectId) &&
        item.projectId === ref.projectId &&
        Boolean(ref.featureId) &&
        item.featureId === ref.featureId
      );
    case 'page':
      if (!ref.projectId || item.projectId !== ref.projectId) return false;
      if (ref.pageId && item.pageId !== ref.pageId) return false;
      if (item.elementId) return Boolean(ref.elementId) && item.elementId === ref.elementId;
      return Boolean(ref.pageId);
    case 'issue':
      if (!ref.projectId || item.projectId !== ref.projectId) return false;
      if (ref.issueId && item.issueId === ref.issueId) return true;
      if (item.elementId) return Boolean(ref.elementId) && item.elementId === ref.elementId;
      if (item.pageId) return Boolean(ref.pageId) && item.pageId === ref.pageId;
      if (item.featureId) return Boolean(ref.featureId) && item.featureId === ref.featureId;
      // 未关联具体位置的问题记忆（历史数据）只在项目级解析时出现
      return !ref.pageId && !ref.featureId;
    default:
      return false;
  }
}

function sortCandidates(items: readonly MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => {
    const byLayer = LAYER_ORDER[layerOf(a)] - LAYER_ORDER[layerOf(b)];
    if (byLayer !== 0) return byLayer;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.importance !== b.importance) return b.importance - a.importance;
    return a.updatedAt - b.updatedAt;
  });
}

/** 每条记忆"占用"的键：标题键 + 全部结构化叶子路径 */
function keysOf(
  item: MemoryItem,
): Array<{ key: string; field: string; kind: 'title' | 'structured'; value: unknown }> {
  const keys: Array<{ key: string; field: string; kind: 'title' | 'structured'; value: unknown }> =
    [];
  const titleKey = normalizeTitleKey(item.title);
  if (titleKey)
    keys.push({ key: `title:${titleKey}`, field: 'title', kind: 'title', value: item.title });
  for (const [path, value] of flattenStructured(item.structured)) {
    keys.push({ key: `structured:${path}`, field: path, kind: 'structured', value });
  }
  return keys;
}

function beats(a: MemoryItem, b: MemoryItem): boolean {
  const layerDiff = LAYER_ORDER[layerOf(a)] - LAYER_ORDER[layerOf(b)];
  if (layerDiff !== 0) return layerDiff > 0;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (a.importance !== b.importance) return a.importance > b.importance;
  if (a.pinned !== b.pinned) return a.pinned;
  // 最终稳定裁决：id 字典序，保证同一输入多次解析结果一致
  return a.id > b.id;
}

/**
 * 纯函数版解析：接收候选条目（通常来自 repo 的范围查询），产出继承与冲突结果。
 * 与数据库解耦，便于单测与"假设分析"（例如 UI 预览某页面会带上哪些记忆）。
 */
export function resolveInheritance(
  items: readonly MemoryItem[],
  ref: ResolveContextRef,
): ResolvedContext {
  const candidates = sortCandidates(items.filter((item) => isRelevantTo(item, ref)));

  const traces: ConflictTrace[] = [];
  const fullyOverridden = new Set<string>();
  const pathOverrides = new Map<string, { paths: string[]; by: string }>();

  // 按 key 归组，胜者唯一
  const byKey = new Map<
    string,
    Array<{ item: MemoryItem; field: string; kind: 'title' | 'structured'; value: unknown }>
  >();
  for (const item of candidates) {
    for (const entry of keysOf(item)) {
      const bucket = byKey.get(entry.key) ?? [];
      bucket.push({ item, field: entry.field, kind: entry.kind, value: entry.value });
      byKey.set(entry.key, bucket);
    }
  }

  for (const [key, bucket] of byKey) {
    if (bucket.length < 2) continue;
    let winner = bucket[0]!;
    for (const entry of bucket.slice(1)) {
      if (beats(entry.item, winner.item)) winner = entry;
    }
    const titleCollision = winner.kind === 'title';

    for (const loser of bucket) {
      if (loser.item.id === winner.item.id) continue;

      if (titleCollision) {
        // 同标题 = 同一条记忆：最具体的一层整体接管，上层条目不再进入上下文。
        // 无论取值是否相同都执行接管，避免同一条约定在上下文里出现两次。
        fullyOverridden.add(loser.item.id);
        // 只有正文/结构化确实不同才提示用户（取值一致时静默接管，不打扰）
        const bodiesDiffer =
          winner.item.content !== loser.item.content ||
          JSON.stringify(winner.item.structured) !== JSON.stringify(loser.item.structured);
        if (!bodiesDiffer) continue;
        traces.push({
          key,
          field: 'title',
          kind: 'title',
          winnerId: winner.item.id,
          winnerTitle: winner.item.title,
          winnerLayer: layerOf(winner.item),
          loserId: loser.item.id,
          loserTitle: loser.item.title,
          loserLayer: layerOf(loser.item),
          winnerValue: winner.item.content,
          loserValue: loser.item.content,
          sameLayer: layerOf(winner.item) === layerOf(loser.item),
        });
        continue;
      }

      // 结构化路径冲突：按路径裁决，上层条目其余键仍然生效
      if (JSON.stringify(loser.value) === JSON.stringify(winner.value)) continue;
      traces.push({
        key,
        field: winner.field,
        kind: winner.kind,
        winnerId: winner.item.id,
        winnerTitle: winner.item.title,
        winnerLayer: layerOf(winner.item),
        loserId: loser.item.id,
        loserTitle: loser.item.title,
        loserLayer: layerOf(loser.item),
        winnerValue: winner.value,
        loserValue: loser.value,
        sameLayer: layerOf(winner.item) === layerOf(loser.item),
      });
      const existing = pathOverrides.get(loser.item.id) ?? { paths: [], by: winner.item.id };
      existing.paths.push(winner.field);
      pathOverrides.set(loser.item.id, existing);
    }
  }

  const overridden = candidates.filter((item) => fullyOverridden.has(item.id));
  const effective = candidates.filter((item) => !fullyOverridden.has(item.id));

  const coverageMap = new Map<string, CoverageMark>();
  for (const trace of traces) {
    if (fullyOverridden.has(trace.winnerId)) continue;
    const mark = coverageMap.get(trace.winnerId) ?? {
      winnerId: trace.winnerId,
      winnerTitle: trace.winnerTitle,
      winnerLayer: trace.winnerLayer,
      overriddenIds: [],
      fields: [],
    };
    if (!mark.overriddenIds.includes(trace.loserId)) mark.overriddenIds.push(trace.loserId);
    if (!mark.fields.includes(trace.field)) mark.fields.push(trace.field);
    coverageMap.set(trace.winnerId, mark);
  }

  const layers = [...new Set(candidates.map((item) => layerOf(item)))].sort(
    (a, b) => LAYER_ORDER[a] - LAYER_ORDER[b],
  );

  return {
    ref,
    layers,
    byLayer: layers.map((layer) => ({
      layer,
      label: layer,
      items: candidates.filter((item) => layerOf(item) === layer),
    })),
    candidates,
    effective,
    overridden,
    pathOverrides: [...pathOverrides.entries()].map(([itemId, value]) => ({ itemId, ...value })),
    conflicts: traces,
    coverage: [...coverageMap.values()],
  };
}

/**
 * 检测两条条目之间的冲突（对等视角，不涉及层级裁决）。
 * 供"写入前判重"与导入合并预览复用。
 */
export function conflictsBetween(a: MemoryItem, b: MemoryItem) {
  return detectConflicts(a, b);
}

/** 归属描述（用于冲突卡片文案："项目记忆 · 命名规范"） */
export function describeOwnership(ownership: Partial<MemoryOwnership>): string {
  const parts: string[] = [];
  if (ownership.project_id) parts.push(`project=${ownership.project_id}`);
  if (ownership.feature_id) parts.push(`feature=${ownership.feature_id}`);
  if (ownership.page_id) parts.push(`page=${ownership.page_id}`);
  if (ownership.element_id) parts.push(`element=${ownership.element_id}`);
  if (ownership.issue_id) parts.push(`issue=${ownership.issue_id}`);
  return parts.length > 0 ? parts.join(' ') : 'global';
}

export { ownershipOf };
