/**
 * 重命名事务（T7-04 要点 2/7/8，FR-UNI-12 / NFR-R-04 / NFR-P-07）。
 *
 * 执行顺序（固定，见 `executors/EXECUTION_ORDER`）：
 * ```
 * ① AST 级代码重构 → ② 文档替换 → ③ 记忆更新 → ④ 逻辑结构重算 → ⑤ 注册表与锚点更新
 * ```
 * **任一步失败整体回滚**：所有已成功的执行器按**逆序** revert，
 * 文件字节级还原走 `FileSnapshot`，记忆 / DSL / 锚点走 `ExecutorStateSnapshot`；
 * 注册表在 ⑤ 之前不落库，因此失败时注册表天然无中间态。
 *
 * 成功后：
 * - 写回注册表项（新规范名 + 新投影 + 历史名）；
 * - 生成 `refactor(rename): A → B` Git 提交；
 * - 记录 rename 事件（含完整变更集与 commit sha），供审计与一键撤销。
 *
 * 全程可中断（`ExecutionContext.signal`）：中断视作失败并整体回滚（NFR-P-07）。
 * 事务是**同步**的；Git 提交端口返回 sha（外壳内部可异步，事务不等待 UI 渲染）。
 */

import { applyRename, type RegistryEntry } from './registry-model';
import type { ResolvedNamingRule } from './naming/presets';
import type { ImpactReport } from './impact-analyzer';
import {
  buildRenameCommitMessage,
  buildUndoCommitMessage,
  createRenameEvent,
  type ChangeSet,
  type ChangeSetSegment,
  type RenameEvent,
  type RenameEventStore,
} from './rename-event';
import { hydrateSnapshot, resetBackupSequence } from './executors/backup';
import { EXECUTION_ORDER, createDefaultExecutors } from './executors';
import type {
  ChangeRecord,
  ExecutionContext,
  ExecutorResult,
  ExecutorStateSnapshot,
  FileSnapshot,
  RenameExecutor,
  SymbolPair,
} from './executors/types';
import { parseLocator } from './occurrence/text-utils';
import type { OccurrenceKind } from './occurrence/types';
import { newUlid } from './ids';

/* ------------------------------- 端口 ------------------------------- */

/** 注册表写回端口（外壳绑定 `@ec/data` 的 registry_entry 仓库） */
export interface RegistryWritePort {
  save(entry: RegistryEntry): void;
}

/** Git 提交端口（外壳绑定 `@ec/git`；返回 commit sha，失败返回 null） */
export interface GitCommitPort {
  commit(input: { message: string; paths: readonly string[] }): string | null;
}

export interface RenameTransactionDeps {
  context: ExecutionContext;
  rule: ResolvedNamingRule;
  /** 执行器（默认五个；测试可注入带故障的执行器） */
  executors?: readonly RenameExecutor[] | undefined;
  registry?: RegistryWritePort | null | undefined;
  git?: GitCommitPort | null | undefined;
  events?: RenameEventStore | null | undefined;
  now?: number | undefined;
  random?: (() => number) | undefined;
  /** 计时器（性能口径 NFR-P-07：≤200 处变更 ≤5s） */
  timer?: (() => number) | undefined;
  /** 成功后是否为旧名生成别名（FR-UNI-10，属 T7-05 的可选项） */
  alias?: { kind: 'code' | 'api' | 'i18n'; cleanupDueAt?: number | null; note?: string | null } | undefined;
}

/* ------------------------------- 结果 ------------------------------- */

export interface SegmentReport {
  executorId: string;
  column: OccurrenceKind;
  label: string;
  applied: number;
  skipped: number;
  failures: string[];
  warnings: string[];
}

export interface RenameTransactionResult {
  ok: boolean;
  transactionId: string;
  oldName: string;
  newName: string;
  segments: SegmentReport[];
  applied: number;
  skipped: number;
  failures: string[];
  warnings: string[];
  rollback: { performed: boolean; steps: string[] };
  changeset: ChangeSet | null;
  event: RenameEvent | null;
  commitSha: string | null;
  aborted: boolean;
  elapsedMs: number;
}

export interface UndoResult {
  ok: boolean;
  failures: string[];
  /** 已还原的目标（文件 / 文档 / 记忆 / DSL / 锚点 / 注册表） */
  restored: string[];
  commitSha: string | null;
}

/* ------------------------------- 工具 ------------------------------- */

function defaultTimer(): number {
  const scope = globalThis as { performance?: { now(): number } };
  return scope.performance?.now() ?? Date.now();
}

/**
 * 由影响面报告 + 勾选集合展开为逐处变更。
 *
 * `code` 栏的 `file:line:col` 在这里解析成行列，执行器再用它复核位置——
 * **位置不是凭空算出来的，而是索引（AST）给出的**（FR-UNI-06）。
 */
