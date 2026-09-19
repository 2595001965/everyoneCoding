/**
 * 影响面分析（T7-03 要点 3，FR-UNI-04 / FR-UNI-13 / NFR-P-06）。
 *
 * 输入：注册表项 + 新规范名 + T7-02 的**出现位置索引**；
 * 输出：按 `auto / confirm / warn` 三级分组的完整受影响位置，供 diff 预览与逐项勾选。
 *
 * 两条硬边界：
 * 1. **作用范围限定项目内（D-07 / FR-UNI-13）**：结果集里**不存在跨项目条目**——
 *    不属于本项目注册表项的出现位置被直接丢弃并记入 `warnings`；
 * 2. **长期记忆不改**：`kind === 'memory' && scopeLayer === 'longterm'` 的提及被排除，
 *    面板提示"长期记忆中的提及请在记忆中心自行维护"。
 *
 * 默认勾选口径：`auto` 与 `confirm` 勾选、`warn` 不勾选（FR-UNI-04 验收要点）。
 */

import { deriveProjections } from './naming/rule-engine';
import { PROJECTION_KINDS, type ProjectionKind, type ResolvedNamingRule } from './naming/presets';
import type { ProjectionSet, RegistryEntry } from './registry-model';
import {
  RISK_LEVEL_HINTS,
  RISK_LEVEL_LABELS,
  isSelectedByDefault,
  type RiskConfig,
} from './occurrence/risk-classifier';
import type { HitRole, Occurrence, OccurrenceKind, RiskLevel } from './occurrence/types';
import type { LineContext } from './occurrence/text-utils';

/** 单条变更预估耗时（毫秒）；用于 UI 顶部"预计耗时"（NFR-P-06 预算 1500ms） */
export const ESTIMATE_MS_PER_CHANGE = 12;

/** 性能预算（NFR-P-06：1 万行工程影响面分析 ≤1.5s） */
export const IMPACT_BUDGET_MS = 1500;

/** 项目内边界提示（固定文案，UI 顶部展示，FR-UNI-13） */
export const PROJECT_SCOPE_NOTICE =
  '本次重命名仅影响当前项目，不修改长期记忆与其他项目；跨项目复用请手动导入 .ecpkg';

/** 关于长期记忆的补充提示 */
export const LONGTERM_MEMORY_NOTICE =
  '长期记忆（longterm）中的提及不在本次范围内，请在记忆中心自行维护';

/** 投影变化（前后对照表） */
export interface ProjectionChange {
  kind: ProjectionKind;
  oldValue: string;
  newValue: string;
  changed: boolean;
}

/** 一条受影响的变更项 */
export interface ImpactItem {
  /** 出现位置 id（与 `occurrence.id` 一致，逐项勾选用） */
  id: string;
  kind: OccurrenceKind;
  refPath: string;
  locator: string | null;
  matchedSymbol: ProjectionKind | null;
  symbol: string;
  confidence: number;
  riskLevel: RiskLevel;
  role: HitRole | null;
  context: LineContext | null;
  detail: string | null;
  /** 记忆层级（memory 来源） */
  scopeLayer: string | null;
  /** 承载者 id（逻辑结构为 DSL 节点 id；其余为 null） */
  carrierId: string | null;
  /** 承载字段（逻辑结构：name / identifier / binding / action） */
  carrierField: string | null;
  /** 默认是否勾选（warn 默认不勾选） */
  selected: boolean;
  /** 替换前文本 */
  oldText: string;
  /** 替换后文本 */
  newText: string;
}

/** 风险分组 */
export interface ImpactGroup {
  level: RiskLevel;
  label: string;
  hint: string;
  items: ImpactItem[];
  /** 组内默认勾选数 */
  selectedCount: number;
}

/** 影响面报告 */
export interface ImpactReport {
  registryId: string;
  projectId: string;
  oldName: string;
  newName: string;
  oldProjections: ProjectionSet;
  newProjections: ProjectionSet;
  projectionChanges: ProjectionChange[];
  groups: ImpactGroup[];
  totals: {
    total: number;
    auto: number;
    confirm: number;
    warn: number;
    selected: number;
    estimatedMs: number;
  };
  /** 项目内边界提示（D-07） */
  scopeNotice: string;
  /** 被排除的条目说明 */
  excluded: { crossProject: number; longtermMemory: number };
  warnings: string[];
  /** 分析耗时（实测，毫秒） */
  elapsedMs: number;
}

export interface ImpactAnalysisInput {
  registry: RegistryEntry;
  newCanonicalName: string;
  rule: ResolvedNamingRule;
  occurrences: readonly Occurrence[];
  /** 页面上下文（i18n / 路由） */
  scope?: string | undefined;
  /** 分级规则的设置覆写（FR-UNI-04：分级规则可在设置中调整） */
  riskConfig?: RiskConfig | undefined;
  /** 计时器注入；默认 `performance.now` */
  timer?: (() => number) | undefined;
  /** 预算（毫秒），默认 1500 */
  budgetMs?: number | undefined;
}

function defaultTimer(): number {
  const scope = globalThis as { performance?: { now(): number } };
  return scope.performance?.now() ?? Date.now();
}

/**
 * 判断出现位置是否属于本项目（D-07）。
 *
 * 索引只为当前项目构建，因此"跨项目"只可能来自**误传**（例如把别的项目索引合并进来）。
 * 这里做显式防御：不属于本注册表项的一律丢弃并计数。
 */
