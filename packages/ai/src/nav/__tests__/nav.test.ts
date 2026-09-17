import { describe, expect, it } from 'vitest';

import type { NavTarget, NavTargetKind } from '../source-model';
import { EMPTY_NAV_SOURCE, filterNavTargets } from '../source-model';
import { anchorToTarget, resolveHoverTargets, scoreTarget } from '../target-resolver';
import { JumpService } from '../jump-service';
import { ReverseJumpService } from '../reverse-jump';
import {
  buildRelationGraph,
  filterGraph,
  highlightPaths,
  layoutGraph,
  type RelationGraph,
  type RelationNodeType,
} from '../relation-graph';
import {
  makeBidirectionalSource,
  makeHoverSource,
  makeLayeredSource,
  makeRelationSource,
  makeReverseSource,
} from './fixtures';

/** 测试用最小 NavTarget 工厂 */
function target(partial: Partial<NavTarget> & { id: string }): NavTarget {
  return {
    kind: 'backend-api',
    label: partial.id,
    detail: '',
    filePath: null,
    symbol: null,
    startLine: null,
    endLine: null,
    layer: 0,
    score: 0,
    reasons: [],
    ...partial,
  };
}

const FROZEN = 1_000_000;

/* ------------------------------ filterNavTargets ------------------------------ */

describe('filterNavTargets 候选过滤', () => {
  const all: NavTarget[] = [
    target({ id: 'a', kind: 'db-table', label: 'user_account', detail: '用户表' }),
    target({ id: 'b', kind: 'test-case', label: 'UserTest', detail: '登录测试' }),
    target({ id: 'c', kind: 'backend-api', label: 'login', detail: '/api/login' }),
    target({ id: 'd', kind: 'doc-section', label: '登录流程', detail: '认证文档' }),
  ];

  it('按类型过滤只保留命中的 kind', () => {
    const result = filterNavTargets(all, { kinds: ['db-table'] as NavTargetKind[] });
    expect(result.map((t) => t.id)).toEqual(['a']);
  });

  it('按关键词匹配 label / detail / kind / reasons', () => {
    const result = filterNavTargets(all, { keyword: '登录' });
    expect(result.map((t) => t.id).sort()).toEqual(['b', 'd']);
  });

  it('limit 截断数量', () => {
    const result = filterNavTargets(all, { limit: 2 });
    expect(result).toHaveLength(2);
  });
});

/* ------------------------------ EMPTY_NAV_SOURCE ------------------------------ */

describe('EMPTY_NAV_SOURCE 空实现', () => {
  it('所有查询返回空且 readFile 返回 null（不崩溃）', () => {
    expect(EMPTY_NAV_SOURCE.listAnchors()).toEqual([]);
    expect(EMPTY_NAV_SOURCE.listPages()).toEqual([]);
    expect(EMPTY_NAV_SOURCE.listCodeFiles()).toEqual([]);
    expect(EMPTY_NAV_SOURCE.readFile('x.ts')).toBeNull();
  });
});

/* ------------------------------ target-resolver ------------------------------ */

describe('anchorToTarget 锚点 → 目标映射', () => {
  it('controller 锚点映射到 backend-api 且层级 0；test 映射到 test-case 层级 3', () => {
    const controller = anchorToTarget({
      id: 'a1',
      projectId: 'P',
      elementId: 'e1',
      pageId: null,
      featureId: null,
      filePath: 'c.ts',
      symbol: 'Ctrl.m',
      startLine: 1,
      endLine: 2,
      kind: 'controller',
      commitSha: null,
      syncState: 'synced',
      syncDetail: null,
      evidence: { declared: true, commentMarker: true, astVerified: true },
      createdAt: 0,
      updatedAt: 0,
    });
    expect(controller.kind).toBe('backend-api');
    expect(controller.layer).toBe(0);
    expect(controller.id).toBe('anchor:a1');

    const test = anchorToTarget({
      id: 'a2',
      projectId: 'P',
      elementId: 'e1',
      pageId: null,
      featureId: null,
      filePath: 't.ts',
      symbol: 'SvcTest.m',
      startLine: 1,
      endLine: 2,
      kind: 'test',
      commitSha: null,
      syncState: 'synced',
      syncDetail: null,
      evidence: { declared: true, commentMarker: false, astVerified: false },
      createdAt: 0,
      updatedAt: 0,
    });
    expect(test.kind).toBe('test-case');
    expect(test.layer).toBe(3);
  });
});

