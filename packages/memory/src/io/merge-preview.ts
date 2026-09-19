import { createMemoryItem, type MemoryItem } from '../domain/memory-item';
import { newUlid } from '@ec/data';
import { mergeMemoryItems, type ConflictStrategy } from '../domain/conflict';
import type { ImportPreview, ImportClassification } from './import';
import type { MemoryRepo } from '../repo/memory-repo';

/**
 * 导入冲突的解决策略。
 *
 * 在 `ConflictStrategy`（keepLocal / takeNew / merge）之外，增加第四种
 * `keepBoth`：保留本地、同时把导入条目以**新 id** 另存一份，双方都在。
 */
export type ImportResolution = ConflictStrategy | 'keepBoth';

/** 单条合并决策：目标 id（= 最终落库/生成的条目 id）与所选策略。 */
export interface MergeDecision {
  /** 目标 id，对应导入条目（incoming）的 id */
  id: string;
  strategy: ImportResolution;
}

/** 计划中的单条产出。 */
export interface MergeOutcomeItem {
  /** 目标 id（= 最终落库/生成的条目 id） */
  id: string;
  strategy: ImportResolution;
  /** merge / keepLocal 时为本地条目，takeNew 时为导入条目 */
  item: MemoryItem;
  /** keepBoth 语义下新建的条目 */
  created?: MemoryItem;
  /** 被合并/覆盖的字段名清单（展示用） */
  mergedFields: string[];
  /** 涉及来源引用（如双方 sourceRef） */
  sources: string[];
  /** takeNew 时被取代的本地条目 id */
  supersededId?: string;
}

/** 合并计划。 */
export interface MergePlan {
  outcomes: MergeOutcomeItem[];
  summary: { keptLocal: number; tookNew: number; merged: number; created: number };
}

/**
 * 由导入预览与用户决策生成合并计划。
 *
 * 纯函数（不触碰存储），可被 Wave 8 的 `.ecpkg` 导入直接复用。
 *
 * 决策优先级：用户显式 `decisions` 优先；未指定时按分类取默认——
 * added→takeNew、unchanged→keepLocal、conflicted→keepLocal（默认不覆盖本地）。
 *
 * @param options.keepBothGeneratesNewId 默认 true；为 false 时 keepBoth 不生成新 id
 *        （仅当导入与本地 id 不同时才有意义，否则视为 takeNew）。
 */
export function planMerge(
  preview: ImportPreview,
  decisions: readonly MergeDecision[],
  options?: { keepBothGeneratesNewId?: boolean },
): MergePlan {
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision.strategy]));
  const outcomes: MergeOutcomeItem[] = [];

  for (const diff of preview.items) {
    const userStrategy = decisionById.get(diff.incoming.id);
    const strategy = resolveStrategy(diff.classification, userStrategy);
    outcomes.push(applyStrategy(strategy, diff.incoming, diff.local, options));
  }

  return {
    outcomes,
    summary: {
      keptLocal: outcomes.filter((outcome) => outcome.strategy === 'keepLocal').length,
      tookNew: outcomes.filter((outcome) => outcome.strategy === 'takeNew').length,
      merged: outcomes.filter((outcome) => outcome.strategy === 'merge').length,
      created: outcomes.filter((outcome) => outcome.strategy === 'keepBoth').length,
    },
  };
}

function resolveStrategy(
  classification: ImportClassification,
  user?: ImportResolution,
): ImportResolution {
  if (user) return user;
  switch (classification) {
    case 'added':
      return 'takeNew';
    case 'unchanged':
      return 'keepLocal';
    case 'conflicted':
    default:
      // 默认不覆盖本地
      return 'keepLocal';
  }
}

