import type { MemoryRepo } from '../repo/memory-repo';
import { mergeMemoryItems, type ConflictStrategy } from '../domain/conflict';
import {
  createMemoryItem,
  type CreateMemoryInput,
  type MemoryItem,
  type MemorySourceType,
} from '../domain/memory-item';

/**
 * 记忆 upsert 公共逻辑（五层服务共用）。
 *
 * 语义：按「同 scope + 同归属 + 同标题」定位同一条记忆，
 * 存在则合并/替换，不存在则创建 —— 这正是"分层沉淀可反复更新而不产生重复条目"的基础。
 */

export interface UpsertOptions {
  /** 默认 merge：结构化数据深合并、正文拼接、标签并集 */
  onExisting?: 'merge' | 'replace' | 'skip';
  /** 未显式传入时沿用既有条目的置信度策略 */
  confidence?: number;
  importance?: number;
  sourceType?: MemorySourceType;
  sourceRef?: string | null;
  tags?: readonly string[];
  /** 是否启用乐观锁（默认 true，并发修改会抛 ConflictError） */
  optimisticLock?: boolean;
}

export interface UpsertOutcome {
  item: MemoryItem;
  created: boolean;
  /** 合并时被改写的字段（展示在变更日志里） */
  mergedFields: string[];
  /** 被覆盖的旧版本（created=false 时存在） */
  previous: MemoryItem | null;
}

export function patchFromItem(item: MemoryItem): {
  title: string;
  content: string;
  structured: Record<string, unknown> | null;
  tags: string[];
  sourceRef: string | null;
  confidence: number;
  importance: number;
  pinned: boolean;
} {
  return {
    title: item.title,
    content: item.content,
    structured: item.structured,
    tags: item.tags,
    sourceRef: item.sourceRef,
    confidence: item.confidence,
    importance: item.importance,
    pinned: item.pinned,
  };
}

/**
 * 写入或更新一条记忆。
 * @returns 最终生效的条目 + 是否新建 + 合并字段明细
 */
export function upsertMemory(
  repo: MemoryRepo,
  input: CreateMemoryInput,
  options: UpsertOptions = {},
): UpsertOutcome {
  const candidate = createMemoryItem({
    ...input,
    ...(options.confidence !== undefined ? { confidence: options.confidence } : {}),
    ...(options.importance !== undefined ? { importance: options.importance } : {}),
    ...(options.sourceType !== undefined ? { sourceType: options.sourceType } : {}),
    ...(options.sourceRef !== undefined ? { sourceRef: options.sourceRef } : {}),
    ...(options.tags !== undefined ? { tags: [...options.tags] } : {}),
  });

  const existing = repo.findSameTitleCandidates(candidate)[0] ?? null;
  if (!existing) {
    return { item: repo.insert(candidate), created: true, mergedFields: [], previous: null };
  }

  const mode = options.onExisting ?? 'merge';
  if (mode === 'skip') {
    return { item: existing, created: false, mergedFields: [], previous: existing };
  }

  const expectedVersion = (options.optimisticLock ?? true) ? existing.version : undefined;
  if (mode === 'replace') {
    const updated = repo.update(existing.id, patchFromItem(candidate), expectedVersion);
    return { item: updated, created: false, mergedFields: ['(replace)'], previous: existing };
  }

  const merged = mergeMemoryItems(existing, candidate);
  const updated = repo.update(
    existing.id,
    {
      content: merged.item.content,
      structured: merged.item.structured,
      tags: merged.item.tags,
      sourceRef: merged.item.sourceRef,
      confidence: merged.item.confidence,
      importance: merged.item.importance,
      pinned: merged.item.pinned,
    },
    expectedVersion,
  );
  return { item: updated, created: false, mergedFields: merged.mergedFields, previous: existing };
}

export type { ConflictStrategy };
