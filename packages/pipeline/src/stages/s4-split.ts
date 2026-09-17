import { DependencyGraph } from './dependency-graph';

/**
 * S4 功能与页面拆分（T5-05 / FR-PIPE-08 / FR-PIPE-12）。
 *
 * 结构：功能单元（feature）↔ 页面单元（page）双向引用 + 跨单元依赖边。
 * - `SplitResult` 是**纯数据**（可从技术文档规则解析、也可手动构造），
 *   状态机与 UI 共用；
 * - `SplitModel` 是可变图模型：手动调整（增删边 / 合并 / 拆分）后重算拓扑与环，
 *   并提供 `evaluateImpact`（T5-02 补充需求与 T7 重命名的消费方）；
 * - 拆分解析用**规则**而非 AI：技术文档中 `## 功能：xxx` / `### 页面：xxx` 的标题
 *   约定即拆分依据（规则稳定、可测试、无网络依赖）；`## 依赖` 段声明跨单元边。
 */

export interface FeatureUnit {
  id: string;
  name: string;
  /** 属于该功能的页面 id（页面也可独立于功能存在） */
  pageIds: string[];
  /** 依赖的上游功能 id */
  dependsOn: string[];
}

export interface PageUnit {
  id: string;
  name: string;
  featureId: string | null;
  /** 依赖的上游页面 / 功能 id */
  dependsOn: string[];
  route: string | null;
}

export interface SplitResult {
  features: FeatureUnit[];
  pages: PageUnit[];
}

/** 影响面评估的变更类型（T5-02 补充需求 / T7 重命名共用） */
export type ImpactType = 'requirement' | 'techdoc' | 'rename' | 'supplement';

export interface ImpactRequest {
  type: ImpactType;
  /** 受影响的节点 id（功能或页面） */
  targets: string[];
}

export interface ImpactReport {
  /** 直接受影响的节点（targets 本身，若存在） */
  direct: string[];
  /** 沿依赖边正向传播的间接影响（不含 direct） */
  indirect: string[];
  /** 全部需重新生成的节点（direct + indirect，按拓扑层序） */
  affected: string[];
  /** 每个受影响节点的传播路径（供 UI 高亮展示） */
  paths: Record<string, string[]>;
}

/* ------------------------------ 拆分模型 ------------------------------ */

/** 图节点附加数据：便于 UI 展示类型与状态 */
export interface SplitNodeData {
  kind: 'feature' | 'page';
  name: string;
}

export class SplitModel {
  private readonly graph: DependencyGraph<SplitNodeData>;
  private readonly features = new Map<string, FeatureUnit>();
  private readonly pages = new Map<string, PageUnit>();

  private constructor(graph: DependencyGraph<SplitNodeData>, features: FeatureUnit[], pages: PageUnit[]) {
    this.graph = graph;
    for (const feature of features) this.features.set(feature.id, { ...feature, dependsOn: [...feature.dependsOn], pageIds: [...feature.pageIds] });
    for (const page of pages) this.pages.set(page.id, { ...page, dependsOn: [...page.dependsOn] });
  }

  static fromResult(result: SplitResult): SplitModel {
    const graph = new DependencyGraph<SplitNodeData>();
    for (const feature of result.features) {
      graph.addNode(feature.id, { kind: 'feature', name: feature.name });
    }
    for (const page of result.pages) {
      graph.addNode(page.id, { kind: 'page', name: page.name });
    }
    // 功能内部页面 → 功能（页面依赖其所属功能）
    for (const feature of result.features) {
      for (const pageId of feature.pageIds) {
        if (graph.has(pageId)) graph.addEdge(pageId, feature.id);
      }
    }
    // 功能依赖
    for (const feature of result.features) {
      for (const dep of feature.dependsOn) {
        if (graph.has(dep)) graph.addEdge(feature.id, dep);
      }
    }
    // 页面依赖（页面 A 依赖页面 B / 功能 B）
    for (const page of result.pages) {
      for (const dep of page.dependsOn) {
        if (graph.has(dep)) graph.addEdge(page.id, dep);
      }
    }
    return new SplitModel(graph, result.features, result.pages);
  }

  static empty(): SplitModel {
    return SplitModel.fromResult({ features: [], pages: [] });
  }

  /** 底层图（UI 可视化与外部工具直接消费） */
  graphRef(): DependencyGraph<SplitNodeData> {
    return this.graph;
  }

  result(): SplitResult {
    return {
      features: [...this.features.values()].map((f) => ({ ...f, pageIds: [...f.pageIds], dependsOn: [...f.dependsOn] })),
      pages: [...this.pages.values()].map((p) => ({ ...p, dependsOn: [...p.dependsOn] })),
    };
  }

  featureCount(): number {
    return this.features.size;
  }

  pageCount(): number {
    return this.pages.size;
  }

