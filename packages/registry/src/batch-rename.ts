/**
 * 批处理与命名规范化（T7-05 要点 5，FR-UNI-14）。
 *
 * 两类批处理：
 * 1. **多选对象批量重命名**：每个对象独立校验 + 独立影响面；非法的**整体阻断**（不部分执行）；
 * 2. **一键全项目命名规范化**：规范名不变，只按当前命名规则**重新对齐八类投影**
 *    （历史遗留的 `用户登录按钮 → yongHuDengLuAnNiu` 这类投影会被纠正为 `UserLoginButton`）。
 *
 * 两者都复用 T7-04 的事务：逐项执行，**任一项失败则把已完成项整体撤销**
 * （`undoRename` 依据各自的事件），因此批处理同样具备 diff 预览与事务回滚。
 *
 * 实现要点：规范化不需要新的执行路径——把"新规范名 = 旧规范名"交给
 * `analyzeImpact` 即可：`oldText` 是代码里现存（旧）投影，`newText` 是重算后的新投影，
 * 由此天然得到"投影级 diff"。
 */

import { checkName, type ConflictCheckResult, type SymbolTable } from './conflict-check';
import { analyzeImpact, type ImpactReport } from './impact-analyzer';
import { applyRename, type RegistryEntry } from './registry-model';
import type { ResolvedNamingRule } from './naming/presets';
import {
  executeRename,
  undoRename,
  type RenameTransactionDeps,
  type RenameTransactionResult,
} from './rename-transaction';
import type { Occurrence } from './occurrence/types';
import type { RiskConfig } from './occurrence/risk-classifier';
import { newUlid } from './ids';

/** 批量重命名的单项请求 */
export interface BatchRenameItem {
  registry: RegistryEntry;
  newCanonicalName: string;
  /** 该对象的出现位置索引（来自 T7-02） */
  occurrences: readonly Occurrence[];
}

export interface BatchStepPlan {
  /** 该步骤对应的注册表项（执行时需要；结构为纯 JSON，可序列化进计划快照） */
  registry: RegistryEntry;
  registryId: string;
  entityType: RegistryEntry['entityType'];
  oldName: string;
  newName: string;
  /** 合法性校验结果（不通过则整批阻断） */
  check: ConflictCheckResult;
  /** 影响面报告（用于 diff 预览） */
  report: ImpactReport;
  /** 默认勾选集合（auto + confirm） */
  selected: ReadonlySet<string>;
  /** 投影是否真的发生变化（规范化时用于判断是否需要执行） */
  projectionChanged: boolean;
}

export interface BatchPlan {
  batchId: string;
  projectId: string;
  createdAt: number;
  /** 是否为"全项目命名规范化"模式 */
  normalize: boolean;
  steps: BatchStepPlan[];
  /** 被阻断的步骤（存在则不允许执行，除非用户先修正名称） */
  blocked: { registryId: string; newName: string; violations: ConflictCheckResult['violations'] }[];
  totals: {
    items: number;
    totalChanges: number;
    selectedChanges: number;
    estimatedMs: number;
  };
  /** 作用范围提示（D-07） */
  scopeNotice: string;
}

export interface PlanBatchInput {
  projectId: string;
  items: readonly BatchRenameItem[];
  rule: ResolvedNamingRule;
  symbols?: SymbolTable | undefined;
  riskConfig?: RiskConfig | undefined;
  now?: number | undefined;
  random?: (() => number) | undefined;
  timer?: (() => number) | undefined;
}

function selectDefault(report: ImpactReport): Set<string> {
  const selection = new Set<string>();
  for (const group of report.groups) {
    for (const item of group.items) if (item.selected) selection.add(item.id);
  }
  return selection;
}

/** 规划批量重命名（纯计算，不写任何东西） */
export function planBatchRename(input: PlanBatchInput): BatchPlan {
  const now = input.now ?? Date.now();
  const steps: BatchStepPlan[] = [];
  const blocked: BatchPlan['blocked'] = [];

  for (const item of input.items) {
    const check = checkName({
      canonicalName: item.newCanonicalName,
      entityType: item.registry.entityType,
      rule: input.rule,
      ...(input.symbols !== undefined ? { symbols: input.symbols } : {}),
    });
    const report = analyzeImpact({
      registry: item.registry,
      newCanonicalName: item.newCanonicalName,
      rule: input.rule,
      occurrences: item.occurrences,
      ...(input.riskConfig !== undefined ? { riskConfig: input.riskConfig } : {}),
      ...(input.timer !== undefined ? { timer: input.timer } : {}),
    });
    if (!check.ok) {
      blocked.push({
        registryId: item.registry.id,
        newName: item.newCanonicalName,
        violations: check.violations,
      });
      continue;
    }
    steps.push({
      registry: item.registry,
      registryId: item.registry.id,
      entityType: item.registry.entityType,
      oldName: item.registry.canonicalName,
      newName: item.newCanonicalName,
      check,
      report,
      selected: selectDefault(report),
      projectionChanged: report.projectionChanges.some((change) => change.changed),
    });
  }

  return {
    batchId: newUlid(now, input.random ?? Math.random),
    projectId: input.projectId,
    createdAt: now,
    normalize: false,
    steps,
    blocked,
    totals: {
      items: steps.length,
      totalChanges: steps.reduce((sum, step) => sum + step.report.totals.total, 0),
      selectedChanges: steps.reduce((sum, step) => sum + step.selected.size, 0),
      estimatedMs: steps.reduce((sum, step) => sum + step.report.totals.estimatedMs, 0),
    },
    scopeNotice: steps[0]?.report.scopeNotice ?? '仅限当前项目生效',
  };
}

