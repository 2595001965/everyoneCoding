/**
 * 动作流校验器（T3-09）。
 *
 * 必须能报出：
 * - MISSING_REQUIRED_PARAM  缺必填参数（按 FLOW_NODE_SPECS.requiredParams）
 * - TARGET_PAGE_NOT_FOUND   navigate 目标页面不存在
 * - API_NOT_DEFINED        request 引用的接口不在 knownApis
 * - ORPHAN_NODE            孤立节点（除入口外无入边）
 * - CYCLIC_BRANCH          条件分支回环（允许但必须标注 warning，并返回参与环的节点 id）
 * 另含：EMPTY_BRANCH（条件节点缺一侧分支）、STATE_NOT_FOUND（assign 引用的状态不存在）。
 */

import type { RouteEntry } from '../dsl/types';
import { parseCondition, type ConditionExpr } from '../shared/condition';
import { FLOW_NODE_SPECS, type FlowNode } from './flow-schema';

export type FlowIssueCode =
  | 'MISSING_REQUIRED_PARAM'
  | 'TARGET_PAGE_NOT_FOUND'
  | 'API_NOT_DEFINED'
  | 'ORPHAN_NODE'
  | 'CYCLIC_BRANCH'
  | 'EMPTY_BRANCH'
  | 'STATE_NOT_FOUND';

export type FlowIssueSeverity = 'error' | 'warning';

export interface FlowIssue {
  code: FlowIssueCode;
  /** 关联节点 id（存在时） */
  nodeId?: string;
  message: string;
  severity: FlowIssueSeverity;
  /** 参与环的节点 id（仅 CYCLIC_BRANCH 填充） */
  participants?: string[];
}

export interface ValidateFlowInput {
  nodes: readonly FlowNode[];
  /** 入口节点 id（缺省取第一个节点） */
  entry?: string;
  /** 已知页面路由 / id，用于 navigate 目标存在性校验 */
  pageIds?: readonly string[];
  /** 已知路由表（RouteEntry），优先用于 navigate 目标存在性校验 */
  routes?: readonly RouteEntry[];
  /** 已知接口清单（apiDeps / 接口目录），用于 request 校验 */
  knownApis?: readonly string[];
  /** 已知页面状态名，用于 assign 校验 */
  stateNames?: readonly string[];
}

/** 收集所有出边（next / branchTrue / branchFalse） */
function collectEdges(nodes: readonly FlowNode[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const node of nodes) {
    const outs: string[] = [];
    if (node.next) outs.push(node.next);
    if (node.branchTrue) outs.push(node.branchTrue);
    if (node.branchFalse) outs.push(node.branchFalse);
    map.set(node.id, outs);
  }
  return map;
}

/** 找出孤立节点（除入口外，没有任何入边） */
export function findOrphanNodes(nodes: readonly FlowNode[], entry?: string): string[] {
  const entryId = entry ?? nodes[0]?.id;
  const referenced = new Set<string>();
  for (const node of nodes) {
    if (node.next) referenced.add(node.next);
    if (node.branchTrue) referenced.add(node.branchTrue);
    if (node.branchFalse) referenced.add(node.branchFalse);
  }
  return nodes.filter((node) => node.id !== entryId && !referenced.has(node.id)).map((node) => node.id);
}

/** 检测回环，返回参与任一环的全部节点 id（深度优先，标记递归栈中的回边） */
export function detectCycles(nodes: readonly FlowNode[]): string[] {
  const edges = collectEdges(nodes);
  const ids = nodes.map((node) => node.id);
  const inCycle = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dfs = (id: string, stack: string[]): void => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      if (start >= 0) for (let index = start; index < stack.length; index += 1) inCycle.add(stack[index]!);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const next of edges.get(id) ?? []) dfs(next, stack);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of ids) dfs(id, []);
  return Array.from(inCycle);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 校验动作流，返回全部问题（无问题返回空数组） */