export function buildChangeRecords(report: ImpactReport, selection: ReadonlySet<string>): ChangeRecord[] {
  const records: ChangeRecord[] = [];
  for (const group of report.groups) {
    for (const item of group.items) {
      if (!selection.has(item.id)) continue;
      const parsed = item.kind === 'code' && item.locator !== null ? parseLocator(item.locator) : null;
      records.push({
        id: item.id,
        column: item.kind,
        refPath: item.refPath,
        locator: item.locator,
        carrierId: item.carrierId,
        carrierField: item.carrierField,
        matchedSymbol: item.matchedSymbol,
        target: item.oldText,
        replacement: item.newText,
        line: parsed === null ? null : parsed.line,
        columnNumber: parsed === null ? null : parsed.column,
      });
    }
  }
  return records;
}

/**
 * 符号替换对。
 *
 * 规范名与**全部变更过的投影**都要参与锚点同步：注册表会整体换成新投影，
 * 锚点必须跟着走，否则 Ctrl + 点击会指向旧符号（FR-NAV-04）。
 */
export function buildSymbolPairs(report: ImpactReport): SymbolPair[] {
  const pairs: SymbolPair[] = [{ from: report.oldName, to: report.newName, matchedSymbol: null }];
  for (const change of report.projectionChanges) {
    if (!change.changed || change.oldValue.length === 0) continue;
    pairs.push({ from: change.oldValue, to: change.newValue, matchedSymbol: change.kind });
  }
  return pairs;
}

function toSegmentReport(executor: RenameExecutor, result: ExecutorResult): SegmentReport {
  return {
    executorId: executor.id,
    column: result.column,
    label: executor.label,
    applied: result.applied,
    skipped: result.skipped,
    failures: [...result.failures],
    warnings: [...result.warnings],
  };
}

/** 回滚：逆序 revert 全部已执行的执行器（含失败者自身的部分写入） */
function rollbackExecutions(
  executions: { executor: RenameExecutor; result: ExecutorResult }[],
  context: ExecutionContext,
): string[] {
  const steps: string[] = [];
  for (const { executor, result } of [...executions].reverse()) {
    try {
      executor.revert(result, context);
      steps.push(`${executor.id}: 已回滚 ${result.applied} 处`);
    } catch (error) {
      steps.push(`${executor.id}: 回滚失败 ${String(error)}`);
    }
  }
  return steps;
}

/* ------------------------------- 执行 ------------------------------- */

export interface ExecuteRenameInput {
  registry: RegistryEntry;
  newCanonicalName: string;
  report: ImpactReport;
  selection: ReadonlySet<string>;
  deps: RenameTransactionDeps;
}

/**
 * 事务化执行重命名。
 *
 * 前置：调用方必须先跑 `conflict-check`（非法名阻断）与 `analyzeImpact`（影响面）。
 * 本函数不重复校验，只保证**原子性**。
 */
