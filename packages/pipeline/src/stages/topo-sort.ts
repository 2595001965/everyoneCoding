/**
 * 拓扑排序（T5-05 要点 1 / FR-PIPE-08）。
 *
 * 纯函数、无 IO，供 S4 拆分（SplitModel）与 S5 生成队列共用。
 * - 边方向约定：`dependsOn` 是被依赖的上游节点；`from 依赖 to` 在图里记为 from→to；
 * - Kahn 算法 + 稳定序（同层按输入顺序），保证"依赖先于被依赖者"输出；
 * - 环检测：成环的节点不会出现在 order 里，单独返回环路清单（DFS 染色定位）。
 */

export interface TopoNode<T = unknown> {
  id: string;
  data?: T | undefined;
  /** 上游依赖 id 列表（可为空） */
  dependsOn: readonly string[];
}

export interface TopoSortResult {
  /** 拓扑序（无环部分的节点 id，按依赖约束排列） */
  order: string[];
  /** 环路（每个数组是一个环的节点 id 序列，按发现顺序） */
  cycles: string[][];
  /** 被环路阻塞、未能进入 order 的节点 id（order + blocked = 全部节点） */
  blocked: string[];
  /** 是否有环 */
  hasCycle: boolean;
}

/**
 * 对一组节点做拓扑排序。
 * 输入中 id 重复 / dependsOn 引用了不存在的节点时，视该依赖为已满足（宽容处理，
 * 因为拆分结果可能引用尚未注册的页面，见 s4-split 的说明）。
 */
export function topoSort<T>(nodes: readonly TopoNode<T>[]): TopoSortResult {
  const ids = new Set(nodes.map((node) => node.id));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    dependents.set(node.id, []);
  }
  // 重复 id：只统计一次入度，避免同一节点被多次推进
  const seenDeps = new Set<string>();
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) continue; // 悬空依赖视为已满足
      const key = `${node.id}\u0000${dep}`;
      if (seenDeps.has(key)) continue;
      seenDeps.add(key);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      const list = dependents.get(dep);
      if (list !== undefined) list.push(node.id);
    }
  }

  // Kahn：队列按输入顺序维护（稳定序）
  const queue: string[] = [];
  for (const node of nodes) {
    if ((inDegree.get(node.id) ?? 0) === 0) queue.push(node.id);
  }

  const order: string[] = [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    const next = dependents.get(id) ?? [];
    for (const child of next) {
      const degree = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, degree);
      if (degree === 0) queue.push(child);
    }
  }

  const blocked = nodes.filter((node) => !visited.has(node.id)).map((node) => node.id);
  const cycles = blocked.length > 0 ? findCycles(nodes) : [];
  return { order, cycles, blocked, hasCycle: blocked.length > 0 };
}

/** DFS 三色标记找环：返回所有环（每个环为一个节点 id 序列，起点即终点，不重复末尾） */
export function findCycles<T>(nodes: readonly TopoNode<T>[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    const deps = node.dependsOn.filter((dep) => nodes.some((candidate) => candidate.id === dep));
    adj.set(node.id, deps);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seenCycles = new Set<string>();

  for (const node of nodes) {
    if (color.get(node.id) === BLACK) continue;
    const dfs = (current: string): void => {
      color.set(current, GRAY);
      stack.push(current);
      for (const next of adj.get(current) ?? []) {
        const state = color.get(next) ?? WHITE;
        if (state === GRAY) {
          // 发现环：栈里从 next 到 current 的部分
          const startIndex = stack.indexOf(next);
          if (startIndex >= 0) {
            const cycle = stack.slice(startIndex);
            // 归一化：以环内最小 id 开头，便于去重
            const normalized = normalizeCycle(cycle);
            seenCycles.add(normalized.join('\u0000'));
          }
        } else if (state === WHITE) {
          dfs(next);
        }
      }
      stack.pop();
      color.set(current, BLACK);
    };
    dfs(node.id);
  }

  for (const key of seenCycles) cycles.push(key.split('\u0000'));
  return cycles;
}

function normalizeCycle(cycle: string[]): string[] {
  const minIndex = cycle.reduce((best, id, index) => (id < (cycle[best] ?? '') ? index : best), 0);
  return [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
}