describe('scoreTarget 相关度打分（未封顶、可解释）', () => {
  it('置信度高 + 命名命中 + 同文件时 raw 分可超过 1.0，且按分值而非字典序排序', () => {
    const base = target({ id: 'base', label: 'alpha', detail: 'x' });
    const high = scoreTarget({ target: { ...base, id: 'z-zeta' }, keyword: 'alpha', anchorConfidence: 2.4, sameFile: true, sameDir: false });
    const low = scoreTarget({ target: { ...base, id: 'a-alpha' }, keyword: 'alpha', anchorConfidence: 1.8, sameFile: true, sameDir: false });
    // 两个 raw 都 > 1，证明没有被封顶成 1.0 后用字典序打乱
    expect(high.score).toBeGreaterThan(1);
    expect(low.score).toBeGreaterThan(1);
    expect(high.score).toBeGreaterThan(low.score);
    const sorted = [low, high].sort((a, b) => b.score - a.score);
    expect(sorted[0]?.score).toBe(high.score);
  });

  it('就近：同目录（不同文件）给出比无就近更小的加分', () => {
    const t = target({ id: 'n', label: 'no', detail: 'x' });
    const sameFile = scoreTarget({ target: t, keyword: 'x', anchorConfidence: 0, sameFile: true, sameDir: false });
    const sameDir = scoreTarget({ target: t, keyword: 'x', anchorConfidence: 0, sameFile: false, sameDir: true });
    const none = scoreTarget({ target: t, keyword: 'x', anchorConfidence: 0, sameFile: false, sameDir: false });
    expect(sameFile.score).toBeGreaterThan(sameDir.score);
    expect(sameDir.score).toBeGreaterThan(none.score);
    expect(sameFile.reasons).toContain('就近 同文件');
  });
});

describe('resolveHoverTargets 悬停候选解析', () => {
  it('四类目标（后端接口 / 数据库表 / 测试用例 / 技术文档章节）都能解析出来', () => {
    const source = makeHoverSource();
    const page = source.listPages()[0]!;
    const element = page.elements[0]!;
    const result = resolveHoverTargets({ element, page, anchors: source.listAnchors(), source });
    const kinds = result.map((t) => t.kind);
    expect(kinds).toContain('backend-api');
    expect(kinds).toContain('db-table');
    expect(kinds).toContain('test-case');
    expect(kinds).toContain('doc-section');
  });

  it('结果按相关度 raw 分降序排列', () => {
    const source = makeHoverSource();
    const page = source.listPages()[0]!;
    const element = page.elements[0]!;
    const result = resolveHoverTargets({ element, page, anchors: source.listAnchors(), source });
    const scores = result.map((t) => t.score);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!);
    }
    // 该元素的 controller 锚点（高置信度 + 命名命中）应排第一
    expect(result[0]?.id).toBe('anchor:anc-login');
  });

  it('未提供关键词时默认取 元素名 + 路由最后一段', () => {
    const source = makeHoverSource();
    const page = source.listPages()[0]!;
    const element = page.elements[0]!;
    const result = resolveHoverTargets({ element, page, anchors: source.listAnchors(), source });
    // 默认关键词含 "登录"（元素名）与 "login"（路由尾），api/test/doc 都因命名命中得到加分
    const matched = result.filter((t) => t.reasons.some((r) => r.startsWith('命名匹配')));
    expect(matched.length).toBeGreaterThan(0);
  });
});

