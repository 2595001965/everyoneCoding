/**
 * 动作流执行引擎（T3-09）。
 *
 * 执行顺序**严格按 next / branchTrue / branchFalse 串联**（不按数组顺序盲走）：
 * - branch 用 `evaluateCondition(params.expression, scope)` 决定走真 / 假分支；
 * - request 默认异步：`await ports.requester.request(...)`，缺省 requester 时返回失败并给出中文原因；
 *   其余动作同步执行；
 * - assign 把结果写回 StateStore；notify 调 ports.notify；navigate 调 ports.navigate；
 * - **防死循环**：同一节点访问超过 N 次（默认 20）即中断并返回 status:'aborted'。
 */

import type { ActionNode } from '../dsl/types';
import { resolveExpression } from '../shared/expression';
import { evaluateCondition, type ConditionExpr } from '../shared/condition';
import type { FlowRuntimePorts, IRequester } from '../store/ports';
import type { StateStore } from '../state/StateStore';

export interface FlowNotification {
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

export interface FlowNavigation {
  path: string;
  params?: Record<string, unknown>;
}

export interface FlowRunResult {
  status: 'success' | 'failed' | 'aborted';
  /** 实际访问过的节点 id（按执行先后） */
  visited: string[];
  /** 执行结束时的状态快照 */
  state: Record<string, unknown>;
  error?: string;
  notifications: FlowNotification[];
  navigations: FlowNavigation[];
}

export interface FlowRunContext {
  /** 触发元素 id */
  triggerElementId?: string;
  /** 外部注入的作用域（与页面状态合并后作为条件求值 / 取值依据） */
  scope?: Record<string, unknown>;
  /** 入口节点 id（缺省自动推断为无入边的根节点） */
  entry?: string;
}

export interface CreateFlowRuntimeOptions {
  store: StateStore;
  ports: FlowRuntimePorts;
  /** 时钟（测试可控），当前实现未强制使用 */
  clock?: () => number;
  /** 单节点最大访问次数，超过即判定死循环，默认 20 */
  maxVisits?: number;
}

/** 把值按当前作用域解析：字符串走模板 / 路径解析，其余原样返回 */
function resolveValue(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === 'string') return resolveExpression(value, scope);
  return value;
}

/** 深度解析对象 / 数组中的字符串模板（用于 request 入参映射） */
function resolveDeep(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === 'string') return resolveExpression(value, scope);
  if (Array.isArray(value)) return value.map((item) => resolveDeep(item, scope));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveDeep(val, scope);
    }
    return out;
  }
  return value;
}

export interface FlowRuntime {
  execute(actions: readonly ActionNode[], context?: FlowRunContext): Promise<FlowRunResult>;
}

/** 创建动作流执行引擎 */
export function createFlowRuntime(options: CreateFlowRuntimeOptions): FlowRuntime {
  const { store, ports, maxVisits = 20 } = options;
  const requester: IRequester | undefined = ports.requester;

  function inferEntry(actions: readonly ActionNode[]): string | undefined {
    if (actions.length === 0) return undefined;
    const referenced = new Set<string>();
    for (const action of actions) {
      if (action.next) referenced.add(action.next);
      if (action.branchTrue) referenced.add(action.branchTrue);
      if (action.branchFalse) referenced.add(action.branchFalse);
    }
    const root = actions.find((action) => !referenced.has(action.id));
    return root?.id ?? actions[0]!.id;
  }

  async function execute(
    actions: readonly ActionNode[],
    context: FlowRunContext = {},
  ): Promise<FlowRunResult> {
    const result: FlowRunResult = {
      status: 'success',
      visited: [],
      state: {},
      notifications: [],
      navigations: [],
    };

    if (actions.length === 0) {
      result.state = store.snapshot();
      return result;
    }

    const byId = new Map<string, ActionNode>();
    for (const action of actions) byId.set(action.id, action);

    let scope: Record<string, unknown> = context.scope
      ? { ...context.scope, ...store.snapshot() }
      : { ...store.snapshot() };

    const visitCount = new Map<string, number>();
    let current: string | undefined = context.entry ?? inferEntry(actions);

    while (current) {
      const node = byId.get(current);
      if (node === undefined) {
        result.error = `执行中断：找不到节点 ${current}`;
        result.status = 'failed';
        break;
      }

      const seen = (visitCount.get(current) ?? 0) + 1;
      visitCount.set(current, seen);
      if (seen > maxVisits) {
        result.error = `检测到疑似死循环：节点「${node.label ?? current}」被执行超过 ${maxVisits} 次，已中断`;
        result.status = 'aborted';
        break;
      }
      result.visited.push(current);

      let nextPointer: string | null | undefined;

      try {
        switch (node.kind) {
          case 'assign': {
            const name = node.target;
            if (name) {
              const resolved = resolveValue(node.value, scope);
              store.set(name, resolved);
              scope = { ...store.snapshot() };
            }
            break;
          }
          case 'request': {
            if (!requester) {
              result.error =
                '请求动作缺少可用的 requester（预览 / 运行时未注入数据流），无法执行请求';
              result.status = 'failed';
              break;
            }
            const url = typeof node.target === 'string' ? node.target : '';
            const body = node.params?.['body'];
            const resolvedBody = body !== undefined ? resolveDeep(body, scope) : undefined;
            const method =
              typeof node.params?.['method'] === 'string'
                ? (node.params?.['method'] as string)
                : 'POST';
            const headers = node.params?.['headers'] as Record<string, string> | undefined;
            const response = await requester.request({
              url,
              method,
              ...(headers !== undefined ? { headers } : {}),
              ...(resolvedBody !== undefined ? { body: resolvedBody } : {}),
            });
            scope = { ...store.snapshot(), response: response.data };
            break;
          }
          case 'notify': {
            const type = (node.params?.['type'] as FlowNotification['type']) ?? 'info';
            const message = String(resolveValue(node.value, scope) ?? '');
            ports.notify?.({ type, message });
            result.notifications.push({ type, message });
            break;
          }
          case 'navigate': {
            const path = String(resolveValue(node.target, scope) ?? '');
            const params = node.params?.['params']
              ? (resolveDeep(node.params?.['params'], scope) as Record<string, unknown> | undefined)
              : undefined;
            ports.navigate?.(
              ...((params !== undefined ? [path, params] : [path]) as [
                string,
                Record<string, unknown>?,
              ]),
            );
            result.navigations.push({ path, ...(params !== undefined ? { params } : {}) });
            break;
          }
          case 'branch': {
            const expr = (node.params?.['expression'] as ConditionExpr | undefined) ?? null;
            const truthy = evaluateCondition(expr, scope);
            nextPointer = truthy ? node.branchTrue : node.branchFalse;
            break;
          }
        }
      } catch (error) {
        result.error = `执行节点「${node.label ?? current}」出错：${error instanceof Error ? error.message : String(error)}`;
        result.status = 'failed';
        break;
      }

      if (result.status !== 'success') break;

      if (node.kind !== 'branch') nextPointer = node.next;
      current = nextPointer ?? undefined;
    }

    result.state = store.snapshot();
    return result;
  }

  return { execute };
}
