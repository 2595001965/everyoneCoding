/**
 * 动作流节点图结构（T3-09）。
 *
 * 设计约束：
 * - `FlowNode` 是编辑器内部的图节点，必须能**无损映射**到 DSL 的 `ActionNode`
 *   （`nodeToAction` / `actionToNode` 互逆）。
 * - 五类动作的规范 `kind`：`navigate | request | assign | notify | branch`
 *   （面板显示「跳转 / 请求 / 赋值 / 提示 / 条件分支」），接受别名
 *   `setState / toast / navigateTo / call` 经 `normalizeActionKind` 归一化。
 * - 结构化条件表达式一律走 `shared/condition`，**禁止 eval**。
 */

import { createRandomIdFactory } from '../dsl/factory';
import {
  normalizeActionKind,
  type ActionKind,
  type ActionKindInput,
  type ActionNode,
} from '../dsl/types';
import { createCondition, type ConditionExpr } from '../shared/condition';

/** 编辑器内部的图节点（与 ActionNode 一一对应） */
export interface FlowNode {
  id: string;
  kind: ActionKind;
  /** 动作参数（路由 / 接口 / 状态名 / 提示文案 / 条件表达式等，按 kind 区分） */
  params: Record<string, unknown>;
  /** 顺序执行的下一个节点 */
  next?: string | null;
  /** kind=branch 时的真 / 假分支入口 */
  branchTrue?: string | null;
  branchFalse?: string | null;
  /** 是否异步（request 默认异步） */
  async?: boolean;
  /** 节点图上显示的自定义标题 */
  label?: string;
}

/** 节点规格：驱动面板渲染与默认值 */
export interface FlowNodeSpec {
  /** 中文显示名（面板文案） */
  label: string;
  /** 文本图标（emoji / 字符，不引图标库） */
  icon: string;
  /** 新建节点时的默认参数 */
  defaultParams: Record<string, unknown>;
  /** 必填参数键（校验用） */
  requiredParams: string[];
  /** 该类型默认是否异步 */
  asyncByDefault: boolean;
}

export const ACTION_LABELS: Record<ActionKind, string> = {
  navigate: '跳转',
  request: '请求',
  assign: '赋值',
  notify: '提示',
  branch: '条件分支',
};

/** 五类节点的规格表 */
export const FLOW_NODE_SPECS: Record<ActionKind, FlowNodeSpec> = {
  navigate: {
    label: '跳转',
    icon: '➡',
    defaultParams: { route: '', params: {} },
    requiredParams: ['route'],
    asyncByDefault: false,
  },
  request: {
    label: '请求',
    icon: '⤴',
    defaultParams: { api: '', method: 'POST', body: {} },
    requiredParams: ['api'],
    asyncByDefault: true,
  },
  assign: {
    label: '赋值',
    icon: '✎',
    defaultParams: { name: '', value: '' },
    requiredParams: ['name'],
    asyncByDefault: false,
  },
  notify: {
    label: '提示',
    icon: '💬',
    defaultParams: { type: 'info', message: '' },
    requiredParams: ['message'],
    asyncByDefault: false,
  },
  branch: {
    label: '条件分支',
    icon: '⑂',
    defaultParams: { expression: { op: 'eq', left: '', right: '' } as ConditionExpr },
    requiredParams: ['expression'],
    asyncByDefault: false,
  },
};

let idFactory: (() => string) | null = null;
function nextId(): string {
  if (idFactory === null) idFactory = createRandomIdFactory('flow');
  return idFactory();
}

