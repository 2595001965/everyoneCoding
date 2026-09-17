import type { Breakpoint, ElementNode, PageDsl } from '../dsl/types';
import { BREAKPOINTS } from '../dsl/types';
import { mapTree, walkElements } from '../dsl/traverse';

/**
 * 响应式规则（T3-11 要点 4）。
 *
 * 核心约定：断点只存**与基线的差异属性**（override map，挂在 `ElementNode.responsive`），
 * 因此 DSL 体积不会随断点数量线性增长，也不会产生元素副本。
 *
 * 渲染 / 预览时用 `resolveStyleForBreakpoint()` 把「基线样式 + 断点覆盖」合并出最终样式。
 */

export const RESPONSIVE_BREAKPOINTS: readonly Breakpoint[] = BREAKPOINTS;

/** 断点 → `responsive` 的键（字符串，便于 JSON 序列化） */
export function breakpointKey(breakpoint: Breakpoint | number): string {
  return String(breakpoint);
}

/** 某个元素的断点覆盖（无则空对象） */
export function overridesOf(node: ElementNode, breakpoint: Breakpoint | number): Record<string, unknown> {
  return node.responsive?.[breakpointKey(breakpoint)] ?? {};
}

/**
 * 写入断点覆盖。
 * - `style === null` 时删除该断点的全部覆盖；
 * - 只写差异：与基线相同的键会被自动剔除；
 * - 覆盖为空时移除整个断点条目（保持 DSL 精简）。
 */
export function setBreakpointOverride(
  dsl: PageDsl,
  elementId: string,
  breakpoint: Breakpoint | number,
  style: Record<string, unknown> | null,
): PageDsl {
  const key = breakpointKey(breakpoint);
  return {
    ...dsl,
    tree: mapTree(dsl.tree, (node) => {
      if (node.id !== elementId) return node;
      const responsive = { ...(node.responsive ?? {}) };
      if (style === null) {
        delete responsive[key];
      } else {
        const baseline = node.style ?? {};
        const diff: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(style)) {
          if (JSON.stringify(baseline[field]) === JSON.stringify(value)) continue;
          diff[field] = value;
        }
        if (Object.keys(diff).length === 0) delete responsive[key];
        else responsive[key] = diff;
      }
      if (Object.keys(responsive).length === 0) {
        const withoutResponsive: ElementNode = { ...node };
        delete withoutResponsive.responsive;
        return withoutResponsive;
      }
      return { ...node, responsive };
    }),
  };
}

/** 合并基线 + 断点覆盖，得到该断点下的最终样式 */
export function resolveStyleForBreakpoint(node: ElementNode, breakpoint: Breakpoint | number): Record<string, unknown> {
  return { ...(node.style ?? {}), ...overridesOf(node, breakpoint) };
}

/** 一个元素在多个断点下的样式表（预览/代码生成用） */
export function resolveAllBreakpoints(
  node: ElementNode,
): Array<{ breakpoint: Breakpoint; style: Record<string, unknown> }> {
  return RESPONSIVE_BREAKPOINTS.map((breakpoint) => ({ breakpoint, style: resolveStyleForBreakpoint(node, breakpoint) }));
}

export interface ResponsiveStats {
  /** 存在断点覆盖的元素数 */
  elementsWithOverrides: number;
  /** 覆盖条目总数（元素 × 断点） */
  overrideCount: number;
  /** 差异属性总条数 */
  diffFieldCount: number;
  /** 当前 DSL 字节数 */
  dslBytes: number;
  /** 若为每个断点复制全量元素树，体积会是多少 */
  fullCopyBytes: number;
  /** 节省比例（0~1） */
  savingRatio: number;
}

/** 统计断点覆盖情况与体积（用于断言「不随断点线性增长」） */
export function responsiveStats(dsl: PageDsl): ResponsiveStats {
  let elementsWithOverrides = 0;
  let overrideCount = 0;
  let diffFieldCount = 0;

  for (const { node } of walkElements(dsl.tree)) {
    const entries = Object.entries(node.responsive ?? {});
    if (entries.length === 0) continue;
    elementsWithOverrides += 1;
    overrideCount += entries.length;
    diffFieldCount += entries.reduce((sum, [, value]) => sum + Object.keys(value).length, 0);
  }

  const dslBytes = byteSize(JSON.stringify(dsl));

  // 反事实：若每个断点都复制一份完整元素树（共 4 个断点）
  const fullTrees = RESPONSIVE_BREAKPOINTS.map((breakpoint) => {
    const clone = mapTree(dsl.tree, (node) => ({ ...node, style: resolveStyleForBreakpoint(node, breakpoint) }));
    return JSON.stringify({ ...dsl, tree: clone });
  });
  const fullCopyBytes = fullTrees.reduce((sum, text) => sum + byteSize(text), 0);

  return {
    elementsWithOverrides,
    overrideCount,
    diffFieldCount,
    dslBytes,
    fullCopyBytes,
    savingRatio: fullCopyBytes === 0 ? 0 : Math.max(0, 1 - dslBytes / fullCopyBytes),
  };
}

function byteSize(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 清理空覆盖（导入外部 DSL 后自愈用） */
export function pruneOverrides(dsl: PageDsl): PageDsl {
  return {
    ...dsl,
    tree: mapTree(dsl.tree, (node) => {
      if (node.responsive === undefined) return node;
      const responsive: Record<string, Record<string, unknown>> = {};
      for (const [key, value] of Object.entries(node.responsive)) {
        if (Object.keys(value).length > 0) responsive[key] = value;
      }
      if (Object.keys(responsive).length === 0) {
        const withoutResponsive: ElementNode = { ...node };
        delete withoutResponsive.responsive;
        return withoutResponsive;
      }
      return { ...node, responsive };
    }),
  };
}