export function validateFlow(input: ValidateFlowInput): FlowIssue[] {
  const { nodes, entry, pageIds, routes, knownApis, stateNames } = input;
  const issues: FlowIssue[] = [];

  const validTargets = new Set<string>();
  if (routes) for (const route of routes) validTargets.add(route.path);
  if (pageIds) for (const id of pageIds) validTargets.add(id);
  const apiSet = knownApis ? new Set(knownApis) : null;
  const stateSet = stateNames ? new Set(stateNames) : null;

  for (const node of nodes) {
    const spec = FLOW_NODE_SPECS[node.kind];

    // 必填参数
    for (const key of spec.requiredParams) {
      const value = node.params[key];
      if (node.kind === 'branch') {
        const expr = value as ConditionExpr | undefined;
        if (parseCondition(expr) === null) {
          issues.push({
            code: 'MISSING_REQUIRED_PARAM',
            nodeId: node.id,
            message: `节点「${node.label ?? node.id}」缺少合法的条件表达式`,
            severity: 'error',
          });
        }
      } else if (!isNonEmptyString(value)) {
        issues.push({
          code: 'MISSING_REQUIRED_PARAM',
          nodeId: node.id,
          message: `节点「${node.label ?? node.id}」缺少必填参数「${key}」`,
          severity: 'error',
        });
      }
    }

    // 各类型专属校验
    switch (node.kind) {
      case 'navigate': {
        const target = typeof node.params.route === 'string' ? node.params.route : '';
        if (target.length > 0 && validTargets.size > 0 && !validTargets.has(target)) {
          issues.push({
            code: 'TARGET_PAGE_NOT_FOUND',
            nodeId: node.id,
            message: `跳转目标页面「${target}」不存在`,
            severity: 'error',
          });
        }
        break;
      }
      case 'request': {
        const target = typeof node.params.api === 'string' ? node.params.api : '';
        if (target.length > 0 && apiSet !== null && !apiSet.has(target)) {
          issues.push({
            code: 'API_NOT_DEFINED',
            nodeId: node.id,
            message: `请求接口「${target}」未在已知接口清单中定义`,
            severity: 'error',
          });
        }
        break;
      }
      case 'assign': {
        const name = typeof node.params.name === 'string' ? node.params.name : '';
        if (name.length > 0 && stateSet !== null && !stateSet.has(name)) {
          issues.push({
            code: 'STATE_NOT_FOUND',
            nodeId: node.id,
            message: `赋值目标状态「${name}」不存在`,
            severity: 'error',
          });
        }
        break;
      }
      case 'branch': {
        if (node.branchTrue === undefined || node.branchTrue === null) {
          issues.push({
            code: 'EMPTY_BRANCH',
            nodeId: node.id,
            message: `条件分支节点缺少「真」分支`,
            severity: 'warning',
          });
        }
        if (node.branchFalse === undefined || node.branchFalse === null) {
          issues.push({
            code: 'EMPTY_BRANCH',
            nodeId: node.id,
            message: `条件分支节点缺少「假」分支`,
            severity: 'warning',
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // 孤立节点
  for (const id of findOrphanNodes(nodes, entry)) {
    const node = nodes.find((n) => n.id === id);
    issues.push({
      code: 'ORPHAN_NODE',
      nodeId: id,
      message: `节点「${node?.label ?? id}」是孤立节点（除入口外没有任何入边）`,
      severity: 'error',
    });
  }

  // 回环（允许，标注为 warning，并列出参与环的节点）
  const cyclic = detectCycles(nodes);
  if (cyclic.length > 0) {
    issues.push({
      code: 'CYCLIC_BRANCH',
      ...(cyclic[0] !== undefined ? { nodeId: cyclic[0] } : {}),
      message: `检测到条件分支回环（允许执行但需注意死循环），参与环的节点：${cyclic.join(' → ')}`,
      severity: 'warning',
      participants: cyclic,
    });
  }

  return issues;
}