  nodeIds(): string[] {
    return this.graph.nodeIds();
  }

  /* ------------------------------ 手动调整 ------------------------------ */

  addEdge(from: string, to: string): void {
    this.graph.addEdge(from, to);
  }

  removeEdge(from: string, to: string): void {
    this.graph.removeEdge(from, to);
  }

  /** 合并多个页面 / 功能为一个功能单元（多页面合并为一个功能） */
  mergeNodes(ids: readonly string[], newFeature: { id: string; name: string }): void {
    const idSet = ids.filter((id) => this.graph.has(id));
    if (idSet.length === 0) return;
    // 记录被合并页面所属功能，便于回填 pageIds
    const mergedPageIds = idSet.filter((id) => this.pages.has(id));
    const mergedFeatureIds = idSet.filter((id) => this.features.has(id));
    for (const id of mergedFeatureIds) this.features.delete(id);
    for (const id of mergedPageIds) this.pages.delete(id);

    this.graph.mergeNodes(idSet, newFeature.id, { kind: 'feature', name: newFeature.name });
    const feature: FeatureUnit = {
      id: newFeature.id,
      name: newFeature.name,
      pageIds: mergedPageIds,
      dependsOn: this.graph.dependencies(newFeature.id),
    };
    this.features.set(newFeature.id, feature);
  }

  /** 拆分一个功能为多个功能单元 */
  splitFeature(featureId: string, parts: readonly { id: string; name: string }[]): void {
    if (!this.features.has(featureId) || parts.length === 0) return;
    const original = this.features.get(featureId);
    if (original === undefined) return;
    // 页面归属：第一个 part 承接原页面的 featureId，其余页面标记为空归属
    const pageIds = original.pageIds;
    const first = parts[0];
    if (first !== undefined) {
      const feature: FeatureUnit = { id: first.id, name: first.name, pageIds: [...pageIds], dependsOn: original.dependsOn };
      this.features.set(first.id, feature);
    }
    for (const part of parts.slice(1)) {
      const feature: FeatureUnit = { id: part.id, name: part.name, pageIds: [], dependsOn: original.dependsOn };
      this.features.set(part.id, feature);
    }
    for (const pageId of pageIds) {
      const page = this.pages.get(pageId);
      if (page !== undefined) {
        this.pages.set(pageId, { ...page, featureId: first?.id ?? null });
      }
    }
    this.graph.splitNode(
      featureId,
      parts.map((part) => ({ id: part.id, data: { kind: 'feature' as const, name: part.name } })),
    );
    this.features.delete(featureId);
  }

  /* ------------------------------ 拓扑与环 ------------------------------ */

  topoOrder(): string[] {
    return this.graph.topoOrder();
  }

  /** 环检测：返回环路清单；UI 据此阻断并高亮 */
  detectCycles(): string[][] {
    return this.graph.detectCycles();
  }

  hasCycle(): boolean {
    return this.graph.hasCycle();
  }

  /* ------------------------------ 影响面评估 ------------------------------ */

  /**
   * 影响面评估（T5-02 / T7 消费）：
   * - direct = targets 中存在的节点 + **归属链补全**（页面的变更影响其所属功能；
   *   功能的变更影响其全部页面 —— 语义直觉与 UI 高亮一致）；
   * - indirect = 沿依赖边正向传播（含间接影响）；
   * - 传播路径记录供 UI 高亮（direct 的路径是 [自身]）。
   */
  evaluateImpact(change: ImpactRequest): ImpactReport {
    const direct: string[] = [];
    const seen = new Set<string>();
    for (const target of change.targets) {
      if (!this.graph.has(target) || seen.has(target)) continue;
      seen.add(target);
      direct.push(target);
    }

    // 归属链补全：页面 ↔ 所属功能 互相牵动
    const ownershipQueue = [...direct];
    while (ownershipQueue.length > 0) {
      const current = ownershipQueue.shift();
      if (current === undefined) continue;
      if (this.pages.has(current)) {
        const page = this.pages.get(current);
        if (page?.featureId !== null && page?.featureId !== undefined && this.graph.has(page.featureId) && !seen.has(page.featureId)) {
          seen.add(page.featureId);
          direct.push(page.featureId);
          ownershipQueue.push(page.featureId);
        }
      }
      if (this.features.has(current)) {
        const feature = this.features.get(current);
        if (feature === undefined) continue;
        for (const pageId of feature.pageIds) {
          if (!seen.has(pageId)) {
            seen.add(pageId);
            direct.push(pageId);
            ownershipQueue.push(pageId);
          }
        }
      }
    }

    const paths: Record<string, string[]> = {};
    for (const target of direct) paths[target] = [target];

    // 沿 dependents 正向传播
    const indirect: string[] = [];
    const queue = [...direct];
    const visited = new Set<string>(direct);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      for (const next of this.graph.dependents(current)) {
        if (visited.has(next)) continue;
        visited.add(next);
        indirect.push(next);
        const base = paths[current] ?? [current];
        paths[next] = [...base, next];
        queue.push(next);
      }
    }

