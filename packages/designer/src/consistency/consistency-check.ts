import type { ElementNode, PageDsl, Platform } from '../dsl/types';
import { normalizePath } from '../pages/route-table';
import { walkElements } from '../dsl/traverse';

/**
 * 多端一致性校验（T3-11 要点 5，FR-DSG-14）。
 *
 * 按**功能（featureRef）**比对项目所选目标端上的设计：
 * - 缺失端：目标端里没有任何页面覆盖该功能；
 * - 缺失页面：某端缺少某些路由（以其他端已有的路由为准）；
 * - 结构差异：同一路由在两端的关键层级结构不一致（元素类型路径不同）；
 * - 命名差异：同一元素在端与端之间的显示名不同（提示是否漏改 / 漏同步）。
 *
 * 结果在工作台与功能节点上提示（本模块只产出结构化清单，UI 由 ConsistencyPanel 呈现）。
 */

export type ConsistencyIssueCode =
  'MISSING_PLATFORM' | 'MISSING_PAGE' | 'STRUCTURE_DIFF' | 'NAMING_DIFF';

export interface ConsistencyIssue {
  code: ConsistencyIssueCode;
  severity: 'warning' | 'info';
  /** 归属功能（没有归属时为 null，表示项目级） */
  featureId: string | null;
  platform?: Platform;
  pageId?: string;
  path?: string;
  message: string;
}

export interface ConsistencyReport {
  issues: ConsistencyIssue[];
  summary: {
    targetPlatforms: Platform[];
    coveredPlatforms: Platform[];
    missingPlatforms: Platform[];
    features: string[];
    /** 每种问题的数量 */
    counts: Record<ConsistencyIssueCode, number>;
  };
}

export interface ConsistencyInput {
  pages: readonly PageDsl[];
  /** 项目所选目标端（来自项目设置 FR-AI-13） */
  targetPlatforms: readonly Platform[];
}

/** 结构签名：元素类型构成的前序序列（用于跨端结构比对） */
export function structureSignature(node: ElementNode): string {
  return walkElements(node)
    .map((entry) => entry.node.type)
    .join('>');
}

/** 关键层级结构（前两层）：跨端一致性通常只关心骨架是否一致 */
export function skeletonSignature(node: ElementNode): string {
  return walkElements(node)
    .filter((entry) => entry.depth <= 1)
    .map((entry) => entry.node.type)
    .join('>');
}

/** 按路由聚合各端页面 */
function byRoute(pages: readonly PageDsl[]): Map<string, PageDsl[]> {
  const map = new Map<string, PageDsl[]>();
  for (const page of pages) {
    const key = normalizePath(page.route);
    const list = map.get(key) ?? [];
    list.push(page);
    map.set(key, list);
  }
  return map;
}

