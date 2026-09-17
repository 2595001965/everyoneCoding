import { findCycles, topoSort } from './topo-sort';

/**
 * 依赖图（T5-05 要点 2 / FR-PIPE-08）。
 *
 * 边方向：`addEdge(from, to)` 表示 **from 依赖 to**（from 是下游 / 被依赖者 to 是上游）。
 * - `dependencies(id)`：id 的上游（id 依赖谁）；
 * - `dependents(id)`：id 的下游（谁依赖 id）—— 变更 id 时沿 dependents 正向传播；
 * - 环检测 DFS 染色（复用 topo-sort 的 findCycles）；
 * - 子图提取：给定一组节点，返回只含这些节点及其内部边的图。
 */

export interface GraphEdge {
  from: string;
  to: string;
}

export class DependencyGraph<T = unknown> {
  private readonly nodes = new Map<string, { id: string; data: T | undefined }>();
  /** from → [to]（from 依赖 to） */
  private readonly outgoing = new Map<string, string[]>();
  /** to → [from]（谁依赖 to） */
  private readonly incoming = new Map<string, string[]>();

  /* ------------------------------ 增删 ------------------------------ */

  addNode(id: string, data?: T | undefined): void {
    if (this.nodes.has(id)) {
      if (data !== undefined) {
        const existing = this.nodes.get(id);
        if (existing !== undefined) existing.data = data;
      }
      return;
    }
    this.nodes.set(id, { id, data });
    this.outgoing.set(id, []);
    this.incoming.set(id, []);
  }

  addEdge(from: string, to: string): void {
    if (from === to) return; // 自环无意义，忽略
    this.addNode(from);
    this.addNode(to);
    const list = this.outgoing.get(from);
    if (list !== undefined && !list.includes(to)) list.push(to);
    const back = this.incoming.get(to);
    if (back !== undefined && !back.includes(from)) back.push(from);
  }

  removeEdge(from: string, to: string): void {
    const list = this.outgoing.get(from);
    if (list !== undefined) {
      const index = list.indexOf(to);
      if (index >= 0) list.splice(index, 1);
    }
    const back = this.incoming.get(to);
    if (back !== undefined) {
      const index = back.indexOf(from);
      if (index >= 0) back.splice(index, 1);
    }
  }

  removeNode(id: string): void {
    this.nodes.delete(id);
    this.outgoing.delete(id);
    this.incoming.delete(id);
    // 清理其它节点的引用
    for (const [, list] of this.outgoing) {
      const index = list.indexOf(id);
      if (index >= 0) list.splice(index, 1);
    }
    for (const [, list] of this.incoming) {
      const index = list.indexOf(id);
      if (index >= 0) list.splice(index, 1);
    }
  }

  /** 合并多个节点为一个（SplitEditor 的"合并"）：被合并节点的边全部改接到新节点 */
  mergeNodes(ids: readonly string[], newId: string, data?: T | undefined): void {
    const idSet = new Set(ids.filter((id) => this.nodes.has(id)));
    if (idSet.size === 0) return;
    this.addNode(newId, data);

    for (const id of idSet) {
      // 出边：id 依赖谁 → newId 依赖谁
      for (const to of this.outgoing.get(id) ?? []) {
        if (!idSet.has(to) && to !== newId) this.addEdge(newId, to);
      }
      // 入边：谁依赖 id → 谁依赖 newId
      for (const from of this.incoming.get(id) ?? []) {
        if (!idSet.has(from) && from !== newId) this.addEdge(from, newId);
      }
    }
    for (const id of idSet) this.removeNode(id);
  }

  /** 拆分一个节点为多个（SplitEditor 的"拆分"）：原节点的出边/入边按 parts 分发 */
  splitNode(id: string, parts: readonly { id: string; data?: T | undefined }[]): void {
    if (!this.nodes.has(id) || parts.length === 0) return;
    const upstream = this.dependencies(id); // 原节点依赖谁
    const downstream = this.dependents(id); // 谁依赖原节点
    for (const part of parts) this.addNode(part.id, part.data);
    for (const part of parts) {
      for (const dep of upstream) this.addEdge(part.id, dep);
      for (const dep of downstream) this.addEdge(dep, part.id);
    }
    this.removeNode(id);
  }

  /* ------------------------------ 查询 ------------------------------ */

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  nodeData(id: string): T | undefined {
    return this.nodes.get(id)?.data;
  }

  nodeIds(): string[] {
    return [...this.nodes.keys()];
  }

  /** id 的上游（id 依赖谁，出边） */
  dependencies(id: string): string[] {
    return [...(this.outgoing.get(id) ?? [])];
  }

  /** id 的下游（谁依赖 id，入边） */
  dependents(id: string): string[] {
    return [...(this.incoming.get(id) ?? [])];
  }

  /**
   * 影响面：沿依赖边正向传播（含间接影响）。
   * 变更节点 id 后，所有直接或间接依赖它的节点都需要重新生成。
   * 返回结果按拓扑层序（先直接依赖，再间接），去重且不含自身。
   */
  allDependents(id: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>([id]);
    const queue = [...this.dependents(id)];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);
      result.push(current);
      for (const next of this.dependents(current)) {
        if (!visited.has(next)) queue.push(next);
      }
    }
    return result;
  }

  edges(): GraphEdge[] {
    const result: GraphEdge[] = [];
    for (const [from, list] of this.outgoing) {
      for (const to of list) result.push({ from, to });
    }
    return result;
  }

  /* ------------------------------ 拓扑与环 ------------------------------ */

  detectCycles(): string[][] {
    const nodes = this.nodeIds().map((id) => ({ id, dependsOn: this.dependencies(id) }));
    return findCycles(nodes);
  }

  hasCycle(): boolean {
    return this.detectCycles().length > 0;
  }

  /** 拓扑序（Kahn 稳定序）；有环时只含无环部分 */
  topoOrder(): string[] {
    const nodes = this.nodeIds().map((id) => ({ id, dependsOn: this.dependencies(id) }));
    return topoSort(nodes).order;
  }

  /* ------------------------------ 子图 ------------------------------ */

  /** 子图提取：只保留 ids 内的节点与两端都在 ids 内的边 */
  subgraph(ids: readonly string[]): DependencyGraph<T> {
    const graph = new DependencyGraph<T>();
    const idSet = new Set(ids.filter((id) => this.nodes.has(id)));
    for (const id of idSet) {
      const data = this.nodes.get(id)?.data;
      graph.addNode(id, data);
    }
    for (const edge of this.edges()) {
      if (idSet.has(edge.from) && idSet.has(edge.to)) graph.addEdge(edge.from, edge.to);
    }
    return graph;
  }
}
