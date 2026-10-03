/** Trusted platform AI gateway: catalog-owned routing, server-owned credentials and billing. */
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  AnthropicAdapter,
  OpenAiAdapter,
  UsageAccumulator,
  createNodeHttpTransport,
  type ChatMessage,
  type HttpTransport,
  type Provider,
  type ToolDefinition,
} from '@ec/ai';
import {
  providerModelKeyOf,
  providerModelRouteSchema,
  type NormalizedUsage,
  type PriceVersion,
  type V2EventEnvelope,
} from '@ec/core';
import { newUlid } from '@ec/data';
import { requireAuth } from '../auth-tokens.ts';
import type { AppConfig } from '../config.ts';
import { AppError, ErrCode } from '../errors.ts';
import type { WalletLedger } from '../models/wallet-ledger.ts';
import { PlatformCatalogDb } from '../models/platform-catalog.ts';
import { resolvePlatformCredential } from '../gateway/credentials.ts';
import { guardUpstream } from '../gateway/network-guard.ts';

const attemptIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const messageSchema = z
  .object({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.unknown() })
  .passthrough()
  .superRefine((message, context) => {
    if (message.role === 'system' && typeof message.content !== 'string') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'system 消息内容格式无效' });
      return;
    }
    if (message.role === 'tool' && !Array.isArray(message.content)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'tool 消息内容格式无效' });
      return;
    }
    if (
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content !== 'string' &&
      !Array.isArray(message.content)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '消息内容格式无效' });
    }
  });

const toolSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().max(8_000).optional(),
    parameters: z.record(z.unknown()),
  })
  .strict();

const chatBodySchema = z
  .object({
    model: z.string().min(1).max(64),
    messages: z.array(messageSchema).min(1).max(256),
    tools: z.array(toolSchema).max(128).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(200_000).optional(),
  })
  .strict();

interface ActiveRequest {
  accountId: string;
  controller: AbortController;
  dispatched: boolean;
  cancelled: boolean;
  leaseFailed: boolean;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(ErrCode.BAD_REQUEST, '平台模型请求格式无效', 400);
  return result.data;
}

function headerValue(value: string | string[] | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(ErrCode.BAD_REQUEST, `缺少 ${name}`, 400);
  }
  return value.trim();
}

function validateMessages(messages: readonly ChatMessage[]): void {
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== 'object' || !('type' in block)) {
          throw new AppError(ErrCode.BAD_REQUEST, '消息内容块格式无效', 400);
        }
        const type = (block as { type?: unknown }).type;
        if (!['text', 'image', 'tool_use', 'tool_result'].includes(String(type))) {
          throw new AppError(ErrCode.BAD_REQUEST, '消息内容块类型不受支持', 400);
        }
      }
    }
  }
}

function contentDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function safeUsageEstimate(inputTokens: number, outputTokens: number, price: PriceVersion, protocol: Provider['protocol']): NormalizedUsage {
  const rates = price.rates;
  if (rates.uncachedInput === null || rates.cacheRead === null || rates.output === null) {
    throw new AppError('PRICE_UNKNOWN', '平台价格未覆盖请求可能使用的输入或输出计费项', 409);
  }
  const inputBuckets: Array<{ key: 'uncachedInput' | 'cacheRead' | `cacheWrite:${string}`; rate: number }> = [
    { key: 'uncachedInput', rate: rates.uncachedInput },
    { key: 'cacheRead', rate: rates.cacheRead },
  ];
  if (protocol === 'anthropic') {
    const writeRates = rates.cacheWriteByTtl;
    if (
      !writeRates ||
      !['5m', '1h', 'unknown'].every((ttl) => typeof writeRates[ttl] === 'number')
    ) {
      throw new AppError('PRICE_UNKNOWN', 'Anthropic 平台价格必须覆盖 5m、1h 与未知 TTL 缓存写费率', 409);
    }
    for (const [ttl, rate] of Object.entries(writeRates)) {
      if (rate === null) throw new AppError('PRICE_UNKNOWN', '平台价格含未定价缓存写计费项', 409);
      inputBuckets.push({ key: `cacheWrite:${ttl}`, rate });
    }
  }
  const maximumInputBucket = inputBuckets.reduce((max, item) =>
    item.rate > max.rate ? item : max,
  );
  const estimate: NormalizedUsage = {
    totalInput: inputTokens,
    uncachedInput: maximumInputBucket.key === 'uncachedInput' ? inputTokens : 0,
    cacheReadInput: maximumInputBucket.key === 'cacheRead' ? inputTokens : 0,
    cacheWriteInputByTtl:
      maximumInputBucket.key.startsWith('cacheWrite:')
        ? { [maximumInputBucket.key.slice('cacheWrite:'.length)]: inputTokens }
        : {},
    totalOutput: outputTokens,
    reasoningOutput: null,
    quality: 'context_estimate',
  };
  return estimate;
}

