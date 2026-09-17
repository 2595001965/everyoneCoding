import type { SettingsStore, WritePolicy } from '@ec/core';
import { upsertMemory, type UpsertOutcome } from '../service/upsert';
import { MemoryChangeLog } from './change-log';
import type { SignalAssessment } from './signal-strength';
import type { MemoryCandidate } from './extractor';
import type { MemoryRepo } from '../repo/memory-repo';

/**
 * 写入策略（FR-MEM-10）。
 *
 * 设置里的三档语义（与 `packages/core/src/settings-schema.ts` 的 `memoryWritePolicy` 对齐）：
 * - `'auto'`    = ① 静默自动写入（仅高置信，confidence > 0.8；低置信直接跳过）
 * - `'confirm'` = ② 自动写入 + Toast 可撤销（**默认**；写入后发通知事件，用户可撤销）
 * - `'manual'`  = ③ 仅建议，需用户确认（只产出建议，不落库）
 *
 * 项目级策略优先于全局策略（由 {@link WritePolicyPort.policyFor} 决定）。
 */

/* --------------------------- 策略端口 --------------------------- */

/**
 * 写入策略端口：从设置读取（项目级优先于全局）。
 * 注入此端口而非直接依赖 SettingsStore，便于测试用假实现替换。
 */
export interface WritePolicyPort {
  policyFor(projectId: string | null): WritePolicy;
}

/**
 * 基于 `@ec/core` 的 SettingsStore 实现。
 * 项目级未设置时回落到全局策略。
 */
export class SettingsWritePolicyPort implements WritePolicyPort {
  constructor(private readonly store: SettingsStore) {}

  policyFor(projectId: string | null): WritePolicy {
    const global = this.store.getGlobal().ai.memoryWritePolicy;
    if (projectId) {
      return this.store.forProject(projectId).memoryWritePolicy ?? global;
    }
    return global;
  }
}

/* --------------------------- 决策 --------------------------- */

export type WriteAction = 'silent-write' | 'write-and-notify' | 'suggest-only' | 'skip';

export interface WriteDecision {
  policy: WritePolicy;
  action: WriteAction;
  reason: string;
  /** 是否需要用户确认/可撤销（auto_write 的 notify 或 manual 的建议） */
  requiresConfirmation: boolean;
}

/**
 * 根据候选置信度与策略档位决定写入动作。
 *
 * 上限：长期记忆达到 `maxLongterm`（默认 500）时，无论策略档位一律返回
 * `action:'suggest-only'` 并给出归档提示文案。
 */
export function decideWrite(
  candidate: { confidence: number; level: 'low' | 'medium' | 'high' },
  policy: WritePolicy,
  options: { maxLongterm?: number; currentLongtermCount?: number } = {},
): WriteDecision {
  const maxLongterm = options.maxLongterm ?? 500;
  const current = options.currentLongtermCount ?? 0;
  const base = { policy, requiresConfirmation: false };

  if (current >= maxLongterm) {
    return {
      ...base,
      action: 'suggest-only',
      requiresConfirmation: true,
      reason: `长期记忆已达上限（${current}/${maxLongterm}），建议归档旧条目后再写入。`,
    };
  }

  switch (policy) {
    case 'manual':
      return {
        ...base,
        action: 'suggest-only',
        requiresConfirmation: true,
        reason: '当前为「仅建议」策略，需用户确认后才写入。',
      };
    case 'auto':
      if (candidate.level === 'high') {
        return { ...base, action: 'silent-write', reason: '高置信偏好，按「自动」策略静默写入。' };
      }
      return { ...base, action: 'skip', reason: '置信度不足，按「自动」策略跳过低置信候选。' };
    case 'confirm':
    default:
      if (candidate.level === 'low') {
        return { ...base, action: 'skip', reason: '置信度过低，按「确认」策略跳过。' };
      }
      return { ...base, action: 'write-and-notify', reason: '已自动写入，可撤销。', requiresConfirmation: true };
  }
}

/* --------------------------- 写入器 --------------------------- */

export interface AutoWriteRecord {
  memoryId: string;
  candidate: MemoryCandidate;
  assessment: SignalAssessment;
  decision: WriteDecision;
  at: number;
}

const DEFAULT_MAX_LONGTERM = 500;

