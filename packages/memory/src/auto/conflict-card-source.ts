import { createMemoryItem, type MemoryItem, type MemorySourceType } from '../domain/memory-item';
import {
  applyConflictStrategy,
  CONFLICT_STRATEGY_LABELS,
  detectConflicts,
  hasConflict,
  type ConflictResolution,
  type ConflictStrategy,
} from '../domain/conflict';
import type { MemoryRepo } from '../repo/memory-repo';
import { MemoryChangeLog } from './change-log';
import type { MemoryCandidate } from './extractor';

/**
 * 冲突对比卡数据源（FR-MEM-11）。
 *
 * 新记忆与已有长期记忆同标题/同义时生成对比卡（采用新 / 保留旧 / 合并）；
 * 合并必须走 `domain/conflict.ts` 的 {@link applyConflictStrategy}，且合并结果保留双方来源引用。
 * 长期记忆总量上限默认 500 条，触达时 {@link ConflictCardSource.longtermStatus} 提示归档。
 */

export interface ConflictField {
  key: string;
  field: string;
  kind: 'title' | 'structured';
  localValue: unknown;
  incomingValue: unknown;
}

export interface ConflictCardModel {
  memoryId: string;
  title: string;
  category: string;
  incoming: { title: string; content: string };
  existing: { title: string; content: string };
  conflicts: ConflictField[];
  options: Array<{ strategy: ConflictStrategy; label: string }>;
}

export interface ConflictResolveResult {
  item: MemoryItem;
  action: 'kept-local' | 'took-new' | 'merged';
  mergedFields: string[];
  sources: string[];
}

export interface ConflictCardSourceDeps {
  repo: MemoryRepo;
  clock?: () => number;
  /** 长期记忆上限，默认 500（测试可设小以触发归档提示） */
  maxLongterm?: number;
}

const DEFAULT_MAX_LONGTERM = 500;

export class ConflictCardSource {
  private readonly repo: MemoryRepo;
  private readonly clock: () => number;
  private readonly maxLongterm: number;
  private readonly changeLog: MemoryChangeLog;
  /** 缓存 inspect 时构造的 incoming 条目，供 resolve 复用（保留完整结构化/来源） */
  private readonly drafts = new Map<string, MemoryItem>();

  constructor(deps: ConflictCardSourceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? (() => Date.now());
    this.maxLongterm = deps.maxLongterm ?? DEFAULT_MAX_LONGTERM;
    this.changeLog = new MemoryChangeLog(deps.repo);
  }

  /**
   * 判断候选是否与既有长期记忆冲突；冲突则返回对比卡模型。
   * 冲突判定口径与 `domain/conflict.ts` 一致：同标题（归一化）或同 structured 键。
   */
  inspect(candidate: MemoryCandidate, ctx: { userId: string }): ConflictCardModel | null {
    const incoming = this.toItem(candidate);
    const existingList = this.repo.list({ userId: ctx.userId, scopes: ['longterm'], status: 'active' });
    const local = existingList.find((e) => hasConflict(e, incoming));
    if (!local) return null;

    this.drafts.set(local.id, incoming);
    const conflicts: ConflictField[] = detectConflicts(local, incoming).map((c) => ({
      key: c.key,
      field: c.field,
      kind: c.kind,
      localValue: c.localValue,
      incomingValue: c.incomingValue,
    }));
    const options = (Object.keys(CONFLICT_STRATEGY_LABELS) as ConflictStrategy[]).map((strategy) => ({
      strategy,
      label: CONFLICT_STRATEGY_LABELS[strategy],
    }));

    return {
      memoryId: local.id,
      title: local.title,
      category: candidate.category,
      incoming: { title: candidate.title, content: candidate.content },
      existing: { title: local.title, content: local.content },
      conflicts,
      options,
    };
  }

  /**
   * 应用用户选择的冲突策略，返回最终生效条目。
   * 必须走 `domain/conflict.ts` 的 {@link applyConflictStrategy}；
   * 三者都写一条 `action:'conflict_resolve'` 的变更日志，detail 记录策略与 sources。
   */
  resolve(
    model: ConflictCardModel,
    strategy: ConflictStrategy,
    ctx: { userId: string },
  ): ConflictResolveResult {
    const local = this.repo.findById(model.memoryId);
    const incoming = this.drafts.get(model.memoryId);
    if (!local || !incoming) {
      throw new Error(`冲突条目不存在或已失效：${model.memoryId}`);
    }

    const now = this.clock();
    const resolution = applyConflictStrategy({ strategy, local, incoming, now });
    const sources = collectSources(local, incoming);

    if (strategy === 'keepLocal') {
      this.recordConflict(ctx, local, strategy, [], sources);
      return { item: local, action: 'kept-local', mergedFields: [], sources };
    }

    if (strategy === 'takeNew') {
      const updated = this.repo.update(local.id, {
        title: incoming.title,
        content: incoming.content,
        structured: incoming.structured,
        tags: incoming.tags,
        sourceRef: incoming.sourceRef,
        confidence: incoming.confidence,
        importance: incoming.importance,
      });
      this.recordConflict(ctx, updated, strategy, [], sources);
      return { item: updated, action: 'took-new', mergedFields: [], sources };
    }

    // merge
    const merged = resolution as Extract<ConflictResolution, { strategy: 'merge' }>;
    const updated = this.repo.update(local.id, {
      title: merged.item.title,
      content: merged.item.content,
      structured: merged.item.structured,
      tags: merged.item.tags,
      sourceRef: merged.item.sourceRef,
      confidence: merged.item.confidence,
      importance: merged.item.importance,
    });
    this.recordConflict(ctx, updated, strategy, merged.mergedFields, merged.sources);
    return { item: updated, action: 'merged', mergedFields: merged.mergedFields, sources: merged.sources };
  }

  /** 长期记忆总量与上限提示。 */
  longtermStatus(ctx: { userId: string }): { count: number; limit: number; shouldArchive: boolean } {
    const count = this.repo.count({ userId: ctx.userId, scopes: ['longterm'], status: 'active' });
    return { count, limit: this.maxLongterm, shouldArchive: count >= this.maxLongterm };
  }

  private toItem(candidate: MemoryCandidate): MemoryItem {
    return createMemoryItem({
      userId: 'pending', // 仅用于冲突检测，id 不唯一；真正落库在 resolve 内
      scope: 'longterm',
      projectId: null,
      title: candidate.title,
      content: candidate.content,
      structured: candidate.structured,
      tags: [...new Set([candidate.category, 'auto', ...candidate.tags])],
      sourceType: 'auto_chat',
      sourceRef: `conversation:${candidate.sourceConversationId}`,
      confidence: candidate.baseConfidence,
      importance: 3,
    });
  }

  private recordConflict(
    ctx: { userId: string },
    item: MemoryItem,
    strategy: ConflictStrategy,
    mergedFields: string[],
    sources: string[],
  ): void {
    const conversationId =
      item.sourceRef && item.sourceRef.startsWith('conversation:')
        ? item.sourceRef.slice('conversation:'.length)
        : null;
    this.changeLog.record({
      userId: ctx.userId,
      memoryId: item.id,
      action: 'conflict_resolve',
      policy: null,
      sourceType: item.sourceType as MemorySourceType,
      conversationId,
      snippet: item.content.slice(0, 200),
      before: { title: item.title },
      after: { title: item.title },
      detail: { strategy, sources, mergedFields },
    });
  }
}

function collectSources(local: MemoryItem, incoming: MemoryItem): string[] {
  return [local.sourceRef, incoming.sourceRef]
    .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
}