/* ------------------------------ JumpService ------------------------------ */

describe('JumpService Ctrl+点击跳转', () => {
  it('多锚点按 Controller(0)→Service(1)→Repo(2)→Test(3) 分组，needsChoice 为 true', () => {
    const source = makeLayeredSource();
    const jump = new JumpService({ source, clock: () => FROZEN });
    const page = source.listPages()[0]!;
    const element = page.elements[0]!;
    const resolution = jump.resolve({ projectId: 'P1', page, element });
    expect(resolution.layers.map((l) => l.layer)).toEqual([0, 1, 2, 3, 4]);
    expect(resolution.layers[0]?.label).toBe('Controller 方法');
    expect(resolution.layers[1]?.label).toBe('Service');
    expect(resolution.layers[2]?.label).toBe('数据访问层');
    expect(resolution.layers[3]?.label).toBe('测试');
    expect(resolution.needsChoice).toBe(true);
  });

  it('限定单一类型且首选明显领先时给出 preferred 且无需选择', () => {
    const source = makeHoverSource();
    const jump = new JumpService({ source, clock: () => FROZEN });
    const page = source.listPages()[0]!;
    const element = page.elements[0]!;
    const resolution = jump.resolve({ projectId: 'P1', page, element, kinds: ['backend-api'] });
    expect(resolution.layers).toHaveLength(1);
    expect(resolution.preferred?.id.startsWith('anchor:')).toBe(true);
    expect(resolution.needsChoice).toBe(false);
  });

  it('无跳转历史时 stats 的 rate 为 1（避免除零）', () => {
    const source = makeHoverSource();
    const jump = new JumpService({ source, clock: () => FROZEN });
    const stats = jump.stats();
    expect(stats.total).toBe(0);
    expect(stats.success).toBe(0);
    expect(stats.rate).toBe(1);
  });

  it('commit 成功返回滚动定位指令，并触发订阅事件', () => {
    const source = makeReverseSource(); // 含 sample.ts 文件
    const jump = new JumpService({ source, clock: () => FROZEN });
    const seen: string[] = [];
    jump.subscribe((event) => seen.push(event.type));
    const outcome = jump.commit(target({ id: 't1', filePath: 'sample.ts', startLine: 1 }));
    expect(outcome.success).toBe(true);
    expect(outcome.message).toContain('已跳转');
    expect(seen).toEqual(['jumped']);
    expect(jump.history()).toHaveLength(1);
  });

  it('commit 目标文件不存在时记为失败', () => {
    const source = makeReverseSource();
    const jump = new JumpService({ source, clock: () => FROZEN });
    const outcome = jump.commit(target({ id: 't2', filePath: 'missing.ts' }));
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain('无法定位');
    expect(jump.stats().success).toBe(0);
  });

  it('20 组锚点双向跳转成功率 ≥ 0.95（含 2 组失败路径，分母保留）', () => {
    const source = makeBidirectionalSource();
    const jump = new JumpService({ source, clock: () => FROZEN });
    const reverse = new ReverseJumpService({ source, clock: () => FROZEN });
    const page = source.listPages()[0]!;

    for (let i = 1; i <= 20; i += 1) {
      const elementId = `el-g${i}`;
      const element = page.elements.find((e) => e.elementId === elementId)!;
      const resolution = jump.resolve({ projectId: 'P1', page, element });
      const anchorTarget = resolution.targets.find((t) => t.id.startsWith('anchor:'));
      expect(anchorTarget).toBeDefined();
      jump.commit(anchorTarget!);
      reverse.jumpFromCode({ filePath: 'src/app/groups/markers.ts', line: i });
    }

    const combined = reverse.combinedStats(jump.stats());
    expect(combined.total).toBe(40);
    expect(combined.success).toBe(38);
    expect(combined.rate).toBeGreaterThanOrEqual(0.95);
  });
});