export function partitionScope(
  registry: RegistryEntry,
  occurrences: readonly Occurrence[],
): { inScope: Occurrence[]; crossProject: number; longtermMemory: number } {
  const inScope: Occurrence[] = [];
  let crossProject = 0;
  let longtermMemory = 0;
  for (const occurrence of occurrences) {
    if (occurrence.registryId !== registry.id) {
      crossProject += 1;
      continue;
    }
    if (occurrence.kind === 'memory' && occurrence.scopeLayer === 'longterm') {
      longtermMemory += 1;
      continue;
    }
    inScope.push(occurrence);
  }
  return { inScope, crossProject, longtermMemory };
}

function newTextOf(
  occurrence: Occurrence,
  projections: ProjectionSet,
  canonicalName: string,
): string {
  if (occurrence.matchedSymbol === null) return canonicalName;
  return projections[occurrence.matchedSymbol];
}

/** 投影前后对照表（八类逐条，`changed` 标出实际变动项） */
export function diffProjections(
  oldProjections: ProjectionSet,
  newProjections: ProjectionSet,
): ProjectionChange[] {
  return PROJECTION_KINDS.map((kind) => ({
    kind,
    oldValue: oldProjections[kind],
    newValue: newProjections[kind],
    changed: oldProjections[kind] !== newProjections[kind],
  }));
}

/** 依据分级把出现位置装配成三组，并统计总计与预计耗时 */
function groupItems(items: readonly ImpactItem[]): ImpactGroup[] {
  const levels: RiskLevel[] = ['auto', 'confirm', 'warn'];
  return levels.map((level) => {
    const levelItems = items.filter((item) => item.riskLevel === level);
    return {
      level,
      label: RISK_LEVEL_LABELS[level],
      hint: RISK_LEVEL_HINTS[level],
      items: levelItems,
      selectedCount: levelItems.filter((item) => item.selected).length,
    };
  });
}

/**
 * 影响面分析。
 *
 * 纯计算：不读文件、不落库、不改代码；耗时用 `elapsedMs` 实测上报。
 */
export function analyzeImpact(input: ImpactAnalysisInput): ImpactReport {
  const timer = input.timer ?? defaultTimer;
  const startedAt = timer();
  const { inScope, crossProject, longtermMemory } = partitionScope(
    input.registry,
    input.occurrences,
  );
  const derived = deriveProjections(input.newCanonicalName, {
    entityType: input.registry.entityType,
    rule: input.rule,
    scope: input.scope,
  });

  const items: ImpactItem[] = inScope.map((occurrence) => {
    const newText = newTextOf(occurrence, derived.projections, input.newCanonicalName);
    return {
      id: occurrence.id,
      kind: occurrence.kind,
      refPath: occurrence.refPath,
      locator: occurrence.locator,
      matchedSymbol: occurrence.matchedSymbol,
      symbol: occurrence.symbol,
      confidence: occurrence.confidence,
      riskLevel: occurrence.riskLevel,
      role: occurrence.role,
      context: occurrence.context,
      detail: occurrence.detail,
      scopeLayer: occurrence.scopeLayer ?? null,
      carrierId: occurrence.carrierId ?? null,
      carrierField: occurrence.carrierField ?? null,
      selected: isSelectedByDefault(occurrence.riskLevel),
      oldText: occurrence.symbol,
      newText,
    };
  });

  const groups = groupItems(items);
  const totals = {
    total: items.length,
    auto: groups[0]?.items.length ?? 0,
    confirm: groups[1]?.items.length ?? 0,
    warn: groups[2]?.items.length ?? 0,
    selected: items.filter((item) => item.selected).length,
    estimatedMs: Number((items.length * ESTIMATE_MS_PER_CHANGE).toFixed(2)),
  };

  const warnings: string[] = [];
  if (crossProject > 0) {
    warnings.push(`已忽略 ${crossProject} 条非本项目条目（D-07：重命名不跨项目）`);
  }
  if (longtermMemory > 0) {
    warnings.push(`已排除 ${longtermMemory} 条长期记忆提及（${LONGTERM_MEMORY_NOTICE}）`);
  }
  const elapsedMs = Math.max(0, timer() - startedAt);
  const budget = input.budgetMs ?? IMPACT_BUDGET_MS;
  if (elapsedMs > budget) {
    warnings.push(`影响面分析耗时 ${elapsedMs.toFixed(2)}ms 超出预算 ${budget}ms`);
  }

  return {
    registryId: input.registry.id,
    projectId: input.registry.projectId,
    oldName: input.registry.canonicalName,
    newName: input.newCanonicalName,
    oldProjections: input.registry.projections,
    newProjections: derived.projections,
    projectionChanges: diffProjections(input.registry.projections, derived.projections),
    groups,
    totals,
    scopeNotice: PROJECT_SCOPE_NOTICE,
    excluded: { crossProject, longtermMemory },
    warnings,
    elapsedMs: Number(elapsedMs.toFixed(2)),
  };
}

/** 勾选状态汇总：把 UI 的勾选结果折算成"实际将执行的变更项" */
export function selectedItems(report: ImpactReport, selection: ReadonlySet<string>): ImpactItem[] {
  return report.groups.flatMap((group) => group.items.filter((item) => selection.has(item.id)));
}

/** 由报告生成默认勾选集合（auto + confirm） */
export function defaultSelection(report: ImpactReport): Set<string> {
  const selection = new Set<string>();
  for (const group of report.groups) {
    for (const item of group.items) if (item.selected) selection.add(item.id);
  }
  return selection;
}

/** 报告 → 顶部一句话摘要（"将修改 N 处，其中确认区 M 处、警告区 K 处"） */
export function summarizeImpact(report: ImpactReport): string {
  return `将修改 ${report.totals.selected} 处，其中确认区 ${report.totals.confirm} 处、警告区 ${report.totals.warn} 处（共发现 ${report.totals.total} 处，预计 ${report.totals.estimatedMs}ms）`;
}