export function executeRename(input: ExecuteRenameInput): RenameTransactionResult {
  const timer = input.deps.timer ?? defaultTimer;
  const startedAt = timer();
  const now = input.deps.now ?? Date.now();
  const random = input.deps.random ?? Math.random;
  const executors = input.deps.executors ?? createDefaultExecutors();
  const context = input.deps.context;
  const transactionId = newUlid(now, random);
  resetBackupSequence();

  const base: RenameTransactionResult = {
    ok: false,
    transactionId,
    oldName: input.registry.canonicalName,
    newName: input.newCanonicalName,
    segments: [],
    applied: 0,
    skipped: 0,
    failures: [],
    warnings: [],
    rollback: { performed: false, steps: [] },
    changeset: null,
    event: null,
    commitSha: null,
    aborted: context.signal?.aborted === true,
    elapsedMs: 0,
  };

  const changes = buildChangeRecords(input.report, input.selection);
  if (changes.length === 0) {
    return { ...base, failures: ['未勾选任何变更项，已取消执行'], elapsedMs: 0 };
  }
  if (base.aborted) {
    return { ...base, failures: ['执行已被中断'], elapsedMs: 0 };
  }

  const symbolPairs = buildSymbolPairs(input.report);
  const ordered = EXECUTION_ORDER.map((id) => executors.find((executor) => executor.id === id)).filter(
    (executor): executor is RenameExecutor => executor !== undefined,
  );

  const executions: { executor: RenameExecutor; result: ExecutorResult }[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  let aborted = false;

  for (const executor of ordered) {
    if (context.signal?.aborted === true) {
      aborted = true;
      failures.push(`执行已被中断（${executor.id} 之后的步骤未执行）`);
      break;
    }
    const result = executor.apply({ changes, symbolPairs }, context);
    executions.push({ executor, result });
    warnings.push(...result.warnings);
    if (result.failures.length > 0) {
      failures.push(...result.failures.map((failure) => `[${executor.id}] ${failure}`));
      break;
    }
  }

  const segments = executions.map(({ executor, result }) => toSegmentReport(executor, result));
  const applied = executions.reduce((sum, item) => sum + item.result.applied, 0);
  const skipped = executions.reduce((sum, item) => sum + item.result.skipped, 0);

  if (failures.length > 0) {
    const steps = rollbackExecutions(executions, context);
    return {
      ...base,
      aborted,
      segments,
      applied: 0,
      skipped,
      failures,
      warnings: [...warnings, `已整体回滚：${steps.join('；')}`],
      rollback: { performed: true, steps },
      elapsedMs: Number((timer() - startedAt).toFixed(2)),
    };
  }

  /* --------------------- ⑤ 注册表写回 + Git 提交 + 事件 --------------------- */
  const commitMessage = buildRenameCommitMessage(input.registry.canonicalName, input.newCanonicalName);
  const nextEntry = applyRename({
    entry: input.registry,
    newCanonicalName: input.newCanonicalName,
    rule: input.deps.rule,
    now,
    ...(input.deps.alias !== undefined
      ? {
          alias: {
            kind: input.deps.alias.kind,
            cleanupDueAt: input.deps.alias.cleanupDueAt ?? null,
            note: input.deps.alias.note ?? null,
          },
        }
      : {}),
    reason: commitMessage,
  });

  const changeset: ChangeSet = {
    registryId: input.registry.id,
    projectId: input.registry.projectId,
    oldName: input.registry.canonicalName,
    newName: input.newCanonicalName,
    scope: 'project',
    createdAt: now,
    segments: segments.map((segment, index): ChangeSetSegment => ({
      ...segment,
      undo: executions[index]?.result.undo ?? [],
    })),
    snapshots: dedupeSnapshots(executions.flatMap((item) => item.result.snapshots)),
    stateSnapshots: dedupeStateSnapshots(executions.flatMap((item) => item.result.stateSnapshots)),
    projections: {
      before: input.registry.projections,
      after: nextEntry.projections,
    },
    registryBefore: input.registry,
    registryAfter: nextEntry,
    commitMessage,
  };

  try {
    input.deps.registry?.save(nextEntry);
  } catch (error) {
    const steps = rollbackExecutions(executions, context);
    return {
      ...base,
      segments,
      skipped,
      failures: [`写回注册表失败：${String(error)}`],
      warnings: [...warnings, `已整体回滚：${steps.join('；')}`],
      rollback: { performed: true, steps },
      elapsedMs: Number((timer() - startedAt).toFixed(2)),
    };
  }

  let commitSha: string | null = null;
  try {
    commitSha = input.deps.git?.commit({ message: commitMessage, paths: touchedPaths(changeset) }) ?? null;
  } catch (error) {
    warnings.push(`Git 提交失败（改动已落盘，可稍后在 Git 面板手动提交）：${String(error)}`);
  }

  const event = createRenameEvent({
    projectId: input.registry.projectId,
    registryId: input.registry.id,
    oldName: input.registry.canonicalName,
    newName: input.newCanonicalName,
    changeset,
    commitSha,
    now,
    random,
  });
  try {
    input.deps.events?.append(event);
  } catch (error) {
    warnings.push(`记录 rename 事件失败：${String(error)}`);
  }

  return {
    ok: true,
    transactionId,
    oldName: input.registry.canonicalName,
    newName: input.newCanonicalName,
    segments,
    applied,
    skipped,
    failures: [],
    warnings,
    rollback: { performed: false, steps: [] },
    changeset,
    event,
    commitSha,
    aborted: false,
    elapsedMs: Number((timer() - startedAt).toFixed(2)),
  };
}

function dedupeSnapshots(snapshots: readonly FileSnapshot[]): FileSnapshot[] {
  const map = new Map<string, FileSnapshot>();
  for (const snapshot of snapshots) map.set(`${snapshot.column}|${snapshot.refPath}`, snapshot);
  return [...map.values()];
}

function dedupeStateSnapshots(snapshots: readonly ExecutorStateSnapshot[]): ExecutorStateSnapshot[] {
  const map = new Map<string, ExecutorStateSnapshot>();
  for (const snapshot of snapshots) map.set(`${snapshot.kind}|${snapshot.id}`, snapshot);
  return [...map.values()];
}

/** 本次事务触碰到的路径（Git 提交用；文档与记忆不落 Git 路径） */
export function touchedPaths(changeset: ChangeSet): string[] {
  const paths = new Set<string>();
  for (const segment of changeset.segments) {
    for (const patch of segment.undo) {
      if (patch.column === 'code') paths.add(patch.refPath);
    }
  }
  return [...paths];
}

/**
 * 执行器 → 它自己产生的状态快照类别。
 *
 * `logic-recalc` 与 `anchor-sync` 同属 `logic` 栏，但快照类别不同，必须按**执行器 id** 派发，
 * 否则撤销时会把 DSL 快照交给锚点执行器（或反之）。
 */
const STATE_KIND_BY_EXECUTOR: Readonly<Record<string, 'memory' | 'logic' | 'anchor' | null>> = {
  'code-ast': null,
  'doc-replace': null,
  'memory-update': 'memory',
  'logic-recalc': 'logic',
  'anchor-sync': 'anchor',
};

/* ------------------------------- 一键撤销 ------------------------------- */

export interface UndoRenameInput {
  event: RenameEvent;
  deps: RenameTransactionDeps;
}

/**
 * 一键撤销（FR-UNI-12 / E2E-17）。
 *
 * 逆序还原五个执行器的产物 → 还原注册表项 → 标记事件为已撤销 → 生成 `revert(rename)` 提交。
 * 撤销**不再走 AST**：直接按快照还原字节，因此即使索引已过期也能可靠还原。
 */
export function undoRename(input: UndoRenameInput): UndoResult {
  const changeset = input.event.changeset;
  if (changeset === null) {
    return { ok: false, failures: ['该重命名缺少变更集，无法撤销'], restored: [], commitSha: null };
  }
  /**
   * 重复撤销防护：既看调用方持有的对象，也**回查事件仓库的当前状态**。
   * 仓库的 `markUndone` 会返回新对象，调用方手里的引用可能是陈旧的——
   * 撤销是破坏性操作，宁可多查一次也不能重复执行。
   */
  const undoneInStore = input.deps.events?.get(input.event.id)?.undone === true;
  if (input.event.undone || undoneInStore) {
    return { ok: false, failures: ['该重命名已撤销，无需重复操作'], restored: [], commitSha: null };
  }
  const context = input.deps.context;
  const executors = input.deps.executors ?? createDefaultExecutors();
  const failures: string[] = [];
  const restored: string[] = [];

  const ordered = [...EXECUTION_ORDER]
    .map((id) => executors.find((executor) => executor.id === id))
    .filter((executor): executor is RenameExecutor => executor !== undefined)
    .reverse();

  for (const executor of ordered) {
    const segment = changeset.segments.find((item) => item.executorId === executor.id);
    const fileSnapshots = changeset.snapshots
      .filter((snapshot) => snapshot.column === executor.column)
      .map((snapshot) => hydrateSnapshot(snapshot, context.files));
    const stateKind = STATE_KIND_BY_EXECUTOR[executor.id];
    const stateSnapshots =
      stateKind === null ? [] : changeset.stateSnapshots.filter((snapshot) => snapshot.kind === stateKind);

    // 无撤销素材的执行器直接跳过（例如本次没有代码改动）
    if (
      (segment === undefined || segment.undo.length === 0) &&
      fileSnapshots.length === 0 &&
      stateSnapshots.length === 0
    ) {
      continue;
    }

    const rebuilt: ExecutorResult = {
      column: executor.column,
      applied: segment?.applied ?? 0,
      skipped: 0,
      failures: [],
      undo: segment?.undo ?? [],
      snapshots: fileSnapshots,
      stateSnapshots,
      warnings: [],
    };
    try {
      executor.revert(rebuilt, context);
      restored.push(...fileSnapshots.map((snapshot) => snapshot.refPath));
      restored.push(...stateSnapshots.map((snapshot) => snapshot.id));
    } catch (error) {
      failures.push(`[${executor.id}] 撤销失败：${String(error)}`);
    }
  }

  if (failures.length > 0) {
    return { ok: false, failures, restored, commitSha: null };
  }

  try {
    input.deps.registry?.save(changeset.registryBefore);
    restored.push(`registry:${changeset.registryId}`);
  } catch (error) {
    failures.push(`还原注册表失败：${String(error)}`);
    return { ok: false, failures, restored, commitSha: null };
  }

  input.deps.events?.markUndone(input.event.id);

  let commitSha: string | null = null;
  try {
    commitSha =
      input.deps.git?.commit({
        message: buildUndoCommitMessage(input.event.oldName, input.event.newName),
        paths: touchedPaths(changeset),
      }) ?? null;
  } catch {
    commitSha = null;
  }

  return { ok: true, failures: [], restored, commitSha };
}
