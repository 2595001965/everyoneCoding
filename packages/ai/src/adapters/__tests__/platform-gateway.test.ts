import { describe, expect, it } from 'vitest';
import type { ChatRequest, HttpRequest, HttpResponse, HttpTransport, Provider } from '../../index';
import { TransportError } from '../../core/http';
import { collect } from '../../core/stream';
import { isHostedGatewayProvider, PlatformGatewayAdapter } from '../platform-gateway';

const hostedProvider: Provider = {
  id: 'hosted-openai',
  userId: 'local-user',
  name: 'EveryoneCoding hosted route',
  protocol: 'openai',
  source: 'platform',
  baseUrl: 'https://account.example.test/api/ai/requests',
  keyRef: null,
  headers: { 'x-region': 'must-not-be-forwarded' },
  timeoutMs: 60_000,
  supportsStream: true,
  supportsTools: true,
  supportsVision: true,
  enabled: true,
  order: 0,
  manualModels: ['provider-route/model-route'],
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

class CaptureTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const events = [
      `event: output.delta\ndata: ${JSON.stringify({ payload: { chunk: { type: 'delta', text: 'hosted output' } } })}\n\n`,
      `event: request.completed\ndata: ${JSON.stringify({ payload: { chunk: { type: 'done', finishReason: 'stop', partial: false }, billingStatus: 'settled', attemptId: request.headers?.['idempotency-key'] } })}\n\n`,
    ];
    const body: HttpResponse['body'] = {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield new TextEncoder().encode(event);
      },
    };
    return {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      body,
      async text() {
        return events.join('');
      },
    };
  }
}

describe('PlatformGatewayAdapter', () => {
  it('uses the account session, preserves V2 envelope payloads, and sends route identity rather than an upstream key', async () => {
    const transport = new CaptureTransport();
    const request: ChatRequest = {
      provider: hostedProvider,
      model: 'provider-route/model-route',
      messages: [{ role: 'user', content: 'hosted request body' }],
      maxTokens: 64,
      idempotencyKey: '01K6D12REQUEST00000000000000',
      logicalRequestId: 'logical-request-1',
      stream: true,
    };
    const result = await collect(
      new PlatformGatewayAdapter('openai', 'https://account.example.test').chat(request, {
        transport,
        apiKey: 'account-session-token',
      }),
    );

    expect(result.text).toBe('hosted output');
    const sent = transport.requests[0]!;
    expect(sent.url).toBe(hostedProvider.baseUrl);
    expect(sent.headers).toMatchObject({
      authorization: 'Bearer account-session-token',
      'idempotency-key': request.idempotencyKey,
      'x-ec-logical-request-id': request.logicalRequestId,
    });
    expect(sent.headers).not.toHaveProperty('x-region');
    expect(sent.body).toContain('provider-route/model-route');
    expect(sent.body).not.toContain('upstream');
    expect(sent.body).not.toContain('account-session-token');
  });

  it('refuses to treat a third-party platform-tagged route as the account gateway', () => {
    const untrusted = {
      ...hostedProvider,
      baseUrl: 'https://attacker.example.test/api/ai/requests',
    };
    expect(isHostedGatewayProvider(untrusted, 'https://account.example.test')).toBe(false);
  });

  it('surfaces completed generation with unknown billing as a reconciliation error and does not report success', async () => {
    const transport = new CaptureTransport();
    const request: ChatRequest = {
      provider: hostedProvider,
      model: 'provider-route/model-route',
      messages: [{ role: 'user', content: 'hosted request body' }],
      idempotencyKey: '01K6D12REQUEST00000000000001',
      logicalRequestId: 'logical-request-pending',
      stream: true,
    };
    const original = transport.request.bind(transport);
    transport.request = async (input) => {
      const response = await original(input);
      const data =
        `event: output.delta\ndata: ${JSON.stringify({ payload: { chunk: { type: 'delta', text: 'partial output' } } })}\n\n` +
        `event: request.completed\ndata: ${JSON.stringify({ payload: { chunk: { type: 'done', finishReason: 'stop', partial: false }, billingStatus: 'unknown_pending_reconciliation', attemptId: request.idempotencyKey } })}\n\n`;
      const body: HttpResponse['body'] = {
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode(data);
        },
      };
      return { ...response, body, text: async () => data };
    };

    const run = collect(
      new PlatformGatewayAdapter('openai', 'https://account.example.test').chat(request, {
        transport,
        apiKey: 'account-session-token',
      }),
    );
    await expect(run).rejects.toThrow(/尚未确认最终结算.*先查询账单状态/);
  });

  it('sends an independent gateway cancellation request when the client aborts its SSE stream', async () => {
    const requests: HttpRequest[] = [];
    const transport: HttpTransport = {
      async request(input) {
        requests.push(input);
        const frame =
          `event: output.delta\ndata: ${JSON.stringify({ payload: { chunk: { type: 'delta', text: 'before cancel' } } })}\n\n`;
        const body: HttpResponse['body'] =
          input.method === 'POST' && input.url.endsWith('/cancel')
            ? { async *[Symbol.asyncIterator]() {} }
            : {
                async *[Symbol.asyncIterator]() {
                  yield new TextEncoder().encode(frame);
                  if (input.signal?.aborted) throw new TransportError('aborted', { aborted: true });
                  await new Promise<void>((resolve) =>
                    input.signal?.addEventListener('abort', () => resolve(), { once: true }),
                  );
                  throw new TransportError('aborted', { aborted: true });
                },
              };
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          body,
          async text() {
            return '';
          },
        };
      },
    };
    const controller = new AbortController();
    const request: ChatRequest = {
      provider: hostedProvider,
      model: 'provider-route/model-route',
      messages: [{ role: 'user', content: 'cancel this hosted request' }],
      idempotencyKey: '01K6D12REQUEST00000000000002',
      logicalRequestId: 'logical-request-cancel',
      signal: controller.signal,
      stream: true,
    };
    const iterator = new PlatformGatewayAdapter('openai', 'https://account.example.test')
      .chat(request, { transport, apiKey: 'account-session-token' })[Symbol.asyncIterator]();

    expect(await iterator.next()).toMatchObject({ value: { type: 'delta', text: 'before cancel' } });
    controller.abort();
    expect(await iterator.next()).toMatchObject({
      value: { type: 'done', finishReason: 'aborted', partial: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe(
      `${hostedProvider.baseUrl}/${request.idempotencyKey}/cancel`,
    );
    expect(requests[1]?.headers?.['authorization']).toBe('Bearer account-session-token');
  });
});
