/**
 * 分层归档推导（FR-MEM-17）。
 *
 * 依据 PRD §M3 / §13.1 的分层示例：
 * - 页面一级（骨架/区块/状态/事件）→ page 记忆；
 * - 项目一级（模块划分/路由总表/全局数据模型）→ project 记忆；
 * - 功能一级（流程/接口清单/规则）→ feature 记忆。
 *
 * 层级归属由元素的 `featureRef` 与页面归属自动推导：页面内存在 featureRef 指向的功能时，
 * 把相关流程/接口沉到该 feature。`layerOverride` 传入时覆盖自动推导结果（对应"手动调整"）。
 */

import type { MemoryLayer } from '../domain/scope';
import type { CondensedSummary } from './condenser';
import type { PageDsl, PageDslElement } from './page-dsl';

/** 单条分层归属结果 */
export interface LayerAssignment {
  layer: MemoryLayer;
  payload: Record<string, unknown>;
}

/** 收集页面内全部 featureRef（去重、稳定排序） */
export function resolveFeatureRefs(dsl: PageDsl): string[] {
  const refs = new Set<string>();
  const walk = (node: PageDslElement): void => {
    if (node.featureRef) refs.add(node.featureRef);
    for (const child of node.children ?? []) walk(child);
  };
  walk(dsl.tree);
  return [...refs].sort();
}

/**
 * 推导分层归属。
 *
 * @param layerOverride 手动覆盖：为非空 MemoryLayer 时，所有归属统一改为该层（对应人工调整）。
 *                      缺省（undefined）或显式 null 均表示"使用自动推导"。
 */
export function deriveLayerAssignments(
  dsl: PageDsl,
  summary: CondensedSummary,
  options?: { layerOverride?: MemoryLayer | null },
): LayerAssignment[] {
  const assignments: LayerAssignment[] = [];

  // 页面一级：骨架 / 区块 / 状态 / 事件 / 接口依赖
  const pagePayload: Record<string, unknown> = {
    skeleton: summary.skeleton,
    blocks: summary.blocks,
    state: summary.state,
    events: summary.events,
    apiDeps: summary.apiDeps,
  };

  // 项目一级：路由总表 / 模块划分
  const projectPayload: Record<string, unknown> = {
    routes: [dsl.route],
    modules: resolveFeatureRefs(dsl),
  };

  // 功能一级：接口清单 / 事件流（每个被引用的 feature 一条）
  const featureRefs = resolveFeatureRefs(dsl);
  const featurePayloads: Record<string, unknown>[] = featureRefs.map((fid) => ({
    featureId: fid,
    featureName: fid,
    apis: dsl.apiDeps ?? [],
    events: summary.events,
    flow: summary.events.map((e) => e.trigger),
  }));

  assignments.push({ layer: 'page', payload: pagePayload });
  assignments.push({ layer: 'project', payload: projectPayload });
  for (const fp of featurePayloads) assignments.push({ layer: 'feature', payload: fp });

  // 手动覆盖
  const override = options?.layerOverride;
  if (override) {
    for (const a of assignments) a.layer = override;
  }

  return assignments;
}
