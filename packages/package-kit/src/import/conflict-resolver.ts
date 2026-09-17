/**
 * 冲突解决器（T8-03）。
 *
 * 职责：
 * 1. `buildDiffPreview`：把包内对象与本地对象做差异分类（added / conflicted /
 *    unchanged / missing），四类统计。记忆对象复用 `@ec/memory` 的 `classifyImport`
 *    （口径 id + updatedAt），其余通用对象（document/design/registry/code/anchor/
 *    pipeline）按 id + updatedAt + payload 比对。
 * 2. `resolveConflicts`：把逐条/批量决策落地为 `ResolutionPlan`。未决策的冲突条目
 *    **默认 keepLocal（绝不自动覆盖本地）**；keepBoth 生成新 id（ULID 风格）并保持原 payload。
 *
 * 注：E2E-14 的"整体拒绝"硬约束由 `import-job.runImport` 在执行前统一校验，本模块只
 * 负责在拿到（已聚合的）决策后产出计划，默认口径为安全的 keepLocal。
 */

import { randomUUID } from 'node:crypto';
import { classifyImport, type MemoryItem } from '@ec/memory';
import type {
  ConflictDecision,
  ConflictResolution,
  ImportLocalStatePort,
  PackageDiffItem,
  PackageDiffPreview,
  PackageObject,
  PackageObjectType,
  ResolutionOutcome,
  ResolutionPlan,
} from './import-types';

/** 通用（非记忆）对象类别 */
const GENERIC_TYPES: readonly PackageObjectType[] = ['document', 'design', 'registry', 'code', 'anchor', 'pipeline'];
/** 全部 7 类（用于 missingLocals 盘点） */
const ALL_TYPES: readonly PackageObjectType[] = [
  'memory',
  'document',
  'design',
  'registry',
  'code',
  'anchor',
  'pipeline',
];

/** 把包内/本地记忆 JSON 负载解析为 MemoryItem（宽松，不强制不变量） */
function parseMemoryPayload(pkg: PackageObject): MemoryItem {
  return JSON.parse(pkg.payload) as MemoryItem;
}

function defaultResolution(classification: PackageDiffItem['classification']): ConflictResolution {
  switch (classification) {
    case 'added':
      return 'takeNew';
    case 'unchanged':
    case 'missing':
    case 'conflicted':
    default:
      // 默认不覆盖本地
      return 'keepLocal';
  }
}

/** 生成 keepBoth 的新 id（ULID 风格，保证唯一） */
function generateNewId(): string {
  return randomUUID();
}

/**
 * 差异预览：包内对象 vs 本地对象。记忆走 classifyImport；通用对象走 id+updatedAt+payload。
 */
export function buildDiffPreview(incoming: readonly PackageObject[], localPort: ImportLocalStatePort): PackageDiffPreview {
  const items: PackageDiffItem[] = [];
  const counts = { added: 0, conflicted: 0, unchanged: 0, missing: 0 };

  const bump = (classification: PackageDiffItem['classification']): void => {
    counts[classification] += 1;
  };

  // —— 记忆：复用 @ec/memory classifyImport ——
  const incomingMemory = incoming.filter((o) => o.type === 'memory');
  const incomingMemoryItems = incomingMemory.map(parseMemoryPayload);
  const localMemory = localPort.listObjects('memory', null).map(parseMemoryPayload);
  const memoryPreview = classifyImport(incomingMemoryItems, localMemory);
  for (const diff of memoryPreview.items) {
    const inc = incomingMemory.find((o) => o.id === diff.incoming.id) ?? null;
    if (inc === null) continue;
    const localPkg = localMemory.length > 0 ? localPort.listObjects('memory', null).find((o) => o.id === diff.incoming.id) ?? null : null;
    items.push({ incoming: inc, local: localPkg, classification: diff.classification });
    bump(diff.classification);
  }

  // —— 通用对象：id + updatedAt + payload 比对 ——
  for (const type of GENERIC_TYPES) {
    const incs = incoming.filter((o) => o.type === type);
    if (incs.length === 0) continue;
    const locals = localPort.listObjects(type, null);
    const localById = new Map(locals.map((l) => [l.id, l]));
    for (const o of incs) {
      const local = localById.get(o.id) ?? null;
      let classification: PackageDiffItem['classification'];
      if (!local) {
        classification = 'added';
      } else if (local.updatedAt === o.updatedAt && local.payload === o.payload) {
        classification = 'unchanged';
      } else {
        classification = 'conflicted';
      }
      items.push({ incoming: o, local, classification });
      bump(classification);
    }
  }

  // —— missingLocals：本地有、包里没有的对象 ——
  const incomingIds = new Set(incoming.map((o) => o.id));
  const missingLocals: PackageObject[] = [];
  for (const type of ALL_TYPES) {
    for (const l of localPort.listObjects(type, null)) {
      if (!incomingIds.has(l.id)) missingLocals.push(l);
    }
  }
  counts.missing = missingLocals.length;

  return { items, counts, missingLocals };
}

/**
 * 把（已聚合逐条+批量）决策落地为合并计划。
 *
 * - 逐条决策优先；未决策按分类取默认（conflicted/unchanged → keepLocal，added → takeNew）。
 * - keepBoth：以新 id 复制一份 incoming（payload 不变），原本地保留。
 * - summary 统计 keepLocal / takeNew / keepBoth 条数。
 */
export function resolveConflicts(
  preview: PackageDiffPreview,
  decisions: readonly ConflictDecision[],
): ResolutionPlan {
  const decisionById = new Map(decisions.map((d) => [d.id, d.resolution]));
  const outcomes: ResolutionOutcome[] = [];
  const summary = { keepLocal: 0, takeNew: 0, keepBoth: 0 };

  for (const item of preview.items) {
    const explicit = decisionById.get(item.incoming.id);
    const resolution: ConflictResolution = explicit ?? defaultResolution(item.classification);

    if (resolution === 'keepBoth') {
      const created: PackageObject = { ...item.incoming, id: generateNewId() };
      outcomes.push({ id: item.incoming.id, resolution, incoming: item.incoming, created });
      summary.keepBoth += 1;
    } else {
      outcomes.push({ id: item.incoming.id, resolution, incoming: item.incoming, created: null });
      if (resolution === 'keepLocal') summary.keepLocal += 1;
      else summary.takeNew += 1;
    }
  }

  return { outcomes, summary };
}
