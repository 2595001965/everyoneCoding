import { resolveEndpoint } from '../../domain/provider';
import type { Provider } from '../../domain/provider';
import type { ModelDiscovery } from '../../domain/model';
import type { AdapterContext, ChatRequest, ProviderAdapter } from '../../core/adapter';
import type { StreamChunk } from '../../core/stream';
import type { ChatMessage } from '../../core/message';
import { estimateTokens, type TokenEstimate } from '../../core/usage';
import { ProtocolError, toAiError } from '../../core/error';
import { TransportError } from '../../core/http';
import { mapHttpError } from '../shared/error-map';
import { parseSse } from '../shared/sse-parser';
import { anthropicHeaders, buildAnthropicBody, DEFAULT_ANTHROPIC_VERSION } from './request-map';
import {
  chunksFromAnthropicResponse,
  chunksFromAnthropicStreamEvent,
  parseAnthropicEvent,
  type AnthropicResponse,
} from './response-map';
import { fetchAnthropicModels, manualModelsDiscovery } from './models';

export interface AnthropicAdapterOptions {
  /** anthropic-version 请求头，缺省 2023-06-01 */
  version?: string;
}

/**
 * Anthropic 兼容协议适配器（FR-MDL-03）。
 *
 * 与 OpenAI 适配器的差异集中在 request-map / response-map：
 * - 顶层 system 字段、必填 max_tokens、x-api-key 头
 * - 流式按 content block index 累积（支持多 block 并行）
 * - 认证头与 OpenAI 完全不同，切勿复用
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly protocol = 'anthropic' as const;
  private readonly version: string;

  constructor(options: AnthropicAdapterOptions = {}) {
    this.version = options.version ?? DEFAULT_ANTHROPIC_VERSION;
  }

  async *chat(request: ChatRequest, context: AdapterContext): AsyncIterable<StreamChunk> {
    const { provider } = request;
    const useStream = request.stream !== false && provider.supportsStream !== false;
    const url = resolveEndpoint(provider.baseUrl, 'anthropic', 'chat');

    let response;
    try {
      response = await context.transport.request({
        url,
        method: 'POST',
        headers: anthropicHeaders(provider, context.apiKey, this.version),
        body: buildAnthropicBody(request, { stream: useStream, anthropicVersion: this.version }),
        timeoutMs: context.timeoutMs ?? provider.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(context.proxy ? { proxy: context.proxy } : {}),
      });
    } catch (error) {
      if (error instanceof TransportError && (error.aborted || request.signal?.aborted)) {
        yield { type: 'done', finishReason: 'aborted', partial: true };
        return;
      }
      throw toAiError(error, { providerId: provider.id, modelId: request.model });
    }

    if (response.status >= 400) {
      throw mapHttpError(response.status, await response.text(), {
        providerId: provider.id,
        modelId: request.model,
        headers: response.headers,
      });
    }

    if (!useStream) {
      yield* this.nonStream(response, provider.id);
      return;
    }
    yield* this.stream(response, request, provider.id);
  }

  private async *nonStream(
    response: { text(): Promise<string> },
    providerId: string,
  ): AsyncIterable<StreamChunk> {
    const text = await response.text();
    let payload: AnthropicResponse;
    try {
      payload = JSON.parse(text) as AnthropicResponse;
    } catch {
      throw new ProtocolError('响应不是合法 JSON', { providerId, snippet: text });
    }
    yield* chunksFromAnthropicResponse(payload, providerId);
  }

  private async *stream(
    response: { body: AsyncIterable<Uint8Array> },
    request: ChatRequest,
    providerId: string,
  ): AsyncIterable<StreamChunk> {
    let sawDone = false;
    let validFrames = 0;
    let malformedFrames = 0;
    try {
      for await (const event of parseSse(response.body)) {
        const data = event.data.trim();
        if (data.length === 0) continue;
        const payload = parseAnthropicEvent(event.data);
        if (!payload) {
          // 形如 `{...}` 却解析失败的 data 行视为损坏帧
          if (data.startsWith('{') || data.startsWith('[')) malformedFrames += 1;
          continue;
        }
        validFrames += 1;
        for (const chunk of chunksFromAnthropicStreamEvent(payload, providerId)) {
          if (chunk.type === 'done') sawDone = true;
          yield chunk;
        }
        if (sawDone) break;
      }
    } catch (error) {
      if (request.signal?.aborted || (error instanceof TransportError && error.aborted)) {
        yield { type: 'done', finishReason: 'aborted', partial: true };
        return;
      }
      throw toAiError(error, { providerId });
    }
    // 损坏 SSE 不能静默成功：全程无有效帧却出现损坏帧时抛协议错误
    if (validFrames === 0 && malformedFrames > 0) {
      throw new ProtocolError('SSE 流数据无法解析（非标准或已损坏）', { providerId });
    }
    if (!sawDone) yield { type: 'done', finishReason: 'stop', partial: true };
  }

  async listModels(provider: Provider, context: AdapterContext): Promise<ModelDiscovery> {
    try {
      const { models } = await fetchAnthropicModels(provider, context, this.version);
      if (models.length === 0) return manualModelsDiscovery(provider);
      return { models, source: 'remote' };
    } catch {
      return manualModelsDiscovery(provider);
    }
  }

  countTokens(messages: readonly ChatMessage[]): TokenEstimate {
    // Anthropic 官方有 /v1/messages/count_tokens，中转普遍无；统一走启发式估算
    let total = 0;
    let margin = 0;
    for (const message of messages) {
      const estimate = estimateTokens(messageText(message) + '\n');
      total += estimate.tokens;
      margin += estimate.margin;
    }
    return { tokens: total, estimated: true, margin };
  }
}

function messageText(message: ChatMessage): string {
  if (message.role === 'system') return message.content;
  if (message.role === 'tool') return message.content.map((item) => item.output).join('\n');
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image') return '[图片]';
      if (block.type === 'tool_use') return JSON.stringify(block.input);
      return block.output;
    })
    .join('\n');
}
