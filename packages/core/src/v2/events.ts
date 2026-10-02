/**
 * V2 公共契约 —— 事件信封与去重（V2-T01；PRD §11.3、V2-AGT-10、V2-USG-08）。
 *
 * 现状（T01 核验）：跨进程事件 `DomainEvent { requestId, domain, payload }`
 * 没有自身 ID / 序号 / 去重机制，只靠 requestId 关联。V2 的多窗口订阅、
 * 用量更正、账务结算都要求**幂等事件**，故定义统一事件信封：
 * - `eventId`：全局唯一（ULID），接收方以此去重
 * - `sequence`：发送方内部单调序号（按 `sequenceSource` 分流），用于检测丢事件
 * - `dedupKey`：业务幂等键（如 `attempt:{id}:final`），同一键的事件只生效一次
 *
 * 信封是纯数据 + 纯函数；跨进程传输仍由各外壳事件通道承载（T12/T14 接线）。
 */
import { z } from 'zod';
import { epochMsSchema, opaqueIdSchema, ulidSchema } from './primitives';

/** 平台 AI 请求/账务 SSE 事件类型（PRD §11.3 固定集合） */
export const PLATFORM_EVENT_TYPES = [
  'request.accepted',
  'output.delta',
  'usage.updated',
  'request.completed',
  'request.failed',
  'bill.settled',
] as const;

/**
 * 事件类型：平台六类 + 其他领域的命名空间类型（如 `agent.task.updated`）。
 * 必须形如 `<段>[.<段>…]`，段为小写字母开头的小写字母数字。
 */
export const eventTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_-]*)+$/, '事件类型必须是点分命名空间小写字符串');

export interface V2EventEnvelope {
  /** 全局唯一事件 ID（接收方去重主键） */
  eventId: string;
  type: string;
  /** 发送方内部单调序号（按 sequenceSource 分流；可与 eventId 组合检测丢失） */
  sequence: number;
  /** 序号归属流（如 `session:{id}`、`request:{id}`）；缺省表示无流语义 */
  sequenceSource: string | null;
  /** 业务幂等键；同一键重复投递只生效一次 */
  dedupKey: string | null;
  /** 发生时间（毫秒时间戳） */
  occurredAt: number;
  /** 关联的逻辑请求 / attempt / 会话 / 任务（均可空） */
  requestId: string | null;
  attemptId: string | null;
  sessionId: string | null;
  taskId: string | null;
  /** 事件负载；不得包含密钥、Provider Key、请求正文 */
  payload: unknown;
}

export const v2EventEnvelopeSchema = z.object({
  eventId: ulidSchema,
  type: eventTypeSchema,
  sequence: z.number().int().nonnegative(),
  sequenceSource: z.string().min(1).nullable(),
  dedupKey: z.string().min(1).nullable(),
  occurredAt: epochMsSchema,
  requestId: opaqueIdSchema.nullable(),
  attemptId: opaqueIdSchema.nullable(),
  sessionId: opaqueIdSchema.nullable(),
  taskId: opaqueIdSchema.nullable(),
  payload: z.unknown(),
});

export type EventAcceptResult = 'accepted' | 'duplicate';

/**
 * 进程内事件去重器（纯逻辑，无 IO）。
 * - 按 `eventId` 全局去重（重复投递的事件必然同 ID）
 * - 按 `dedupKey` 去重（不同 eventId 但同幂等键的业务重复，如重连重放）
 * - 容量上限使用 LRU 淘汰，防止长会话内存增长
 */
export function createEventDeduplicator(capacity = 4096) {
  const byEventId = new Map<string, true>();
  const byDedupKey = new Map<string, true>();
  const touch = (map: Map<string, true>, key: string): boolean => {
    if (map.has(key)) return false;
    if (map.size >= capacity) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
    map.set(key, true);
    return true;
  };
  return {
    /** 返回 'accepted' 表示这是首次出现的事件；'duplicate' 表示应忽略 */
    accept(event: Pick<V2EventEnvelope, 'eventId' | 'dedupKey'>): EventAcceptResult {
      const freshEvent = touch(byEventId, event.eventId);
      const freshDedup = event.dedupKey === null ? true : touch(byDedupKey, event.dedupKey);
      return freshEvent && freshDedup ? 'accepted' : 'duplicate';
    },
    reset(): void {
      byEventId.clear();
      byDedupKey.clear();
    },
  };
}

/** 校验序号是否按流单调前进（用于检测丢事件/乱序；不做自动补偿） */
export function isSequenceAdvancing(previous: number, incoming: number): boolean {
  return incoming === previous + 1;
}
