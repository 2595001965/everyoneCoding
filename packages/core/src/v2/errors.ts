/**
 * V2 公共契约 —— 错误语义（V2-T01；PRD §11.3）。
 *
 * 现状（T01 核验）：跨外壳错误已是 `{ code, message, retryable? }`
 * （shell-api `DomainRpcError` / `AiRpcError`），但**没有 traceId**。
 * 本契约在保持 code/message/retryable 兼容的前提下补齐 PRD 要求的
 * `{ code, message, traceId }` 结构，作为新领域（会话/接口/账务/平台）的
 * 统一错误载荷；既有 15 域 RPC 错误结构不动，由 T12/T23 收口时统一接线。
 *
 * code 取值 = 现有 ShellErrorCode 全集 + V2 新增码，跨外壳/服务端一致。
 */
import { z } from 'zod';

/** 与 shell-api `ShellErrorCode` 保持一致的既有基础码（此处复制以避免契约层反向依赖 shell-api） */
export const BASE_ERROR_CODES = [
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'INVALID_ARGUMENT',
  'PATH_ESCAPE',
  'IO_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'DECRYPT_FAILED',
  'ENCRYPT_FAILED',
  'PROCESS_SPAWN_FAILED',
  'PROCESS_KILLED',
  'NET_BLOCKED',
  'NET_ERROR',
  'NOT_SUPPORTED',
  'UNKNOWN',
] as const;

/** V2 新增错误码（各任务落地时复用，不得私造同义码） */
export const V2_EXTRA_ERROR_CODES = [
  /** 写入基线过期：源码/契约版本与任务启动时不一致（V2-API-11、V2-AGT-06） */
  'STALE_BASE',
  /** 并发冲突：两个写方争用同一资源，需用户裁决（V2-AGT-07） */
  'CONFLICT',
  /** 依赖的平台/协调器不可用；本地直连能力不受此影响（V2-MDL-01） */
  'UNAVAILABLE',
  /** 触发限流（全局/Provider/项目/会话并发或速率）（V2-AGT-03） */
  'RATE_LIMITED',
  /** 预算超限被拒（V2-BILL-08） */
  'BUDGET_EXCEEDED',
  /** 缺少可结算价格，平台路由拒绝新请求（V2-BILL-02、§9.4） */
  'PRICE_UNKNOWN',
] as const;

export const v2ErrorCode = z.enum([...BASE_ERROR_CODES, ...V2_EXTRA_ERROR_CODES]);
export type V2ErrorCode = z.infer<typeof v2ErrorCode>;

/** 统一错误载荷。`retryable` 未知时为 null（调用方按不可重试处理，不得默认重试） */
export interface V2ErrorEnvelope {
  code: V2ErrorCode;
  message: string;
  retryable: boolean | null;
  /** 跨进程/服务端排障关联 ID；本地 RPC 允许为 null */
  traceId: string | null;
  /** 结构化补充信息（如冲突双方基线），不得包含密钥或正文 */
  details: Record<string, unknown> | null;
}

export const v2ErrorEnvelopeSchema = z.object({
  code: v2ErrorCode,
  message: z.string().min(1),
  retryable: z.boolean().nullable(),
  traceId: z.string().min(1).nullable(),
  details: z.record(z.unknown()).nullable(),
});

/** 判定任意 unknown 是否已是合法错误载荷（IPC 边界还原用） */
export function isV2ErrorEnvelope(value: unknown): value is V2ErrorEnvelope {
  return v2ErrorEnvelopeSchema.safeParse(value).success;
}

/**
 * 把任意异常/既有错误对象规整为 V2 错误载荷。
 * 兼容三类输入：V2ErrorEnvelope（原样通过）、ShellError/DomainRpcError 形状
 * （补 traceId/details）、Error/字符串（按 UNKNOWN 兜底，保留原始 message）。
 */
export function toV2ErrorEnvelope(error: unknown, traceId: string | null = null): V2ErrorEnvelope {
  if (isV2ErrorEnvelope(error)) return error;
  if (typeof error === 'object' && error !== null) {
    const rec = error as Record<string, unknown>;
    if (typeof rec.code === 'string' && typeof rec.message === 'string') {
      const parsed = v2ErrorCode.safeParse(rec.code);
      if (parsed.success) {
        return {
          code: parsed.data,
          message: rec.message,
          retryable: typeof rec.retryable === 'boolean' ? rec.retryable : null,
          traceId: typeof rec.traceId === 'string' ? rec.traceId : traceId,
          details: z.record(z.unknown()).safeParse(rec.details).success
            ? (rec.details as Record<string, unknown>)
            : null,
        };
      }
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'UNKNOWN',
    message: message || '未知错误',
    retryable: null,
    traceId,
    details: null,
  };
}