export function checkConsistency({ pages, targetPlatforms }: ConsistencyInput): ConsistencyReport {
  const issues: ConsistencyIssue[] = [];
  const targets = [...new Set(targetPlatforms)];

  /* --------------------------- 缺失端（按功能） --------------------------- */
  const featurePlatforms = new Map<string, Set<Platform>>();
  const features = new Set<string>();
  for (const page of pages) {
    const featureId = page.featureId ?? null;
    if (featureId === null) continue;
    features.add(featureId);
    const set = featurePlatforms.get(featureId) ?? new Set<Platform>();
    set.add(page.platform);
    featurePlatforms.set(featureId, set);
  }

  const coveredPlatforms = new Set<Platform>();
  for (const platform of featurePlatforms.values())
    for (const item of platform) coveredPlatforms.add(item);

  const missingPlatforms = targets.filter((platform) => !coveredPlatforms.has(platform));

  // 先按功能报（更具体，能直接指到功能节点上）
  const featureReportedPlatforms = new Set<Platform>();
  for (const [featureId, platforms] of featurePlatforms) {
    for (const platform of targets) {
      if (platforms.has(platform)) continue;
      featureReportedPlatforms.add(platform);
      issues.push({
        code: 'MISSING_PLATFORM',
        severity: 'warning',
        featureId,
        platform,
        message: `功能「${featureId}」在端「${platform}」上没有对应页面`,
      });
    }
  }

  // 项目级只在「该端完全没有设计」时才报，避免与功能级提示重复
  for (const platform of missingPlatforms) {
    if (featureReportedPlatforms.has(platform)) continue;
    issues.push({
      code: 'MISSING_PLATFORM',
      severity: 'warning',
      featureId: null,
      platform,
      message: `目标端「${platform}」上还没有任何页面设计，请补齐该端界面`,
    });
  }

  /* ----------------------------- 缺失页面 ----------------------------- */
  const routeGroups = byRoute(pages);
  for (const [path, group] of routeGroups) {
    const platformsWithRoute = new Set(group.map((page) => page.platform));
    for (const platform of targets) {
      // 该端已经有这个路由 → 不算缺失
      if (platformsWithRoute.has(platform)) continue;
      // 该端完全没有页面 → 由 MISSING_PLATFORM 报告，避免重复
      const platformHasAny = pages.some((page) => page.platform === platform);
      if (!platformHasAny) continue;
      issues.push({
        code: 'MISSING_PAGE',
        severity: 'warning',
        featureId: group[0]?.featureId ?? null,
        platform,
        path,
        message: `端「${platform}」缺少路由 ${path}`,
      });
    }
  }

  /* ---------------------- 结构差异 / 命名差异 ---------------------- */
  for (const [path, group] of routeGroups) {
    if (group.length < 2) continue;
    const base = group[0] as PageDsl;
    const baseSkeleton = skeletonSignature(base.tree);
    for (const page of group.slice(1)) {
      const skeleton = skeletonSignature(page.tree);
      if (skeleton !== baseSkeleton) {
        issues.push({
          code: 'STRUCTURE_DIFF',
          severity: 'warning',
          featureId: page.featureId ?? null,
          platform: page.platform,
          pageId: page.id,
          path,
          message: `路由 ${path}：端「${page.platform}」的骨架结构（${skeleton}）与「${base.platform}」（${baseSkeleton}）不一致`,
        });
      }

      // 命名差异：同 id 元素显示名不同
      const baseNames = new Map(
        walkElements(base.tree).map((entry) => [entry.node.id, entry.node.name ?? '']),
      );
      for (const { node } of walkElements(page.tree)) {
        const expected = baseNames.get(node.id);
        if (expected === undefined) continue;
        const actual = node.name ?? '';
        if (expected === '' || actual === '' || expected === actual) continue;
        issues.push({
          code: 'NAMING_DIFF',
          severity: 'info',
          featureId: page.featureId ?? null,
          platform: page.platform,
          pageId: page.id,
          path,
          message: `元素 ${node.id} 命名不一致：「${base.platform}」叫「${expected}」，「${page.platform}」叫「${actual}」`,
        });
      }
    }
  }

  const counts: Record<ConsistencyIssueCode, number> = {
    MISSING_PLATFORM: 0,
    MISSING_PAGE: 0,
    STRUCTURE_DIFF: 0,
    NAMING_DIFF: 0,
  };
  for (const issue of issues) counts[issue.code] += 1;

  return {
    issues,
    summary: {
      targetPlatforms: targets,
      coveredPlatforms: [...coveredPlatforms],
      missingPlatforms,
      features: [...features],
      counts,
    },
  };
}

/** 工作台提示文案（无问题时返回 null） */
export function workbenchHint(report: ConsistencyReport): string | null {
  if (report.issues.length === 0) return null;
  const { counts, missingPlatforms } = report.summary;
  const parts: string[] = [];
  if (missingPlatforms.length > 0) parts.push(`缺失端 ${missingPlatforms.join('、')}`);
  if (counts.MISSING_PAGE > 0) parts.push(`缺失页面 ${counts.MISSING_PAGE}`);
  if (counts.STRUCTURE_DIFF > 0) parts.push(`结构差异 ${counts.STRUCTURE_DIFF}`);
  if (counts.NAMING_DIFF > 0) parts.push(`命名差异 ${counts.NAMING_DIFF}`);
  return `多端一致性：${parts.join('，')}`;
}

/** 按功能分组（功能节点上提示用） */
export function groupByFeature(
  report: ConsistencyReport,
): Array<{ featureId: string | null; issues: ConsistencyIssue[] }> {
  const map = new Map<string | null, ConsistencyIssue[]>();
  for (const issue of report.issues) {
    const list = map.get(issue.featureId) ?? [];
    list.push(issue);
    map.set(issue.featureId, list);
  }
  return [...map.entries()].map(([featureId, issues]) => ({ featureId, issues }));
}
