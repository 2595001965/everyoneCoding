import type { AnchorKind, CodeAnchor } from '../anchors';
import type {
  NavApiRef,
  NavDocSectionRef,
  NavElementRef,
  NavModuleRef,
  NavPageRef,
  NavSourcePort,
  NavTableRef,
  NavTarget,
  NavTargetKind,
  NavTestRef,
} from './source-model';

/**
 * 悬停目标解析与相关度排序（T6-07 要点 3）。
 *
 * 悬停一个设计器元素时，把"该元素的锚点 + 四类清单（后端接口 / 数据库表 / 测试用例 /
 * 技术文档章节）"统一成可排序的 `NavTarget[]`，相关度用**未封顶 raw 分**降序排列，
 * 保证高置信度且命名 / 就近命中的目标排在最前。
 */

/** 锚点种类 → 跳转目标类型 */
export function anchorKindToNavKind(kind: AnchorKind): NavTargetKind {
  switch (kind) {
    case 'controller':
    case 'route':
      return 'backend-api';
    case 'service':
    case 'repo':
    case 'dto':
      return 'backend-module';
    case 'sql':
      return 'db-table';
    case 'test':
      return 'test-case';
    default:
      return 'backend-module';
  }
}

/** 锚点种类 → 层级（Controller 0 → Service 1 → 数据访问层 2 → 测试 3 → 其它 4） */
export function layerForAnchorKind(kind: AnchorKind): number {
  switch (kind) {
    case 'controller':
    case 'route':
      return 0;
    case 'service':
      return 1;
    case 'repo':
      return 2;
    case 'test':
      return 3;
    default:
      return 4;
  }
}

/** 单条锚点 → 跳转目标（统一构造 id / layer，供 jump-service 复用） */
export function anchorToTarget(anchor: CodeAnchor, reasons: readonly string[] = []): NavTarget {
  return {
    id: `anchor:${anchor.id}`,
    kind: anchorKindToNavKind(anchor.kind),
    label: anchor.symbol ?? anchor.elementId ?? anchor.filePath,
    detail: anchor.filePath + (anchor.symbol !== null ? ` · ${anchor.symbol}` : ''),
    filePath: anchor.filePath,
    symbol: anchor.symbol,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    layer: layerForAnchorKind(anchor.kind),
    score: 0,
    reasons: [...reasons],
  };
}

/** 后端接口 → 跳转目标（落在 Controller 层 0） */
export function apiToTarget(api: NavApiRef): NavTarget {
  return {
    id: `api:${api.id}`,
    kind: 'backend-api',
    label: api.name,
    detail: `${api.method} ${api.path}` + (api.module !== null ? ` · ${api.module}` : ''),
    filePath: null,
    symbol: api.name,
    startLine: null,
    endLine: null,
    layer: 0,
    score: 0,
    reasons: [],
  };
}

/** 后端模块 → 跳转目标（层级随角色变化） */
export function moduleToTarget(mod: NavModuleRef): NavTarget {
  const layer = mod.role === 'controller' ? 0 : mod.role === 'service' ? 1 : mod.role === 'repo' ? 2 : 4;
  return {
    id: `module:${mod.id}`,
    kind: 'backend-module',
    label: mod.name,
    detail: `${mod.filePath} · ${mod.role}`,
    filePath: mod.filePath,
    symbol: mod.name,
    startLine: null,
    endLine: null,
    layer,
    score: 0,
    reasons: [],
  };
}

/** 数据库表 → 跳转目标（落在 其它 层 4） */
export function tableToTarget(table: NavTableRef): NavTarget {
  return {
    id: `table:${table.id}`,
    kind: 'db-table',
    label: table.name,
    detail: table.module !== null ? `模块 ${table.module}` : '数据库表',
    filePath: null,
    symbol: null,
    startLine: null,
    endLine: null,
    layer: 4,
    score: 0,
    reasons: [],
  };
}

/** 测试用例 → 跳转目标（落在 测试 层 3） */
export function testToTarget(test: NavTestRef): NavTarget {
  return {
    id: `test:${test.id}`,
    kind: 'test-case',
    label: test.name,
    detail: test.filePath + (test.coversApi !== null ? ` · 覆盖 ${test.coversApi}` : ''),
    filePath: test.filePath,
    symbol: null,
    startLine: null,
    endLine: null,
    layer: 3,
    score: 0,
    reasons: [],
  };
}

/** 技术文档章节 → 跳转目标（落在 其它 层 4） */
export function docToTarget(doc: NavDocSectionRef): NavTarget {
  return {
    id: `doc:${doc.id}`,
    kind: 'doc-section',
    label: doc.title,
    detail: `${doc.documentTitle} · #${doc.anchor}`,
    filePath: null,
    symbol: null,
    startLine: null,
    endLine: null,
    layer: 4,
    score: 0,
    reasons: [],
  };
}

