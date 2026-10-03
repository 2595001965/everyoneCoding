import type { AdapterContext, ChatRequest, ProviderAdapter } from '../core/adapter';
import type { ChatMessage } from '../core/message';
import type { StreamChunk } from '../core/stream';
import type { ModelDiscovery, Model } from '../domain/model';
import type { Provider, Protocol } from '../domain/provider';
import { estimateTokens, type TokenEstimate } from '../core/usage';
import { TransportError } from '../core/http';
import { toAiError } from '../core/error';
import { parseSse } from './shared/sse-parser';

/** Platform catalog routes use the trusted account-service gateway endpoint. */
export function isHostedGatewayProvider(
  provider: Provider,
  accountBaseUrl?: string,
): boolean {
  if (provider.source !== 'platform') return false;
  try {
    const actual = new URL(provider.baseUrl);
    if (
      (actual.protocol !== 'https:' && actual.protocol !== 'http:') ||
      actual.username ||
      actual.password ||
      actual.search ||
      actual.hash
    ) {
      return false;
    }
    const actualPath = actual.pathname.replace(/\/+$/, '');
    if (!actualPath.endsWith('/api/ai/requests')) return false;
    if (accountBaseUrl === undefined) return true;

    const expectedBase = new URL(accountBaseUrl);
    const expectedPath = `${expectedBase.pathname.replace(/\/+$/, '')}/api/ai/requests`;
    return (
      actual.origin === expectedBase.origin &&
      actualPath === expectedPath.replace(/\/+$/, '')
    );
  } catch {
    return false;
  }
}

/**
 * Hosted requests use the same ChatMessage and StreamChunk contracts as BYOK, while the
 * account service resolves the actual provider/model and owns all billing decisions.
 */
export class PlatformGatewayAdapter implements ProviderAdapter {
  constructor(
    readonly protocol: Protocol,
    private readonly accountBaseUrl?: string,
  ) {}

  async *chat(request: ChatRequest, context: AdapterContext): AsyncIterable<StreamChunk> {
    const { provider } = request;
    if (!isHostedGatewayProvider(provider, this.accountBaseUrl)) {
      throw new Error('托管模型必须经 EveryoneCoding 平台网关访问');
    }
    if (!context.apiKey) throw new Error('平台托管需要先登录账号');
    if (!request.idempotencyKey || !request.logicalRequestId) {
      throw new Error('平台请求缺少账务幂等标识');
    }
    const endpoint = provider.baseUrl.replace(/\/+$/, '');
    const cancelUrl = `${endpoint}/${encodeURIComponent(request.idempotencyKey)}/cancel`;
    let cancelSent = false;
    const sendCancel = (): void => {
      if (cancelSent || !request.signal?.aborted) return;
      cancelSent = true;
      // The main stream is being torn down; this independent best-effort control request
      // records cancellation even when the SSE socket closes before the abort is observed.
      void context.transport
        .request({
          url: cancelUrl,
          method: 'POST',
          headers: {
            authorization: `Bearer ${context.apiKey}`,
            'idempotency-key': request.idempotencyKey!,
          },
          body: '{}',
          timeoutMs: 5_000,
        })
        .catch(() => undefined);
    };
    request.signal?.addEventListener('abort', sendCancel, { once: true });

    try {
      const response = await context.transport.request({
        url: endpoint,
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'idempotency-key': request.idempotencyKey,
          'x-ec-logical-request-id': request.logicalRequestId,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          ...(request.tools ? { tools: request.tools } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        }),
        timeoutMs: context.timeoutMs ?? provider.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (response.status >= 400) {
        // Do not expose a platform or upstream response body; it may contain request data.
        throw new Error(
          response.status === 401
            ? '平台登录已失效，请重新登录后重试'
            : `平台网关拒绝了请求（${response.status}）`,
        );
      }

      for await (const event of parseSse(response.body)) {
        if (request.signal?.aborted) {
          yield { type: 'done', finishReason: 'aborted', partial: true };
          return;
        }
        if (event.event === 'output.delta' || event.event === 'usage.updated') {
          const payload = eventPayload(parseEventData(event.data));
          if (payload && isStreamChunk(payload['chunk'])) {
            yield payload['chunk'];
          }
        } else if (event.event === 'request.completed') {
          const payload = eventPayload(parseEventData(event.data));
          if (payload?.['billingStatus'] !== 'settled') {
            const attemptId =
              typeof payload?.['attemptId'] === 'string'
                ? payload['attemptId']
                : request.idempotencyKey;
            throw new Error(
              `生成已完成，但平台账务仍待对账；attempt ${attemptId} 尚未确认最终结算，请先查询账单状态后再发起新的收费请求`,
            );
          }
          const chunk = payload?.['chunk'];
          yield isStreamChunk(chunk) && chunk.type === 'done'
            ? chunk
            : { type: 'done', finishReason: 'stop', partial: false };
          return;
        } else if (event.event === 'request.failed') {
          const payload = eventPayload(parseEventData(event.data));
          const message =
            payload && typeof payload['message'] === 'string'
              ? payload['message']
              : '平台请求失败；请查询账单状态后再重试';
          // Intentionally carry no HTTP retry status. The upstream may have executed and
          // the platform will reconcile this attempt before accepting another charge.
          throw new Error(message);
        }
      }
      throw new Error('平台请求流意外结束；已保留 attempt 状态，请查询账单后再重试');
    } catch (error) {
      if (request.signal?.aborted || (error instanceof TransportError && error.aborted)) {
        yield { type: 'done', finishReason: 'aborted', partial: true };
        return;
      }
      throw toAiError(error, { providerId: provider.id, modelId: request.model });
    } finally {
      request.signal?.removeEventListener('abort', sendCancel);
      if (request.signal?.aborted) sendCancel();
    }
  }

  async listModels(provider: Provider, _context: AdapterContext): Promise<ModelDiscovery> {
    const models: Model[] = provider.manualModels.map((name) => ({
      id: name,
      providerId: provider.id,
      name,
      providerModelId: `${provider.id}:${name}`,
      canonicalVendor: null,
      canonicalModel: null,
      displayName: name,
      capability: {
        contextWindow: null,
        maxOutput: null,
        supportsStream: true,
        supportsTools: true,
        supportsVision: true,
        inputPricePerMTok: null,
        outputPricePerMTok: null,
        manualOverride: false,
      },
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    }));
    return { models, source: 'manual' };
  }

  countTokens(messages: ChatMessage[]): TokenEstimate {
    return estimateTokens(JSON.stringify(messages));
  }
}

function parseEventData(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function eventPayload(envelope: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!envelope) return null;
  const payload = envelope['payload'];
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : envelope;
}

function isStreamChunk(value: unknown): value is StreamChunk {
  if (value === null || typeof value !== 'object' || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'delta' || type === 'tool_call' || type === 'usage' || type === 'done';
}
