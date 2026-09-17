import type { NavModuleRef, NavSourcePort } from './source-model';

/**
 * 页面—元素—接口—后端模块—数据表 关系图（T6-07 要点 5）。
 *
 * 从注入的数据源构建一张纯数据的图（节点 + 边 + 统计），并提供筛选、路径高亮、
 * 分层布局等纯计算能力，渲染层直接拿结果画 SVG / 画布。节点仅 5 类、边仅 6 类，
 * 与冻结接口保持一致。
 */

/** 节点类型（共 5 类） */
export type RelationNodeType = 'page' | 'element' | 'api' | 'module' | 'table';

/** 关系图节点 */
export interface RelationNode {
  id: string;
  type: RelationNodeType;
  label: string;
  /** 分组 key（页面 id / 模块名） */
  group: string | null;
  /** 关联的文件路径（可空） */
  filePath: string | null;
  /** 度：关联边数量（入 + 出） */
  degree: number;
}

/** 边类型（共 6 类） */
export type RelationEdgeType = 'contains' | 'binds' | 'calls' | 'reads' | 'writes' | 'tests';

/** 关系图边 */
export interface RelationEdge {
  id: string;
  type: RelationEdgeType;
  from: string;
  to: string;
  label: string;
}

/** 关系图整体 */
export interface RelationGraph {
  nodes: RelationNode[];
  edges: RelationEdge[];
  stats: Record<RelationNodeType, number>;
}

/** 节点类型顺序（布局分层与统计用） */
const TYPE_ORDER: readonly RelationNodeType[] = ['page', 'element', 'api', 'module', 'table'];

function emptyStats(): Record<RelationNodeType, number> {
  return { page: 0, element: 0, api: 0, module: 0, table: 0 };
}

/**
 * 构建关系图：页面包含元素、元素绑定接口、接口调用模块、模块读写数据表、测试覆盖接口。
 * 节点类型仅 5 类，边类型仅 6 类。度（degree）在全部边生成后统一计算。
 */
export function buildRelationGraph(source: NavSourcePort): RelationGraph {
  const nodes: RelationNode[] = [];
  const edges: RelationEdge[] = [];

  const moduleByName = new Map<string, NavModuleRef>();
  for (const mod of source.listModules()) moduleByName.set(mod.name, mod);

  for (const page of source.listPages()) {
    nodes.push({ id: `page:${page.pageId}`, type: 'page', label: page.name, group: page.featureId, filePath: null, degree: 0 });
    for (const element of page.elements) {
    nodes.push({
      id: `element:${element.elementId}`,
      type: 'element',
      label: element.name,
      group: page.pageId,
      filePath: null,
      degree: 0,
    });
    edges.push({
      id: `e-contains-${page.pageId}-${element.elementId}`,
      type: 'contains',
      from: `page:${page.pageId}`,
      to: `element:${element.elementId}`,
      label: '包含',
    });
    // 元素绑定页面声明的接口（apiDeps 挂在页面上，作用到其全部元素）
    for (const apiId of page.apiDeps) {
      edges.push({
        id: `e-binds-${element.elementId}-${apiId}`,
        type: 'binds',
        from: `element:${element.elementId}`,
        to: `api:${apiId}`,
        label: '绑定接口',
      });
    }
    }
  }

  for (const api of source.listApis()) {
    nodes.push({ id: `api:${api.id}`, type: 'api', label: api.name, group: api.module, filePath: null, degree: 0 });
    if (api.module !== null) {
      const mod = moduleByName.get(api.module) ?? null;
      if (mod !== null) {
        edges.push({
          id: `e-calls-${api.id}-${mod.id}`,
          type: 'calls',
          from: `api:${api.id}`,
          to: `module:${mod.id}`,
          label: '调用模块',
        });
      }
    }
  }

  for (const mod of source.listModules()) {
    nodes.push({ id: `module:${mod.id}`, type: 'module', label: mod.name, group: mod.name, filePath: mod.filePath, degree: 0 });
  }

  for (const table of source.listTables()) {
    nodes.push({ id: `table:${table.id}`, type: 'table', label: table.name, group: table.module, filePath: null, degree: 0 });
    if (table.module !== null) {
      const mod = moduleByName.get(table.module) ?? null;
      if (mod !== null) {
        const edgeType: RelationEdgeType = mod.role === 'repo' ? 'writes' : 'reads';
        edges.push({
          id: `e-${edgeType}-${mod.id}-${table.id}`,
          type: edgeType,
          from: `module:${mod.id}`,
          to: `table:${table.id}`,
          label: edgeType === 'writes' ? '写入表' : '读取表',
        });
      }
    }
  }

  for (const test of source.listTests()) {
    // 节点类型仅 5 类，测试用例作为"代码模块"归入 module 类型，id 以 test: 区分
    nodes.push({ id: `test:${test.id}`, type: 'module', label: test.name, group: null, filePath: test.filePath, degree: 0 });
    if (test.coversApi !== null) {
      edges.push({
        id: `e-tests-${test.id}-${test.coversApi}`,
        type: 'tests',
        from: `test:${test.id}`,
        to: `api:${test.coversApi}`,
        label: '覆盖接口',
      });
    }
  }

  // 统一计算度（入 + 出）
  const degreeById = new Map<string, number>();
  for (const edge of edges) {
    degreeById.set(edge.from, (degreeById.get(edge.from) ?? 0) + 1);
    degreeById.set(edge.to, (degreeById.get(edge.to) ?? 0) + 1);
  }
  for (const node of nodes) node.degree = degreeById.get(node.id) ?? 0;

  const stats = emptyStats();
  for (const node of nodes) stats[node.type] += 1;

  return { nodes, edges, stats };
}