/** FlowNode → ActionNode（无损映射） */
export function nodeToAction(node: FlowNode): ActionNode {
  const action: ActionNode = { id: node.id, kind: node.kind };
  if (node.label !== undefined) action.label = node.label;
  if (node.async !== undefined) action.async = node.async;

  switch (node.kind) {
    case 'navigate': {
      const route = typeof node.params.route === 'string' ? node.params.route : '';
      if (route.length > 0) action.target = route;
      const routeParams = node.params.params;
      if (
        routeParams &&
        typeof routeParams === 'object' &&
        Object.keys(routeParams as object).length > 0
      ) {
        action.params = { ...(routeParams as Record<string, unknown>) };
      }
      break;
    }
    case 'request': {
      const api = typeof node.params.api === 'string' ? node.params.api : '';
      if (api.length > 0) action.target = api;
      const params: Record<string, unknown> = {};
      if (node.params.body !== undefined && node.params.body !== null)
        params.body = node.params.body;
      if (typeof node.params.method === 'string') params.method = node.params.method;
      if (node.params.headers !== undefined && node.params.headers !== null)
        params.headers = node.params.headers;
      if (Object.keys(params).length > 0) action.params = params;
      break;
    }
    case 'assign': {
      const name = typeof node.params.name === 'string' ? node.params.name : '';
      if (name.length > 0) action.target = name;
      action.value = node.params.value;
      break;
    }
    case 'notify': {
      const type = typeof node.params.type === 'string' ? node.params.type : 'info';
      action.params = { type };
      action.value = node.params.message;
      break;
    }
    case 'branch': {
      const expr = node.params.expression as ConditionExpr | undefined;
      action.params = { expression: expr ?? createCondition('eq') };
      break;
    }
  }

  if (node.next !== undefined) action.next = node.next;
  if (node.branchTrue !== undefined) action.branchTrue = node.branchTrue;
  if (node.branchFalse !== undefined) action.branchFalse = node.branchFalse;
  return action;
}

/** ActionNode → FlowNode（无损映射） */
export function actionToNode(action: ActionNode): FlowNode {
  const kind = normalizeActionKind(action.kind as ActionKindInput);
  const spec = FLOW_NODE_SPECS[kind];
  const node: FlowNode = { id: action.id, kind, params: { ...spec.defaultParams } };

  switch (kind) {
    case 'navigate':
      node.params.route = typeof action.target === 'string' ? action.target : '';
      node.params.params = action.params ?? {};
      break;
    case 'request':
      node.params.api = typeof action.target === 'string' ? action.target : '';
      node.params.body = action.params?.['body'];
      node.params.method =
        typeof action.params?.['method'] === 'string'
          ? (action.params?.['method'] as string)
          : 'POST';
      node.params.headers = action.params?.['headers'];
      break;
    case 'assign':
      node.params.name = typeof action.target === 'string' ? action.target : '';
      node.params.value = action.value;
      break;
    case 'notify':
      node.params.type =
        typeof action.params?.['type'] === 'string' ? (action.params?.['type'] as string) : 'info';
      node.params.message = action.value;
      break;
    case 'branch':
      node.params.expression =
        (action.params?.['expression'] as ConditionExpr | undefined) ?? createCondition('eq');
      break;
  }

  if (action.label !== undefined) node.label = action.label;
  if (action.async !== undefined) node.async = action.async;
  else if (spec.asyncByDefault) node.async = true;
  if (action.next !== undefined) node.next = action.next;
  if (action.branchTrue !== undefined) node.branchTrue = action.branchTrue;
  if (action.branchFalse !== undefined) node.branchFalse = action.branchFalse;
  return node;
}

export interface CreateFlowNodeOptions {
  id?: string;
  label?: string;
  params?: Record<string, unknown>;
  async?: boolean;
  next?: string | null;
  branchTrue?: string | null;
  branchFalse?: string | null;
}

/** 创建单个节点（带规范默认值），接受别名 kind */
export function createFlowNode(
  kind: ActionKindInput,
  options: CreateFlowNodeOptions = {},
): FlowNode {
  const normalized = normalizeActionKind(kind);
  const spec = FLOW_NODE_SPECS[normalized];
  const node: FlowNode = {
    id: options.id ?? nextId(),
    kind: normalized,
    params: { ...spec.defaultParams, ...(options.params ?? {}) },
  };
  if (options.label !== undefined) node.label = options.label;
  if (options.async !== undefined) node.async = options.async;
  else if (spec.asyncByDefault) node.async = true;
  if (options.next !== undefined) node.next = options.next;
  if (options.branchTrue !== undefined) node.branchTrue = options.branchTrue;
  if (options.branchFalse !== undefined) node.branchFalse = options.branchFalse;
  return node;
}

/** 创建空流 */
export function createEmptyFlow(): FlowNode[] {
  return [];
}

/** 序列化：FlowNode[] → ActionNode[] */
export function serializeFlow(nodes: readonly FlowNode[]): ActionNode[] {
  return nodes.map((node) => nodeToAction(node));
}

/** 反序列化：ActionNode[] → FlowNode[] */
export function parseFlow(actions: readonly ActionNode[]): FlowNode[] {
  return actions.map((action) => actionToNode(action));
}
