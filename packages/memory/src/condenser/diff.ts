/**
 * 增量 diff：比较新旧 DSL（或新旧摘要）定位变更子树，仅供「重算受影响子树」使用。
 *
 * 比较维度是「结构而非样式」：元素 id 集合、类型、bindings、featureRef，
 * 以及业务性 props（keepProps 命中者）。纯样式/装饰变化不计入结构变更。
 */

import type { CondensedSummary } from './condenser';
import type { PageDsl, PageDslElement } from './page-dsl';
import { DEFAULT_CONDENSER_RULES } from './rules';

/** 结构变更摘要 */
export interface CondensedDiff {
  /** 类型 / 绑定 / 业务 props / featureRef 发生变化的元素 id */
  changedIds: string[];
  /** 新增元素 id */
  addedIds: string[];
  /** 移除元素 id */
  removedIds: string[];
  /** 事件流是否变化 */
  eventsChanged: boolean;
  /** 状态是否变化 */
  stateChanged: boolean;
  /** 新增的接口依赖 */
  apiDepsAdded: string[];
  /** 移除的接口依赖 */
  apiDepsRemoved: string[];
  /** 需重算的最小子树根 id（变更节点中无变更祖先者） */
  subtrees: string[];
}

interface FlatEl {
  id: string;
  type: string;
  featureRef: string | null;
  bindings?: Record<string, string>;
  props?: Record<string, unknown>;
  parentId: string | null;
}

/** 完整展平组件树，记录父关系 */
function flatten(node: PageDslElement, parentId: string | null, out: FlatEl[] = []): FlatEl[] {
  const entry: FlatEl = {
    id: node.id,
    type: node.type,
    featureRef: node.featureRef ?? null,
    parentId,
  };
  if (node.bindings) entry.bindings = node.bindings;
  if (node.props) entry.props = node.props;
  out.push(entry);
  for (const child of node.children ?? []) flatten(child, node.id, out);
  return out;
}

/** 结构签名：仅含类型 / featureRef / bindings / 业务 props（忽略样式与装饰） */
function structuralSig(el: FlatEl): string {
  const business: Record<string, unknown> = {};
  if (el.props) {
    for (const [key, value] of Object.entries(el.props)) {
      if (DEFAULT_CONDENSER_RULES.keepProps.includes(key)) business[key] = value;
    }
  }
  return JSON.stringify({
    type: el.type,
    featureRef: el.featureRef,
    bindings: el.bindings ?? {},
    business,
  });
}

/** 计算「需重算的最小子树根」：变更集中不存在已变更祖先者 */
function computeSubtrees(touched: Set<string>, parentOf: (id: string) => string | null): string[] {
  const subtrees: string[] = [];
  for (const id of touched) {
    let cur = parentOf(id);
    let isRoot = true;
    while (cur) {
      if (touched.has(cur)) {
        isRoot = false;
        break;
      }
      cur = parentOf(cur);
    }
    if (isRoot) subtrees.push(id);
  }
  return subtrees;
}

/** 基于两个 PageDSL 计算结构 diff */
export function diffDsl(previous: PageDsl, next: PageDsl): CondensedDiff {
  const prevFlat = flatten(previous.tree, null);
  const nextFlat = flatten(next.tree, null);
  const prevMap = new Map(prevFlat.map((e) => [e.id, e]));
  const nextMap = new Map(nextFlat.map((e) => [e.id, e]));
  const prevIds = new Set(prevMap.keys());
  const nextIds = new Set(nextMap.keys());

  const addedIds = [...nextIds].filter((id) => !prevIds.has(id));
  const removedIds = [...prevIds].filter((id) => !nextIds.has(id));
  const changedIds: string[] = [];
  for (const id of nextIds) {
    if (!prevIds.has(id)) continue;
    const a = prevMap.get(id);
    const b = nextMap.get(id);
    if (!a || !b) continue;
    if (structuralSig(a) !== structuralSig(b)) changedIds.push(id);
  }

  const touched = new Set<string>([...changedIds, ...addedIds, ...removedIds]);
  const parentOf = (id: string): string | null => {
    const e = nextMap.get(id) ?? prevMap.get(id);
    return e ? e.parentId : null;
  };
  const subtrees = computeSubtrees(touched, parentOf);

  const prevEvents = JSON.stringify(previous.events ?? []);
  const nextEvents = JSON.stringify(next.events ?? []);
  const prevState = JSON.stringify(previous.state ?? []);
  const nextState = JSON.stringify(next.state ?? []);

  const prevApi = new Set(previous.apiDeps ?? []);
  const nextApi = new Set(next.apiDeps ?? []);
  const apiDepsAdded = [...nextApi].filter((d) => !prevApi.has(d));
  const apiDepsRemoved = [...prevApi].filter((d) => !nextApi.has(d));

  return {
    changedIds,
    addedIds,
    removedIds,
    eventsChanged: prevEvents !== nextEvents,
    stateChanged: prevState !== nextState,
    apiDepsAdded,
    apiDepsRemoved,
    subtrees,
  };
}

/** 仅持有摘要时，基于两个 CondensedSummary 计算结构 diff */
export function diffSummary(previous: CondensedSummary, next: CondensedSummary): CondensedDiff {
  const prevIdx = previous.elementIndex;
  const nextIdx = next.elementIndex;
  const prevIds = new Set(Object.keys(prevIdx));
  const nextIds = new Set(Object.keys(nextIdx));

  const addedIds = [...nextIds].filter((id) => !prevIds.has(id));
  const removedIds = [...prevIds].filter((id) => !nextIds.has(id));
  const changedIds: string[] = [];
  for (const id of nextIds) {
    if (!prevIds.has(id)) continue;
    const a = prevIdx[id];
    const b = nextIdx[id];
    if (!a || !b) continue;
    const sigChanged =
      a.type !== b.type ||
      a.featureRef !== b.featureRef ||
      JSON.stringify(a.boundProps) !== JSON.stringify(b.boundProps);
    if (sigChanged) changedIds.push(id);
  }

  const touched = new Set<string>([...changedIds, ...addedIds, ...removedIds]);
  const parentOf = (id: string): string | null => {
    const info = nextIdx[id] ?? prevIdx[id];
    return info ? info.parentId : null;
  };
  const subtrees = computeSubtrees(touched, parentOf);

  const prevEvents = JSON.stringify(previous.events);
  const nextEvents = JSON.stringify(next.events);
  const prevState = JSON.stringify(previous.state);
  const nextState = JSON.stringify(next.state);

  const prevApi = new Set(previous.apiDeps);
  const nextApi = new Set(next.apiDeps);
  const apiDepsAdded = [...nextApi].filter((d) => !prevApi.has(d));
  const apiDepsRemoved = [...prevApi].filter((d) => !nextApi.has(d));

  return {
    changedIds,
    addedIds,
    removedIds,
    eventsChanged: prevEvents !== nextEvents,
    stateChanged: prevState !== nextState,
    apiDepsAdded,
    apiDepsRemoved,
    subtrees,
  };
}

/** 是否存在任何结构变化（用于决定是否追加 revision） */
export function hasStructuralChange(diff: CondensedDiff): boolean {
  return (
    diff.changedIds.length > 0 ||
    diff.addedIds.length > 0 ||
    diff.removedIds.length > 0 ||
    diff.eventsChanged ||
    diff.stateChanged ||
    diff.apiDepsAdded.length > 0 ||
    diff.apiDepsRemoved.length > 0
  );
}