/**
 * 按类型筛选（返回新图，保留两端都存在的边）。
 * 关键词命中节点 label / group 时进一步裁剪节点。
 */
export function filterGraph(graph: RelationGraph, types: readonly RelationNodeType[], keyword?: string): RelationGraph {
  const allowed = new Set(types);
  const kw = keyword !== undefined ? keyword.trim().toLowerCase() : '';
  const nodes = graph.nodes.filter((node) => {
    if (!allowed.has(node.type)) return false;
    if (kw.length > 0 && !`${node.label} ${node.group ?? ''}`.toLowerCase().includes(kw)) return false;
    return true;
  });
  const keptIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to));

  const stats = emptyStats();
  for (const node of nodes) stats[node.type] += 1;
  return { nodes, edges, stats };
}

/** 路径高亮结果 */
export interface PathHighlight {
  nodes: string[];
  edges: string[];
  upstream: string[];
  downstream: string[];
}

/** 选中节点后返回其上下游节点 / 边 id 集合（沿边方向 BFS） */
export function highlightPaths(graph: RelationGraph, nodeId: string): PathHighlight {
  const outgoing = new Map<string, { to: string; edge: string }[]>();
  const incoming = new Map<string, { from: string; edge: string }[]>();
  for (const edge of graph.edges) {
    const out = outgoing.get(edge.from) ?? [];
    out.push({ to: edge.to, edge: edge.id });
    outgoing.set(edge.from, out);
    const inc = incoming.get(edge.to) ?? [];
    inc.push({ from: edge.from, edge: edge.id });
    incoming.set(edge.to, inc);
  }

  const downstream: string[] = [];
  const downEdges: string[] = [];
  const downSeen = new Set<string>([nodeId]);
  const downQueue: string[] = [nodeId];
  while (downQueue.length > 0) {
    const current = downQueue.shift();
    if (current === undefined) break;
    for (const next of outgoing.get(current) ?? []) {
      downEdges.push(next.edge);
      if (!downSeen.has(next.to)) {
        downSeen.add(next.to);
        downstream.push(next.to);
        downQueue.push(next.to);
      }
    }
  }

  const upstream: string[] = [];
  const upEdges: string[] = [];
  const upSeen = new Set<string>([nodeId]);
  const upQueue: string[] = [nodeId];
  while (upQueue.length > 0) {
    const current = upQueue.shift();
    if (current === undefined) break;
    for (const prev of incoming.get(current) ?? []) {
      upEdges.push(prev.edge);
      if (!upSeen.has(prev.from)) {
        upSeen.add(prev.from);
        upstream.push(prev.from);
        upQueue.push(prev.from);
      }
    }
  }

  const nodes = [nodeId, ...upstream, ...downstream];
  return { nodes, edges: [...upEdges, ...downEdges], upstream, downstream };
}

/** 分层布局（纯计算）：相同类型节点 y 相同，组内 x 单调递增，坐标落在 [0, width/height] 内 */
export function layoutGraph(
  graph: RelationGraph,
  options?: { width?: number; height?: number },
): { nodes: (RelationNode & { x: number; y: number })[]; width: number; height: number } {
  const width = options?.width ?? 800;
  const height = options?.height ?? 600;
  const margin = 40;

  const perType = new Map<RelationNodeType, RelationNode[]>();
  for (const node of graph.nodes) {
    const bucket = perType.get(node.type) ?? [];
    bucket.push(node);
    perType.set(node.type, bucket);
  }

  const presentTypes = TYPE_ORDER.filter((type) => (perType.get(type)?.length ?? 0) > 0);
  const typeCount = presentTypes.length;

  const positioned: (RelationNode & { x: number; y: number })[] = [];
  TYPE_ORDER.forEach((type, rank) => {
    const bucket = perType.get(type);
    if (bucket === undefined || bucket.length === 0) return;
    const sorted = [...bucket].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const y = typeCount <= 1 ? height / 2 : margin + (rank / (typeCount - 1)) * (height - 2 * margin);
    const count = sorted.length;
    sorted.forEach((node, index) => {
      const x = count <= 1 ? width / 2 : margin + (index / (count - 1)) * (width - 2 * margin);
      positioned.push({ ...node, x, y });
    });
  });

  return { nodes: positioned, width, height };
}
