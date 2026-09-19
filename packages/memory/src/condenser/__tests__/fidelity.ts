/**
 * 保真度评估（可运行）。
 *
 * 目标：验证「仅凭摘要即可复现结构」——把摘要喂给重建器还原结构，与原始结构比对，输出匹配率。
 *
 * 说明：本任务不接模型，故 `reconstruct` 由调用方注入。当前提供基于摘要的朴素重建器
 * `reconstructFromSummary`（只用 skeleton + elementIndex 还原树）。接入模型后，把 `reconstruct`
 * 换成「模型根据摘要输出的 PageDsl」即可，evaluateFidelity 的评分逻辑无需改动。不发起任何网络请求。
 */

import type { CondensedSummary } from '../condenser';
import type { PageDsl, PageDslElement } from '../page-dsl';

/** 保真度评分结果 */
export interface FidelityReport {
  /** 加权匹配率（0–1） */
  matchRate: number;
  /** 原始有、复现缺失的元素 id */
  missing: string[];
  /** 复现有、原始没有的元素 id */
  extra: string[];
}

interface FlatNode {
  type: string;
  parentId: string | null;
  boundProps: string[];
}

/** 展平组件树为 id → {type, parentId, boundProps} */
function flattenPage(dsl: PageDsl): Map<string, FlatNode> {
  const out = new Map<string, FlatNode>();
  const walk = (node: PageDslElement, parentId: string | null): void => {
    out.set(node.id, {
      type: node.type,
      parentId,
      boundProps: node.bindings ? Object.keys(node.bindings) : [],
    });
    for (const child of node.children ?? []) walk(child, node.id);
  };
  walk(dsl.tree, null);
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}

/**
 * 评估保真度：比对「元素类型 + 父子关系 + 绑定字段」三维度加权匹配率。
 * @param reconstruct 由摘要重建 PageDsl 的函数（当前为朴素重建器，接模型后替换为模型输出）
 */
export function evaluateFidelity(
  original: PageDsl,
  summary: CondensedSummary,
  reconstruct: (summary: CondensedSummary) => PageDsl,
): FidelityReport {
  const recon = reconstruct(summary);
  const orig = flattenPage(original);
  const rec = flattenPage(recon);

  const missing: string[] = [];
  const extra: string[] = [];

  const W_TYPE = 0.4;
  const W_PARENT = 0.4;
  const W_BOUND = 0.2;

  let score = 0;
  for (const [id, o] of orig) {
    const r = rec.get(id);
    if (!r) {
      missing.push(id);
      continue;
    }
    let s = 0;
    if (r.type === o.type) s += W_TYPE;
    if (r.parentId === o.parentId) s += W_PARENT;
    if (sameSet(r.boundProps, o.boundProps)) s += W_BOUND;
    score += s;
  }
  for (const id of rec.keys()) {
    if (!orig.has(id)) extra.push(id);
  }

  const matchRate = orig.size === 0 ? 1 : score / orig.size;
  return { matchRate, missing, extra };
}

/**
 * 朴素重建器：只用 skeleton 与 elementIndex 还原树。
 * elementIndex 已含 type / parentId / boundProps，因此可完整复现类型、父子关系与绑定字段。
 */
export function reconstructFromSummary(summary: CondensedSummary): PageDsl {
  const nodes = new Map<string, PageDslElement>();
  for (const id of Object.keys(summary.elementIndex)) {
    const info = summary.elementIndex[id];
    if (!info) continue;
    nodes.set(id, {
      id,
      type: info.type,
      bindings: Object.fromEntries(info.boundProps.map((p) => [p, p])) as Record<string, string>,
      featureRef: info.featureRef,
    });
  }

  const childrenOf = new Map<string, PageDslElement[]>();
  let rootId: string | null = null;
  for (const id of Object.keys(summary.elementIndex)) {
    const info = summary.elementIndex[id];
    if (!info) continue;
    const node = nodes.get(id);
    if (!node) continue;
    const parentId = info.parentId;
    if (parentId === null) {
      rootId = id;
      continue;
    }
    const arr = childrenOf.get(parentId) ?? [];
    arr.push(node);
    childrenOf.set(parentId, arr);
  }
  for (const [id, kids] of childrenOf) {
    const node = nodes.get(id);
    if (node) node.children = kids;
  }

  const root: PageDslElement =
    rootId && nodes.get(rootId) ? nodes.get(rootId)! : { id: 'synthetic-root', type: 'Container' };

  return {
    id: 'reconstructed',
    projectId: 'P?',
    name: 'reconstructed',
    platform: 'web',
    route: '/reconstructed',
    tree: root,
  };
}