export interface PlanNormalizeInput {
  projectId: string;
  /** 项目中全部注册表项 */
  entries: readonly RegistryEntry[];
  /** 每个对象的出现位置索引 */
  occurrencesOf: (registryId: string) => readonly Occurrence[];
  rule: ResolvedNamingRule;
  riskConfig?: RiskConfig | undefined;
  now?: number | undefined;
  random?: (() => number) | undefined;
  timer?: (() => number) | undefined;
}

/**
 * 一键全项目命名规范化（FR-UNI-14）。
 *
 * 逐项比较"当前投影"与"按规则重算的投影"，**只有存在漂移的对象**才进入计划，
 * 因此对已经规范的项目是空操作（不会产生无意义的 Git 提交）。
 */
export function planNormalization(input: PlanNormalizeInput): BatchPlan {
  const now = input.now ?? Date.now();
  const steps: BatchStepPlan[] = [];

  for (const entry of input.entries) {
    const reprojected = applyRename({
      entry,
      newCanonicalName: entry.canonicalName,
      rule: input.rule,
      now,
    });
    const drifted = (Object.keys(entry.projections) as (keyof typeof entry.projections)[]).some(
      (kind) => entry.projections[kind] !== reprojected.projections[kind],
    );
    if (!drifted) continue;
    const report = analyzeImpact({
      registry: entry,
      newCanonicalName: entry.canonicalName,
      rule: input.rule,
      occurrences: input.occurrencesOf(entry.id),
      ...(input.riskConfig !== undefined ? { riskConfig: input.riskConfig } : {}),
      ...(input.timer !== undefined ? { timer: input.timer } : {}),
    });
    const check = checkName({
      canonicalName: entry.canonicalName,
      entityType: entry.entityType,
      rule: input.rule,
    });
    steps.push({
      registry: entry,
      registryId: entry.id,
      entityType: entry.entityType,
      oldName: entry.canonicalName,
      newName: entry.canonicalName,
      check,
      report,
      selected: selectDefault(report),
      projectionChanged: true,
    });
  }

  return {
    batchId: newUlid(now, input.random ?? Math.random),
    projectId: input.projectId,
    createdAt: now,
    normalize: true,
    steps,
    blocked: [],
    totals: {
      items: steps.length,
      totalChanges: steps.reduce((sum, step) => sum + step.report.totals.total, 0),
      selectedChanges: steps.reduce((sum, step) => sum + step.selected.size, 0),
      estimatedMs: steps.reduce((sum, step) => sum + step.report.totals.estimatedMs, 0),
    },
    scopeNotice: steps[0]?.report.scopeNotice ?? '仅限当前项目生效',
  };
}

/* ------------------------------- 执行 ------------------------------- */

export interface BatchStepResult {
  registryId: string;
  ok: boolean;
  applied: number;
  failures: string[];
  transaction: RenameTransactionResult;
}

export interface BatchRenameResult {
  ok: boolean;
  batchId: string;
  steps: BatchStepResult[];
  applied: number;
  /** 失败后是否把已完成项整体撤销 */
  rolledBack: boolean;
  rollbackFailures: string[];
  failures: string[];
}

export interface ExecuteBatchInput {
  plan: BatchPlan;
  /** 事务依赖（不含 executors，可覆盖） */
  deps: RenameTransactionDeps;
  /** 逐项勾选覆盖；缺省用计划里的默认勾选 */
  selectionOf?: ((step: BatchStepPlan) => ReadonlySet<string>) | undefined;
  /** 任一项失败是否整体撤销已完成项，默认 true */
  stopOnFailure?: boolean | undefined;
}

/**
 * 执行批量计划。
 *
 * 逐项调用 T7-04 事务；任一项失败时，若 `stopOnFailure !== false`，
 * 则按**逆序**对已完成项执行 `undoRename`，保证批处理也是"全有或全无"。
 */
export function executeBatchRename(input: ExecuteBatchInput): BatchRenameResult {
  const stopOnFailure = input.stopOnFailure !== false;
  const results: BatchStepResult[] = [];
  const completed: { registry: RegistryEntry; result: RenameTransactionResult }[] = [];
  const failures: string[] = [];

  if (input.plan.blocked.length > 0) {
    return {
      ok: false,
      batchId: input.plan.batchId,
      steps: [],
      applied: 0,
      rolledBack: false,
      rollbackFailures: [],
      failures: [`存在 ${input.plan.blocked.length} 个非法名称，已整批阻断（未执行任何变更）`],
    };
  }

  for (const step of input.plan.steps) {
    const registry = step.registry;
    const selection = input.selectionOf?.(step) ?? step.selected;
    const transaction = executeRename({
      registry,
      newCanonicalName: step.newName,
      report: step.report,
      selection,
      deps: input.deps,
    });
    results.push({
      registryId: step.registryId,
      ok: transaction.ok,
      applied: transaction.applied,
      failures: transaction.failures,
      transaction,
    });
    if (!transaction.ok) {
      failures.push(...transaction.failures.map((failure) => `[${step.registryId}] ${failure}`));
      break;
    }
    completed.push({ registry, result: transaction });
  }

  const applied = results.reduce((sum, result) => sum + result.applied, 0);
  let rolledBack = false;
  const rollbackFailures: string[] = [];

  if (failures.length > 0 && stopOnFailure) {
    for (const item of [...completed].reverse()) {
      const event = item.result.event;
      if (event === null) continue;
      const undo = undoRename({ event, deps: input.deps });
      if (!undo.ok) rollbackFailures.push(...undo.failures);
    }
    rolledBack = rollbackFailures.length === 0;
  }

  return {
    ok: failures.length === 0,
    batchId: input.plan.batchId,
    steps: results,
    applied: rolledBack ? 0 : applied,
    rolledBack,
    rollbackFailures,
    failures,
  };
}