export interface LongTermMemoryWriterDeps {
  repo: MemoryRepo;
  policy: WritePolicyPort;
  clock?: () => number;
  maxLongterm?: number;
}

/**
 * 长期记忆写入器（scope='longterm'，projectId 必须为 null）。
 *
 * - `apply`：按策略写入/更新长期记忆；`skip` 返回 null，`suggest-only` 返回建议。
 * - `undo`：把条目归档（可恢复，status='archived'），并写一条 undo 变更日志。
 *   默认策略档（confirm）下 Toast 的「撤销」即调用本方法。
 */
export class LongTermMemoryWriter {
  private readonly repo: MemoryRepo;
  private readonly policy: WritePolicyPort;
  private readonly clock: () => number;
  private readonly maxLongterm: number;
  private readonly changeLog: MemoryChangeLog;

  constructor(deps: LongTermMemoryWriterDeps) {
    this.repo = deps.repo;
    this.policy = deps.policy;
    this.clock = deps.clock ?? (() => Date.now());
    this.maxLongterm = deps.maxLongterm ?? DEFAULT_MAX_LONGTERM;
    this.changeLog = new MemoryChangeLog(deps.repo);
  }

  /**
   * 写入/更新长期记忆。
   * @returns 写入成功返回记录与 upsert 结果；仅建议返回 `{ suggestionOnly: true }`；跳过返回 null。
   */
  apply(
    candidate: MemoryCandidate,
    assessment: SignalAssessment,
    ctx: { userId: string },
  ): { record: AutoWriteRecord; outcome: UpsertOutcome } | { suggestionOnly: true; decision: WriteDecision } | null {
    const policy = this.policy.policyFor(null);
    const decision = decideWrite(
      { confidence: assessment.confidence, level: assessment.level },
      policy,
      { maxLongterm: this.maxLongterm, currentLongtermCount: this.countLongterm(ctx.userId) },
    );

    if (decision.action === 'suggest-only') {
      return { suggestionOnly: true, decision };
    }
    if (decision.action === 'skip') {
      return null;
    }

    const at = this.clock();
    const outcome = upsertMemory(
      this.repo,
      {
        userId: ctx.userId,
        scope: 'longterm',
        projectId: null,
        title: candidate.title,
        content: candidate.content,
        structured: candidate.structured,
        tags: [...new Set([candidate.category, 'auto', ...candidate.tags])],
        sourceType: 'auto_chat',
        sourceRef: `conversation:${candidate.sourceConversationId}`,
        confidence: assessment.confidence,
        importance: assessment.level === 'high' ? 4 : 3,
      },
      { onExisting: 'merge' },
    );

    this.changeLog.record({
      userId: ctx.userId,
      memoryId: outcome.item.id,
      action: 'auto_write',
      policy,
      sourceType: 'auto_chat',
      conversationId: candidate.sourceConversationId,
      snippet: candidate.snippet,
      before: outcome.previous
        ? { title: outcome.previous.title, content: outcome.previous.content }
        : null,
      after: { title: candidate.title, content: candidate.content },
      detail: { category: candidate.category, level: assessment.level, action: decision.action },
    });

    const record: AutoWriteRecord = { memoryId: outcome.item.id, candidate, assessment, decision, at };
    return { record, outcome };
  }

  /**
   * 撤销：把条目归档（可恢复），并写一条 undo 变更日志。
   * 撤销后该条目从"生效的长期记忆"中消失（status 变 archived，活跃查询不含它）。
   * @returns 条目不存在或已归档时返回 false。
   */
  undo(memoryId: string, ctx: { userId: string }): boolean {
    const item = this.repo.findById(memoryId);
    if (!item || item.status === 'archived') return false;

    const archived = this.repo.setStatus(memoryId, 'archived');
    const conversationId =
      archived.sourceRef && archived.sourceRef.startsWith('conversation:')
        ? archived.sourceRef.slice('conversation:'.length)
        : null;

    this.changeLog.record({
      userId: ctx.userId,
      memoryId,
      action: 'undo',
      policy: null,
      sourceType: archived.sourceType,
      conversationId,
      snippet: null,
      before: { status: 'active', title: archived.title },
      after: { status: 'archived', title: archived.title },
      detail: { undoOf: memoryId },
    });
    return true;
  }

  private countLongterm(userId: string): number {
    return this.repo.count({ userId, scopes: ['longterm'], status: 'active' });
  }
}
