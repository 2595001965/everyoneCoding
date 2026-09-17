/**
 * 结构精简器核心：把 PageDSL 精简为「逻辑结构摘要」CondensedSummary。
 *
 * 摘要只保留 AI 复现结构所需的保真信息：组件类型、层级、绑定字段、事件目标、接口依赖，
 * 全面剥离样式与装饰细节，从而把单页面控制在 ≤2k tokens（见 token-estimator）。
 */

import type { PageDsl, PageDslAction, PageDslElement } from './page-dsl';
import { DEFAULT_CONDENSER_RULES, mergeRules, type CondenserRules } from './rules';

/** 精简后的逻辑结构摘要 */
export interface CondensedSummary {
  /** 紧凑嵌套字符串表达的组件树，不含任何样式信息 */
  skeleton: string;
  /** 页面级区块：直接子节点的 id / 类型 / 直接子节点数 */
  blocks: Array<{ id: string; type: string; children: number }>;
  /** 页面状态变量 */
  state: Array<{ name: string; type: string; source?: 'local' | 'api' }>;
  /** 事件流：触发器 + 动作文本 */
  events: Array<{ trigger: string; actions: string[] }>;
  /** 数据流：绑定（属性→状态/接口字段）与 api 来源状态 */
  dataFlow: Array<{ from: string; to: string; field?: string }>;
  /** 汇总后的接口依赖 */
  apiDeps: string[];
  /** 元素索引：保真度关键，AI 仅凭它即可重建类型/父子/绑定/接口 */
  elementIndex: Record<string, { type: string; parentId: string | null; boundProps: string[]; featureRef: string | null }>;
  /** 是否发生过深度截断（或预算裁剪，见 token-estimator） */
  truncated: boolean;
}

/** 把动作转为可读文本，用于事件摘要 */
function actionToString(action: PageDslAction): string {
  switch (action.kind) {
    case 'navigate':
      return action.target ? `navigate:${action.target}` : 'navigate';
    case 'request':
      return action.target ? `request:${action.target}` : 'request';
    case 'assign':
      return action.value !== undefined ? `assign:${String(action.value)}` : 'assign';
    case 'notify':
      return action.value !== undefined ? `notify:${String(action.value)}` : 'notify';
    case 'branch':
      return action.target ? `branch:${action.target}` : 'branch';
  }
}

interface WalkCtx {
  rules: CondenserRules;
  index: CondensedSummary['elementIndex'];
  truncated: boolean;
}

/** 深度有限地渲染 skeleton，并填充 elementIndex；超出 maxDepth 的子树折叠为占位 */
function renderSkeleton(node: PageDslElement, parentId: string | null, depth: number, ctx: WalkCtx): string {
  if (depth > ctx.rules.maxDepth) {
    ctx.truncated = true;
    return '…(深度截断)';
  }
  ctx.index[node.id] = {
    type: node.type,
    parentId,
    boundProps: node.bindings ? Object.keys(node.bindings) : [],
    featureRef: node.featureRef ?? null,
  };
  const label = node.name ? `${node.type}(${node.name})` : node.type;
  const children = node.children ?? [];
  if (children.length === 0) return label;
  const parts = children.map((child) => renderSkeleton(child, node.id, depth + 1, ctx));
  return `${label}[${parts.join(', ')}]`;
}

/** 收集全部元素（完整树，不受 maxDepth 限制），用于 bindings / featureRef / apiDeps 推导 */
function collectAll(node: PageDslElement): PageDslElement[] {
  const out: PageDslElement[] = [node];
  for (const child of node.children ?? []) out.push(...collectAll(child));
  return out;
}

/**
 * 精简页面 DSL 为逻辑结构摘要。
 * @param rules 精简规则，缺省使用 DEFAULT_CONDENSER_RULES
 */
export function condensePage(dsl: PageDsl, rules?: CondenserRules): CondensedSummary {
  const merged = rules ? mergeRules(rules) : DEFAULT_CONDENSER_RULES;
  const ctx: WalkCtx = { rules: merged, index: {}, truncated: false };
  const skeleton = renderSkeleton(dsl.tree, null, 0, ctx);

  const all = collectAll(dsl.tree);

  const blocks: CondensedSummary['blocks'] = (dsl.tree.children ?? []).map((child) => ({
    id: child.id,
    type: child.type,
    children: (child.children ?? []).length,
  }));

  const state: CondensedSummary['state'] = (dsl.state ?? []).map((s) => {
    const entry: { name: string; type: string; source?: 'local' | 'api' } = { name: s.name, type: s.type };
    if (s.source) entry.source = s.source;
    return entry;
  });

  const events: CondensedSummary['events'] = (dsl.events ?? []).map((ev) => ({
    trigger: ev.trigger,
    actions: ev.actions.map(actionToString),
  }));

  const dataFlow: CondensedSummary['dataFlow'] = [];
  for (const el of all) {
    if (el.bindings) {
      for (const [prop, target] of Object.entries(el.bindings)) {
        dataFlow.push({ from: el.id, to: target, field: prop });
      }
    }
  }
  for (const s of dsl.state ?? []) {
    if (s.source === 'api') dataFlow.push({ from: 'api', to: s.name });
  }

  const apiSet = new Set<string>();
  for (const dep of dsl.apiDeps ?? []) apiSet.add(dep);
  for (const ev of dsl.events ?? []) {
    for (const act of ev.actions) {
      if (act.kind === 'request' && act.target) apiSet.add(act.target);
    }
  }
  const apiDeps = [...apiSet];

  return {
    skeleton,
    blocks,
    state,
    events,
    dataFlow,
    apiDeps,
    elementIndex: ctx.index,
    truncated: ctx.truncated,
  };
}