function requestInputUpperBound(messages: readonly ChatMessage[], tools: readonly ToolDefinition[] | undefined): number {
  const serialized = JSON.stringify({ messages, ...(tools ? { tools } : {}) });
  // One token per UTF-8 byte is intentionally conservative; the raw payload is never retained.
  return Buffer.byteLength(serialized, 'utf8') + messages.length * 8;
}

function providerFor(
  route: NonNullable<ReturnType<PlatformCatalogDb['getGatewayRoute']>>,
  accountId: string,
): Provider {
  const now = Date.now();
  return {
    id: route.providerId,
    userId: accountId,
    name: route.providerDisplayName,
    protocol: route.protocol,
    source: 'platform',
    baseUrl: route.baseUrl,
    keyRef: null,
    headers: {},
    timeoutMs: 300_000,
    supportsStream: true,
    supportsTools: true,
    supportsVision: true,
    enabled: true,
    order: 0,
    manualModels: [route.upstreamModelName],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function publicAttempt(attempt: ReturnType<WalletLedger['getAttempt']>): Record<string, unknown> | null {
  if (!attempt) return null;
  return {
    attemptId: attempt.attemptId,
    logicalRequestId: attempt.logicalRequestId,
    status: attempt.status,
    dispatchState: attempt.dispatchState,
    providerModelKey: attempt.providerModelKey,
    currency: attempt.currency,
    reservedMicros: attempt.reservedMicros,
    finalMicros: attempt.finalMicros,
    usage: attempt.usage,
    priceVersionId: attempt.priceVersionId,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    settledAt: attempt.settledAt,
  };
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

function isDefiniteProviderRejection(error: unknown, emittedContent: boolean): boolean {
  const status = errorStatus(error);
  return (
    !emittedContent &&
    status !== null &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409 &&
    status !== 425 &&
    status !== 429
  );
}

function safeErrorMessage(error: unknown): string {
  const status = errorStatus(error);
  if (status !== null && status >= 400 && status < 500) {
    return `上游拒绝了请求（HTTP ${status}）；未发现生成内容，本次预占已释放`;
  }
  return '上游执行状态未知；预占已保留并进入对账，请查询账单后再重试';
}

function sseEnvelope(input: {
  type: string;
  eventId: string;
  sequence: number;
  logicalRequestId: string;
  attemptId: string;
  payload: unknown;
}): V2EventEnvelope {
  return {
    eventId: input.eventId,
    type: input.type,
    sequence: input.sequence,
    sequenceSource: `request:${input.logicalRequestId}`,
    dedupKey: `${input.attemptId}:${input.sequence}`,
    occurredAt: Date.now(),
    requestId: input.logicalRequestId,
    attemptId: input.attemptId,
    sessionId: null,
    taskId: null,
    payload: input.payload,
  };
}

async function writeSse(
  reply: FastifyReply,
  event: V2EventEnvelope,
): Promise<void> {
  const raw = reply.raw;
  if (raw.destroyed || raw.writableEnded) throw new Error('客户端已断开');
  const frame = `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (raw.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const done = (): void => {
      raw.off('drain', onDrain);
      raw.off('close', onClose);
    };
    const onDrain = (): void => {
      done();
      resolve();
    };
    const onClose = (): void => {
      done();
      reject(new Error('客户端已断开'));
    };
    raw.once('drain', onDrain);
    raw.once('close', onClose);
  });
}

export function aiGatewayRoutes(
  app: FastifyInstance,
  options: { db: Database; ledger: WalletLedger; config: AppConfig; transport?: HttpTransport },
): void {
  const catalog = new PlatformCatalogDb(options.db);
  const upstreamTransport = options.transport ?? createNodeHttpTransport();
  const active = new Map<string, ActiveRequest>();

  app.post('/api/ai/requests', { preHandler: requireAuth, bodyLimit: 1_048_576 }, async (req, reply) => {
    const body = parse(chatBodySchema, req.body);
    const routeParts = body.model.split('/');
    const routeIdentity = providerModelRouteSchema.safeParse(
      routeParts.length === 2 ? { providerId: routeParts[0], modelId: routeParts[1] } : null,
    );
    if (!routeIdentity.success) throw new AppError(ErrCode.BAD_REQUEST, '平台目录路由无效', 400);
    const providerModelKey = providerModelKeyOf(routeIdentity.data);
    const accountId = req.user!.userId;
    const attemptId = attemptIdSchema.parse(headerValue(req.headers['idempotency-key'], 'Idempotency-Key'));
    const logicalRequestId = headerValue(
      req.headers['x-ec-logical-request-id'],
      'X-EC-Logical-Request-Id',
    );
    if (logicalRequestId.length > 200) throw new AppError(ErrCode.BAD_REQUEST, '逻辑请求标识过长', 400);
    const digest = contentDigest(body);
    const replay = options.ledger.findIdempotentReplay({
      accountId,
      idempotencyKey: attemptId,
      attemptId,
      logicalRequestId,
      providerModelKey,
      contentFingerprint: digest,
    });
    if (replay) {
      reply.code(409);
      return {
        code: 'REQUEST_ALREADY_PROCESSED',
        message: '该幂等请求已有 attempt；平台不会重复运行或再次扣费，请查询 attempt 状态',
        attempt: publicAttempt(replay),
      };
    }

    const route = catalog.getGatewayRoute(
      routeIdentity.data.providerId,
      routeIdentity.data.modelId,
    );
    if (!route) {
      throw new AppError(ErrCode.CONFLICT, '平台渠道已停用、维护中或缺少可结算价格', 409);
    }
    validateMessages(body.messages as ChatMessage[]);
    const tools = body.tools as ToolDefinition[] | undefined;
    const inputUpper = requestInputUpperBound(body.messages as ChatMessage[], tools);
    const outputUpper = body.maxTokens ?? 4096;
    if (
      route.contextWindowTokens !== null &&
      inputUpper + outputUpper > route.contextWindowTokens
    ) {
      throw new AppError(ErrCode.BAD_REQUEST, '请求上下文与最大输出超过该目录模型窗口', 400);
    }
    const usageEstimate = safeUsageEstimate(inputUpper, outputUpper, route.priceVersion, route.protocol);
    const guarded = await guardUpstream(route.baseUrl, options.config.gatewayAllowLoopbackUpstreams);
    const upstreamSecret = await resolvePlatformCredential(route.credentialRef, options.config);
    const fixedTransport: HttpTransport = {
      async request(input) {
        const target = new URL(input.url);
        if (target.origin !== guarded.url.origin) {
          throw new AppError(ErrCode.FORBIDDEN, '上游协议尝试访问目录地址以外的目标', 403);
        }
        return upstreamTransport.request({ ...input, lookup: guarded.lookup });
      },
      ...(upstreamTransport.close ? { close: () => upstreamTransport.close!() } : {}),
    };

    const reserved = options.ledger.reserveAttempt({
      accountId,
      attemptId,
      logicalRequestId,
      idempotencyKey: attemptId,
      providerModelKey,
      priceVersionId: route.priceVersionId,
      usageEstimate,
      contentFingerprint: digest,
    });
    if (reserved.replayed) {
      reply.code(409);
      return {
        code: 'REQUEST_ALREADY_PROCESSED',
        message: '该幂等请求已有 attempt；平台不会重复运行或再次扣费，请查询 attempt 状态',
        attempt: publicAttempt(reserved.attempt),
      };
    }

    const currentRoute = catalog.getGatewayRoute(route.providerId, route.modelId);
    if (!currentRoute || currentRoute.priceVersionId !== route.priceVersionId) {
      options.ledger.releaseUndispatched({
        attemptId,
        reason: 'route_or_price_changed_before_dispatch',
      });
      throw new AppError(ErrCode.CONFLICT, '平台路由或价格在派发前发生变化，请刷新目录后重试', 409);
    }

    const activeRequest: ActiveRequest = {
      accountId,
      controller: new AbortController(),
      dispatched: false,
      cancelled: false,
      leaseFailed: false,
    };
    active.set(attemptId, activeRequest);
    const adapter = route.protocol === 'openai' ? new OpenAiAdapter() : new AnthropicAdapter();
    const provider = providerFor(route, accountId);
    let sentFrames = false;
    let emittedContent = false;
    let sequence = 0;
    const emit = async (type: string, payload: unknown): Promise<void> => {
      sequence += 1;
      sentFrames = true;
      await writeSse(
        reply,
        sseEnvelope({
          type,
          eventId: newUlid(),
          sequence,
          logicalRequestId,
          attemptId,
          payload,
        }),
      );
    };

    try {
      if (activeRequest.cancelled) {
        options.ledger.releaseUndispatched({ attemptId, reason: 'cancelled_before_dispatch' });
        reply.code(409);
        return { code: ErrCode.CONFLICT, message: '请求在上游派发前已取消' };
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.flushHeaders?.();
      reply.raw.once('close', () => {
        if (!reply.raw.writableEnded) activeRequest.controller.abort();
      });
      await emit('request.accepted', {
        logicalRequestId,
        attemptId,
        providerModelKey,
        providerId: route.providerId,
        modelId: route.modelId,
        protocol: route.protocol,
        priceVersionId: route.priceVersionId,
        currency: reserved.attempt.currency,
        reservedMicros: reserved.attempt.reservedMicros,
      });

      // Close the cancel-vs-dispatch race. A cancel that wins this ledger transition releases
      // the hold; once dispatch wins, cancellation records unknown and keeps the hold for review.
      if (activeRequest.cancelled || activeRequest.controller.signal.aborted) {
        const current = options.ledger.getAttempt(accountId, attemptId);
        if (current?.status === 'reserved' && current.dispatchState === 'not_dispatched') {
          options.ledger.releaseUndispatched({ attemptId, reason: 'cancelled_before_dispatch' });
        }
        await emit('request.failed', {
          code: 'CANCELLED_BEFORE_DISPATCH',
          message: '请求在上游派发前已取消；本次预占已释放',
        }).catch(() => undefined);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
        return;
      }
      if (!options.ledger.markAttemptDispatched(attemptId)) {
        await emit('request.failed', {
          code: 'NOT_DISPATCHED',
          message: '计费 attempt 已终止，平台没有向上游发送请求',
        }).catch(() => undefined);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
        return;
      }
      activeRequest.dispatched = true;
      const leaseIntervalMs = Math.max(1_000, Math.floor(options.config.billingAttemptLeaseMs / 3));
      const leaseTimer = setInterval(() => {
        try {
          if (!options.ledger.renewAttemptLease(attemptId)) {
            activeRequest.leaseFailed = true;
            activeRequest.controller.abort();
          }
        } catch {
          activeRequest.leaseFailed = true;
          activeRequest.controller.abort();
        }
      }, leaseIntervalMs);
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(': ping\n\n');
      }, 15_000);

      const usage = new UsageAccumulator(inputUpper);
      const maxTokens = outputUpper;
      const stream = adapter.chat(
        {
          provider,
          model: route.upstreamModelName,
          messages: body.messages as ChatMessage[],
          ...(tools ? { tools } : {}),
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
          maxTokens,
          signal: activeRequest.controller.signal,
          stream: true,
        },
        { transport: fixedTransport, apiKey: upstreamSecret, timeoutMs: provider.timeoutMs },
      );
      let finished = false;
      try {
        for await (const chunk of stream) {
          if (chunk.type === 'delta' || chunk.type === 'tool_call') {
            emittedContent = true;
            usage.output(chunk.type === 'delta' ? chunk.text : `${chunk.delta.name ?? ''}${chunk.delta.argumentsDelta ?? ''}`);
            await emit('output.delta', { chunk });
            continue;
          }
          if (chunk.type === 'usage') {
            if (chunk.metering) usage.accept(chunk.metering);
            else usage.acceptLegacy(chunk.usage);
            await emit('usage.updated', { chunk });
            continue;
          }
          if (chunk.type === 'error') throw chunk.error;
          if (chunk.type === 'done') {
            if (chunk.partial || activeRequest.controller.signal.aborted) {
              options.ledger.markUnknown(
                attemptId,
                activeRequest.leaseFailed ? 'attempt_lease_renewal_failed' : 'upstream_stream_interrupted',
              );
              await emit('request.failed', {
                code: 'UNKNOWN_EXECUTION',
                message: '上游执行状态未知；预占已保留并进入对账，请查询账单后再重试',
              });
              finished = true;
              break;
            }
            const finalUsage = usage.snapshot();
            const settled = options.ledger.settleTrustedUsage(attemptId, finalUsage);
            if (settled.status === 'settled') {
              await emit('bill.settled', {
                attemptId,
                status: settled.status,
                currency: settled.currency,
                finalMicros: settled.finalMicros,
                reservedMicros: settled.reservedMicros,
                priceVersionId: settled.priceVersionId,
              });
            }
            await emit('request.completed', {
              chunk: { type: 'done', finishReason: chunk.finishReason, partial: false },
              attemptId,
              billingStatus: settled.status,
              currency: settled.currency,
              finalMicros: settled.finalMicros,
              usage: settled.usage,
            });
            finished = true;
            break;
          }
        }
        if (!finished) {
          options.ledger.markUnknown(attemptId, 'upstream_stream_ended_without_final_event');
          await emit('request.failed', {
            code: 'UNKNOWN_EXECUTION',
            message: '上游流未提供可信终态；预占已保留并进入对账，请查询账单后再重试',
          });
        }
      } catch (error) {
        const attempt = options.ledger.getAttempt(accountId, attemptId);
        if (
          attempt?.status === 'reserved' &&
          isDefiniteProviderRejection(error, emittedContent)
        ) {
          options.ledger.releaseRejectedAttempt({
            attemptId,
            reason: `upstream_http_${errorStatus(error)}`,
          });
        } else if (attempt?.status === 'reserved' && attempt.dispatchState === 'dispatched') {
          options.ledger.markUnknown(
            attemptId,
            activeRequest.leaseFailed ? 'attempt_lease_renewal_failed' : 'upstream_outcome_unknown',
          );
        }
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          await emit('request.failed', {
            code: isDefiniteProviderRejection(error, emittedContent)
              ? 'UPSTREAM_REJECTED'
              : 'UNKNOWN_EXECUTION',
            message: safeErrorMessage(error),
          }).catch(() => undefined);
        }
      } finally {
        clearInterval(leaseTimer);
        clearInterval(heartbeat);
      }
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    } catch (error) {
      const attempt = options.ledger.getAttempt(accountId, attemptId);
      if (attempt?.status === 'reserved' && attempt.dispatchState === 'not_dispatched') {
        options.ledger.releaseUndispatched({ attemptId, reason: 'gateway_failed_before_dispatch' });
      } else if (attempt?.status === 'reserved' && activeRequest.dispatched) {
        options.ledger.markUnknown(attemptId, 'gateway_response_or_stream_failed');
      }
      if (!sentFrames && !reply.raw.headersSent) throw error;
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        await emit('request.failed', {
          code: 'UNKNOWN_EXECUTION',
          message: '平台流中断；请查询 attempt 状态后再重试',
        }).catch(() => undefined);
        reply.raw.end();
      }
    } finally {
      active.delete(attemptId);
    }
  });

  app.get<{ Params: { attemptId: string } }>(
    '/api/ai/requests/:attemptId',
    { preHandler: requireAuth },
    async (req) => {
      const attemptId = attemptIdSchema.parse(req.params.attemptId);
      const attempt = options.ledger.getAttempt(req.user!.userId, attemptId);
      if (!attempt) throw new AppError(ErrCode.NOT_FOUND, '平台请求不存在', 404);
      return { request: publicAttempt(attempt) };
    },
  );

  app.post<{ Params: { attemptId: string } }>(
    '/api/ai/requests/:attemptId/cancel',
    { preHandler: requireAuth },
    async (req) => {
      const attemptId = attemptIdSchema.parse(req.params.attemptId);
      const accountId = req.user!.userId;
      let attempt = options.ledger.getAttempt(accountId, attemptId);
      if (!attempt) throw new AppError(ErrCode.NOT_FOUND, '平台请求不存在', 404);
      if (attempt.status === 'reserved') {
        const running = active.get(attemptId);
        if (running && running.accountId === accountId) {
          running.cancelled = true;
          running.controller.abort();
        }
        if (attempt.dispatchState === 'not_dispatched') {
          try {
            attempt = options.ledger.releaseUndispatched({
              attemptId,
              reason: 'cancelled_before_upstream_dispatch',
            });
          } catch (error) {
            // Dispatch may have committed after the initial read; reconcile the winning state.
            const current = options.ledger.getAttempt(accountId, attemptId);
            if (current?.status !== 'reserved' || current.dispatchState !== 'dispatched') throw error;
            attempt = options.ledger.markUnknown(attemptId, 'user_cancelled_after_upstream_dispatch');
          }
        } else {
          attempt = options.ledger.markUnknown(attemptId, 'user_cancelled_after_upstream_dispatch');
        }
      }
      return { request: publicAttempt(attempt) };
    },
  );
}