/* ------------------------------ ReverseJumpService ------------------------------ */

describe('ReverseJumpService 反向跳转', () => {
  it('scanFile 正确解析锚点标记（含缩进、行尾注释、重复标记）', () => {
    const source = makeReverseSource();
    const svc = new ReverseJumpService({ source, clock: () => FROZEN });
    const hits = svc.scanFile('sample.ts');
    expect(hits).toHaveLength(3);
    expect(hits.filter((h) => h.elementId === 'el-a')).toHaveLength(2);
    expect(hits.filter((h) => h.elementId === 'el-b')).toHaveLength(1);
    const b = hits.find((h) => h.elementId === 'el-b');
    expect(b?.line).toBe(2);
    // 解析出的元素可关联回设计器
    expect(b?.element?.name).toBe('元素B');
    expect(b?.page?.pageId).toBe('p-rev');
  });

  it('jumpFromCode 命中锚点行 → 跳回元素', () => {
    const source = makeReverseSource();
    const svc = new ReverseJumpService({ source, clock: () => FROZEN });
    const result = svc.jumpFromCode({ filePath: 'sample.ts', line: 1 });
    expect(result.success).toBe(true);
    expect(result.hits[0]?.elementId).toBe('el-a');
    expect(result.message).toContain('跳回设计器元素');
  });

  it('jumpFromCode 命中无标记的行 → 未命中', () => {
    const source = makeReverseSource();
    const svc = new ReverseJumpService({ source, clock: () => FROZEN });
    const result = svc.jumpFromCode({ filePath: 'sample.ts', line: 3 });
    expect(result.success).toBe(false);
    expect(result.hits).toEqual([]);
  });

  it('jumpFromCode 扫描不存在的文件 → 未命中', () => {
    const source = makeReverseSource();
    const svc = new ReverseJumpService({ source, clock: () => FROZEN });
    const result = svc.jumpFromCode({ filePath: 'nope.ts', line: 1 });
    expect(result.success).toBe(false);
  });

  it('combinedStats 把正跳与反跳合并且分母保留（验证失败路径）', () => {
    const source = makeReverseSource();
    const svc = new ReverseJumpService({ source, clock: () => FROZEN });
    svc.jumpFromCode({ filePath: 'sample.ts', line: 1 }); // 成功
    svc.jumpFromCode({ filePath: 'sample.ts', line: 3 }); // 失败
    const combined = svc.combinedStats({ total: 10, success: 8 });
    expect(combined.total).toBe(12);
    expect(combined.success).toBe(9);
    expect(combined.rate).toBeCloseTo(9 / 12, 5);
  });
});

/* ------------------------------ relation-graph ------------------------------ */

describe('buildRelationGraph 关系图', () => {
  it('5 类节点与 6 类边都出现', () => {
    const graph = buildRelationGraph(makeRelationSource());
    const nodeTypes = new Set(graph.nodes.map((n) => n.type));
    expect(nodeTypes).toEqual(new Set<RelationNodeType>(['page', 'element', 'api', 'module', 'table']));
    const edgeTypes = new Set(graph.edges.map((e) => e.type));
    expect(edgeTypes).toEqual(
      new Set(['contains', 'binds', 'calls', 'reads', 'writes', 'tests']),
    );
  });

  it('节点度（入 + 出）计算正确', () => {
    const graph = buildRelationGraph(makeRelationSource());
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('api:api-create-order')?.degree).toBe(4);
    expect(byId.get('module:mod-order-svc')?.degree).toBe(3);
    expect(byId.get('page:p-order')?.degree).toBe(2);
    expect(byId.get('table:tbl-order')?.degree).toBe(1);
  });

  it('stats 按节点类型计数（module 含测试节点）', () => {
    const graph = buildRelationGraph(makeRelationSource());
    expect(graph.stats.page).toBe(1);
    expect(graph.stats.element).toBe(2);
    expect(graph.stats.api).toBe(2);
    expect(graph.stats.module).toBe(3);
    expect(graph.stats.table).toBe(2);
  });

  it('空数据源也返回合法空图', () => {
    const graph = buildRelationGraph(EMPTY_NAV_SOURCE);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.stats.module).toBe(0);
  });
});