/** 设计器元素 → 跳转目标（跳回设计器定位用，落在 其它 层 4） */
export function elementToTarget(element: NavElementRef): NavTarget {
  return {
    id: `element:${element.elementId}`,
    kind: 'element',
    label: element.name,
    detail: `${element.type} · 页面 ${element.pageName}`,
    filePath: null,
    symbol: null,
    startLine: null,
    endLine: null,
    layer: 4,
    score: 0,
    reasons: [],
  };
}

/** 设计器页面 → 跳转目标（跳回设计器定位用，落在 其它 层 4） */
export function pageToTarget(page: NavPageRef): NavTarget {
  return {
    id: `page:${page.pageId}`,
    kind: 'page',
    label: page.name,
    detail: `路由 ${page.route}` + (page.featureId !== null ? ` · 功能 ${page.featureId}` : ''),
    filePath: null,
    symbol: null,
    startLine: null,
    endLine: null,
    layer: 4,
    score: 0,
    reasons: [],
  };
}

/**
 * 相关度打分（FR-NAV-04，可解释）：
 * 锚点置信度 0.5（权重，未封顶）+ 命名匹配 0.3 + 就近（同文件 0.2 / 同目录 0.1）。
 * 返回原始分 `score` 与 `reasons`，供 UI 展示"为什么排在这里"。
 */
export function scoreTarget(input: {
  target: NavTarget;
  keyword: string;
  anchorConfidence: number;
  sameFile: boolean;
  sameDir: boolean;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const confidence = input.anchorConfidence;
  const confidenceScore = confidence * 0.5;
  reasons.push(`锚点置信度 ${confidence.toFixed(2)}`);
  let score = confidenceScore;

  const keyword = input.keyword.trim().toLowerCase();
  if (keyword.length > 0) {
    const haystack = `${input.target.label} ${input.target.detail} ${input.target.symbol ?? ''}`.toLowerCase();
    // 关键词按空白分词，命中任一词即视为命名匹配（默认关键词为"元素名 + 路由尾"）
    const tokens = keyword.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.some((token) => haystack.includes(token))) {
      score += 0.3;
      reasons.push(`命名匹配 ${input.keyword}`);
    }
  }

  if (input.sameFile) {
    score += 0.2;
    reasons.push('就近 同文件');
  } else if (input.sameDir) {
    score += 0.1;
    reasons.push('就近 同目录');
  }

  return { score, reasons };
}

/** 路由最后一段（例如 `/auth/login` → `login`），用于默认关键词 */
export function lastSegment(route: string): string {
  const cleaned = route.replace(/^[./]+/, '');
  const parts = cleaned.split(/[/\\]/);
  if (parts.length === 0) return '';
  const tail = parts[parts.length - 1];
  return tail ?? '';
}

/** 是否处于同一目录（用于"就近"判定） */
export function inSameDir(a: string, b: string): boolean {
  const dirOf = (path: string): string => {
    const segments = path.split(/[/\\]/);
    if (segments.length <= 1) return '';
    return segments.slice(0, -1).join('/');
  };
  return dirOf(a) !== '' && dirOf(a) === dirOf(b);
}

/** 锚点置信度：三重锚定达成度越高分越高 */
export function anchorConfidenceOf(anchor: CodeAnchor): number {
  if (anchor.evidence.commentMarker && anchor.evidence.astVerified) return 0.9;
  if (anchor.evidence.declared) return 0.7;
  return 0.5;
}

/** 悬停解析的输入 */
export interface HoverTargetsInput {
  element: NavElementRef;
  page: NavPageRef;
  anchors: readonly CodeAnchor[];
  source: NavSourcePort;
  /** 关键词（默认取元素名 + 页面路由的最后一段） */
  keyword?: string;
  limit?: number;
}

/**
 * 悬停时展示候选目标：来源 = 该元素的锚点 + 四类清单，
 * 全部统一打分后按**未封顶 raw 分**降序返回。
 */
export function resolveHoverTargets(input: HoverTargetsInput): NavTarget[] {
  const keyword = (input.keyword ?? `${input.element.name} ${lastSegment(input.page.route)}`).trim();

  const targets: NavTarget[] = [];
  for (const anchor of input.anchors) {
    if (anchor.elementId !== input.element.elementId) continue;
    targets.push(anchorToTarget(anchor));
  }
  for (const api of input.source.listApis()) targets.push(apiToTarget(api));
  for (const table of input.source.listTables()) targets.push(tableToTarget(table));
  for (const test of input.source.listTests()) targets.push(testToTarget(test));
  for (const doc of input.source.listDocSections()) targets.push(docToTarget(doc));

  const scored = targets.map((target) => {
    const anchor = input.anchors.find((candidate) => `anchor:${candidate.id}` === target.id) ?? null;
    const confidence = anchor === null ? 0 : anchorConfidenceOf(anchor);
    const { score, reasons } = scoreTarget({
      target,
      keyword,
      anchorConfidence: confidence,
      sameFile: false,
      sameDir: false,
    });
    return { ...target, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);

  if (input.limit !== undefined && input.limit > 0) return scored.slice(0, input.limit);
  return scored;
}