function applyStrategy(
  strategy: ImportResolution,
  incoming: MemoryItem,
  local: MemoryItem | null,
  options?: { keepBothGeneratesNewId?: boolean },
): MergeOutcomeItem {
  switch (strategy) {
    case 'keepLocal': {
      const kept = local ?? incoming;
      return { id: kept.id, strategy, item: kept, mergedFields: [], sources: [] };
    }
    case 'takeNew': {
      const outcome: MergeOutcomeItem = {
        id: incoming.id,
        strategy,
        item: incoming,
        mergedFields: [],
        sources: incoming.sourceRef ? [incoming.sourceRef] : [],
      };
      if (local) outcome.supersededId = local.id;
      return outcome;
    }
    case 'merge': {
      // 无本地（异常分类）退化为 takeNew
      if (!local) {
        return {
          id: incoming.id,
          strategy: 'takeNew',
          item: incoming,
          mergedFields: [],
          sources: [],
        };
      }
      const merged = mergeMemoryItems(local, incoming);
      return {
        id: local.id,
        strategy,
        item: merged.item,
        mergedFields: merged.mergedFields,
        sources: merged.sources,
      };
    }
    case 'keepBoth': {
      const created =
        options?.keepBothGeneratesNewId === false
          ? incoming
          : createMemoryItem({ ...incoming, id: newUlid() });
      return {
        id: incoming.id,
        strategy,
        item: incoming,
        created,
        mergedFields: [],
        sources: incoming.sourceRef ? [incoming.sourceRef] : [],
      };
    }
  }
}

/**
 * 按分类批量生成决策。
 *
 * `byClassification` 只填需要批量覆盖的分类，未填者沿用 `planMerge` 的默认策略。
 * `added` 默认 takeNew、`conflicted` 默认 keepLocal，因此通常只需对 `conflicted`
 * 传 `keepBoth`、对 `added` 传 `takeNew` 等即可。
 */
export function batchDecision(
  preview: ImportPreview,
  byClassification: Partial<
    Record<'added' | 'conflicted' | 'unchanged' | 'missing', ImportResolution>
  >,
): MergeDecision[] {
  const decisions: MergeDecision[] = [];
  for (const diff of preview.items) {
    const strategy = byClassification[diff.classification];
    if (strategy) decisions.push({ id: diff.incoming.id, strategy });
  }
  return decisions;
}

/**
 * 把合并计划翻译为写库意图（纯函数，不触碰存储）。
 *
 * - keepLocal：不写；
 * - takeNew：`toCreate` 加导入条目，`toSupersede` 加被取代的本地 id；
 * - merge：`toUpdate` 加合并后的本地条目；
 * - keepBoth：`toCreate` 加新建条目（新 id），本地保留。
 */
export function applyMergePlan(plan: MergePlan): {
  toCreate: MemoryItem[];
  toUpdate: MemoryItem[];
  toSupersede: string[];
} {
  const toCreate: MemoryItem[] = [];
  const toUpdate: MemoryItem[] = [];
  const toSupersede: string[] = [];

  for (const outcome of plan.outcomes) {
    switch (outcome.strategy) {
      case 'keepLocal':
        break;
      case 'takeNew':
        toCreate.push(outcome.item);
        if (outcome.supersededId) toSupersede.push(outcome.supersededId);
        break;
      case 'merge':
        toUpdate.push(outcome.item);
        break;
      case 'keepBoth':
        if (outcome.created) toCreate.push(outcome.created);
        break;
    }
  }

  return { toCreate, toUpdate, toSupersede };
}

/**
 * 落库实现：把 `applyMergePlan` 的写库意图对 `repo` 执行。
 *
 * - toCreate → repo.insert；
 * - toUpdate → repo.update（仅同步内容/结构化/标签/来源/置信度/重要度）；
 * - toSupersede → repo.setStatus(id, 'superseded')。
 *
 * 返回各类操作的计数。
 */
export function commitMergePlan(
  repo: MemoryRepo,
  plan: MergePlan,
): { created: number; updated: number; superseded: number } {
  const { toCreate, toUpdate, toSupersede } = applyMergePlan(plan);

  let created = 0;
  for (const item of toCreate) {
    repo.insert(item);
    created += 1;
  }

  let updated = 0;
  for (const item of toUpdate) {
    repo.update(item.id, {
      content: item.content,
      structured: item.structured,
      tags: item.tags,
      sourceRef: item.sourceRef,
      confidence: item.confidence,
      importance: item.importance,
    });
    updated += 1;
  }

  let superseded = 0;
  for (const id of toSupersede) {
    repo.setStatus(id, 'superseded');
    superseded += 1;
  }

  return { created, updated, superseded };
}