describe('filterGraph 类型筛选', () => {
  it('只保留两端都在筛选集合内的边', () => {
    const graph = buildRelationGraph(makeRelationSource());
    const filtered = filterGraph(graph, ['api', 'module']);
    const keptIds = new Set(filtered.nodes.map((n) => n.id));
    for (const edge of filtered.edges) {
      expect(keptIds.has(edge.from)).toBe(true);
      expect(keptIds.has(edge.to)).toBe(true);
    }
    expect(filtered.edges.length).toBeLessThan(graph.edges.length);
    expect(filtered.nodes.every((n) => n.type === 'api' || n.type === 'module')).toBe(true);
  });
});

describe('highlightPaths 路径高亮（菱形结构）', () => {
  const diamond: RelationGraph = {
    nodes: [
      { id: 'A', type: 'page', label: 'A', group: null, filePath: null, degree: 0 },
      { id: 'B', type: 'element', label: 'B', group: null, filePath: null, degree: 0 },
      { id: 'C', type: 'element', label: 'C', group: null, filePath: null, degree: 0 },
      { id: 'D', type: 'api', label: 'D', group: null, filePath: null, degree: 0 },
    ],
    edges: [
      { id: 'e1', type: 'contains', from: 'A', to: 'B', label: '' },
      { id: 'e2', type: 'contains', from: 'A', to: 'C', label: '' },
      { id: 'e3', type: 'binds', from: 'B', to: 'D', label: '' },
      { id: 'e4', type: 'binds', from: 'C', to: 'D', label: '' },
    ],
    stats: { page: 1, element: 2, api: 1, module: 0, table: 0 },
  };

  it('起点 A 的下游是 B/C/D，上游为空', () => {
    const r = highlightPaths(diamond, 'A');
    expect([...r.downstream].sort()).toEqual(['B', 'C', 'D']);
    expect(r.upstream).toEqual([]);
  });

  it('终点 D 的上游是 A/B/C，下游为空', () => {
    const r = highlightPaths(diamond, 'D');
    expect([...r.upstream].sort()).toEqual(['A', 'B', 'C']);
    expect(r.downstream).toEqual([]);
  });

  it('中间节点 B 的上游是 A，下游是 D', () => {
    const r = highlightPaths(diamond, 'B');
    expect(r.upstream).toEqual(['A']);
    expect(r.downstream).toEqual(['D']);
  });
});

describe('layoutGraph 分层布局', () => {
  it('所有坐标落在 [0, width/height] 内', () => {
    const graph = buildRelationGraph(makeRelationSource());
    const { nodes, width, height } = layoutGraph(graph, { width: 800, height: 600 });
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(width);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(height);
    }
  });

  it('同类型节点 y 相同、组内 x 单调递增', () => {
    const graph = buildRelationGraph(makeRelationSource());
    const { nodes } = layoutGraph(graph, { width: 800, height: 600 });
    const yByType = new Map<RelationNodeType, number[]>();
    const xByType = new Map<RelationNodeType, number[]>();
    for (const n of nodes) {
      const ys = yByType.get(n.type) ?? [];
      ys.push(n.y);
      yByType.set(n.type, ys);
      const xs = xByType.get(n.type) ?? [];
      xs.push(n.x);
      xByType.set(n.type, xs);
    }
    for (const ys of yByType.values()) expect(new Set(ys).size).toBe(1);
    for (const xs of xByType.values()) {
      const sorted = [...xs].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) expect(sorted[i - 1]!).toBeLessThan(sorted[i]!);
    }
  });
});
