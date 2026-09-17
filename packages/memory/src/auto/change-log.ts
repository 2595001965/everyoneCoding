import type { MemoryRepo } from '../repo/memory-repo';
import type { MemorySourceType } from '../domain/memory-item';
import type { WritePolicy } from '@ec/core';

/**
 * 自动写入变更日志（FR-MEM-12）。
 *
 * 每次自动写入/撤销/冲突解决都记一条，包含来源对话片段与时间，
 * 供记忆中心的变更日志面板展示与"跳转原始对话"（UI 注入回调占位）。
 */

export interface ChangeLogEntry {
  id: string;
  memoryId: string;
  action: string;
  policy: WritePolicy | null;
  conversationId: string | null;
  snippet: string | null;
  at: number;
  /** 跳转原始对话的回调占位（渲染层注入），这里仅透传对话 id */
  jumpToConversation?: string | null;
}

export interface RecordChangeInput {
  userId: string;
  memoryId: string;
  action: 'auto_write' | 'undo' | 'conflict_resolve';
  policy?: WritePolicy | null;
  sourceType?: MemorySourceType | null;
  conversationId?: string | null;
  snippet?: string | null;
  before?: unknown;
  after?: unknown;
  detail?: unknown;
}

/** 记忆变更日志的门面：在 `MemoryRepo.changes` 之上封装领域语义。 */
export class MemoryChangeLog {
  constructor(private readonly repo: MemoryRepo) {}

  /** 写入一条变更记录，返回领域视图。 */
  record(input: RecordChangeInput): ChangeLogEntry {
    const row = this.repo.changes.append({
      userId: input.userId,
      memoryId: input.memoryId,
      action: input.action,
      policy: input.policy ?? null,
      sourceType: input.sourceType ?? null,
      sourceConversationId: input.conversationId ?? null,
      sourceSnippet: input.snippet ?? null,
      before: input.before,
      after: input.after,
      detail: input.detail,
    });
    return toEntry(row);
  }

  /** 列出变更记录（按时间倒序）。 */
  list(options: { userId: string; memoryId?: string; limit?: number }): ChangeLogEntry[] {
    return this.repo.changes.list(options).map(toEntry);
  }

  /**
   * 供 UI 跳转原始对话：根据记录 id 取回对话 id 与记忆 id。
   * 直接查 `memory_change_log` 表（repo 未暴露按 id 查询）。
   */
  jumpTarget(entryId: string): { conversationId: string | null; memoryId: string } {
    const row = this.repo.raw
      .prepare('SELECT memory_id, source_conversation_id FROM memory_change_log WHERE id = ?')
      .get(entryId) as { memory_id: string; source_conversation_id: string | null } | undefined;
    if (!row) return { conversationId: null, memoryId: '' };
    return { conversationId: row.source_conversation_id, memoryId: row.memory_id };
  }
}

interface ChangeLogRowLike {
  id: string;
  memoryId: string;
  action: string;
  policy: string | null;
  sourceType: string | null;
  sourceConversationId: string | null;
  sourceSnippet: string | null;
  createdAt: number;
}

function toEntry(row: ChangeLogRowLike): ChangeLogEntry {
  const conversationId = row.sourceConversationId;
  return {
    id: row.id,
    memoryId: row.memoryId,
    action: row.action,
    policy: (row.policy as WritePolicy | null) ?? null,
    conversationId,
    snippet: row.sourceSnippet,
    at: row.createdAt,
    jumpToConversation: conversationId,
  };
}