    const affected = [...direct, ...indirect];
    return { direct, indirect, affected, paths };
  }
}

/* ------------------------------ 规则解析 ------------------------------ */

/**
 * 从技术文档 Markdown 按标题约定解析拆分结果。
 * 约定：
 * - `## 功能：<名称>（<id>）` 声明功能单元；
 * - `### 页面：<名称>（<id>）` 声明页面单元（挂在最近一个功能下）；
 * - `- 依赖：<id>, <id>` 行声明单元的 dependsOn。
 * 解析不到的文档返回空结果（调用方给 AI 生成提示或手动编辑）。
 */
export function parseSplitFromTechDoc(techDoc: string): SplitResult {
  const features: FeatureUnit[] = [];
  const pages: PageUnit[] = [];
  let currentFeature: FeatureUnit | null = null;
  let currentUnitId: string | null = null;

  const lines = techDoc.replace(/\r\n?/g, '\n').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    const featureMatch = /^##\s*功能[:：]\s*(.+?)\s*（\s*([A-Za-z][A-Za-z0-9_-]*)\s*）\s*$/.exec(line);
    const pageMatch = /^#{3,4}\s*页面[:：]\s*(.+?)\s*（\s*([A-Za-z][A-Za-z0-9_-]*)\s*）\s*$/.exec(line);
    const depMatch = /^-\s*依赖[:：]\s*(.+)$/.exec(line);

    if (featureMatch !== null) {
      const name = featureMatch[1]?.trim() ?? '';
      const id = featureMatch[2] as string;
      currentFeature = { id, name, pageIds: [], dependsOn: [] };
      features.push(currentFeature);
      currentUnitId = id;
      continue;
    }
    if (pageMatch !== null) {
      const name = pageMatch[1]?.trim() ?? '';
      const id = pageMatch[2] as string;
      const page: PageUnit = { id, name, featureId: currentFeature?.id ?? null, dependsOn: [], route: null };
      pages.push(page);
      if (currentFeature !== null) currentFeature.pageIds.push(id);
      currentUnitId = id;
      continue;
    }
    if (depMatch !== null && currentUnitId !== null) {
      const deps = depMatch[1]
        ?.split(/[,，、\s]+/)
        .map((part) => part.trim())
        .filter((part) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(part)) ?? [];
      for (const dep of deps) {
        const feature = features.find((candidate) => candidate.id === currentUnitId);
        if (feature !== undefined) {
          if (!feature.dependsOn.includes(dep)) feature.dependsOn.push(dep);
        } else {
          const page = pages.find((candidate) => candidate.id === currentUnitId);
          if (page !== undefined && !page.dependsOn.includes(dep)) page.dependsOn.push(dep);
        }
      }
    }
  }

  return { features, pages };
}

/** 生成一个样例拆分（5 功能 8 页面，任务卡验收用） */
export function createSampleSplit(): SplitResult {
  return {
    features: [
      { id: 'f-auth', name: '认证与账号', pageIds: ['p-login', 'p-register'], dependsOn: [] },
      { id: 'f-user', name: '用户中心', pageIds: ['p-profile', 'p-settings'], dependsOn: ['f-auth'] },
      { id: 'f-catalog', name: '商品目录', pageIds: ['p-list', 'p-detail'], dependsOn: [] },
      { id: 'f-cart', name: '购物车', pageIds: ['p-cart'], dependsOn: ['f-user', 'f-catalog'] },
      { id: 'f-order', name: '订单', pageIds: ['p-order'], dependsOn: ['f-cart', 'f-user'] },
    ],
    pages: [
      { id: 'p-login', name: '登录页', featureId: 'f-auth', dependsOn: [], route: '/login' },
      { id: 'p-register', name: '注册页', featureId: 'f-auth', dependsOn: [], route: '/register' },
      { id: 'p-profile', name: '个人资料', featureId: 'f-user', dependsOn: [], route: '/profile' },
      { id: 'p-settings', name: '设置页', featureId: 'f-user', dependsOn: [], route: '/settings' },
      { id: 'p-list', name: '商品列表', featureId: 'f-catalog', dependsOn: [], route: '/products' },
      { id: 'p-detail', name: '商品详情', featureId: 'f-catalog', dependsOn: [], route: '/products/:id' },
      { id: 'p-cart', name: '购物车页', featureId: 'f-cart', dependsOn: [], route: '/cart' },
      { id: 'p-order', name: '订单页', featureId: 'f-order', dependsOn: [], route: '/orders' },
    ],
  };
}
