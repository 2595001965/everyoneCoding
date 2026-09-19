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
import { isDoneSignal, parseSse } from '../shared/sse-parser';
import { buildOpenAiBody, openAiHeaders } from './request-map';
import {
  chunksFromOpenAiResponse,
  chunksFromOpenAiStreamEvent,
  finishReasonFromOpenAi,
  parseOpenAiEvent,
  type OpenAiResponse,
} from './response-map';
import { fetchOpenAiModels, manualModelsDiscovery } from './models';

/**
 * OpenAI 兼容协议适配器（FR-MDL-02）。
 *
 * 兼容策略：
 * - baseUrl 拼接容错（带不带 /v1 都行），自定义请求头原样透传
 * - SSE 解析在字节层处理粘包 / 心跳 / [DONE]
 * - 响应缺字段不抛错，按"无内容"处理；只有结构完全不可用才抛 ProtocolError
 */

export class OpenAiAdapter implements ProviderAdapter {
  readonly protocol = 'openai' as const;

  async *chat(request: ChatRequest, context: AdapterContext): AsyncIterable<StreamChunk> {
    const { provider } = request;
    const useStream = request.stream !== false && provider.supportsStream !== false;
    const url = resolveEndpoint(provider.baseUrl, 'openai', 'chat');

    let response;
    try {
      response = await context.transport.request({
        url,
        method: 'POST',
        headers: openAiHeaders(provider, context.apiKey),
        body: buildOpenAiBody(request, { stream: useStream, includeUsage: true }),
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
    let payload: OpenAiResponse;
    try {
      payload = JSON.parse(text) as OpenAiResponse;
    } catch {
      throw new ProtocolError('响应不是合法 JSON', { providerId, snippet: text });
    }
    yield* chunksFromOpenAiResponse(payload, providerId);
  }

  private async *stream(
    response: { body: AsyncIterable<Uint8Array> },
    request: ChatRequest,
    providerId: string,
  ): AsyncIterable<StreamChunk> {
    let sawDone = false;
    let pendingFinishReason: string | null = null;
    let validFrames = 0;
    let malformedFrames = 0;
    try {
      for await (const event of parseSse(response.body)) {
        if (isDoneSignal(event.data)) {
          sawDone = true;
          break;
        }
        const data = event.data.trim();
        if (data.length === 0) continue;
        const payload = parseOpenAiEvent(event.data);
        if (!payload) {
          // 形如 `{...}` 却解析失败的 data 行视为损坏帧
          if (data.startsWith('{') || data.startsWith('[')) malformedFrames += 1;
          continue;
        }
        validFrames += 1;
        // finish_reason 可能在末帧 usage 之前出现，先记下，统一在终止时产出 done，
        // 确保后续抵达的 usage 帧早于 done，collect 不会在 done 之后丢弃 usage。
        const finishReason = payload.choices?.[0]?.finish_reason;
        if (finishReason) pendingFinishReason = finishReason;
        for (const chunk of chunksFromOpenAiStreamEvent(payload)) {
          if (chunk.type === 'done') continue;
          yield chunk;
        }
      }
    } catch (error) {
      if (error instanceof TransportError && (error.aborted || request.signal?.aborted)) {
        yield { type: 'done', finishReason: 'aborted', partial: true };
        return;
      }
      if (request.signal?.aborted) {
        yield { type: 'done', finishReason: 'aborted', partial: true };
        return;
      }
      throw toAiError(error, { providerId });
    }

    // 损坏 SSE 不能静默成功：全程无有效帧却出现损坏帧时抛协议错误
    if (validFrames === 0 && malformedFrames > 0) {
      throw new ProtocolError('SSE 流数据无法解析（非标准或已损坏）', { providerId });
    }

    // [DONE] 必须产出 done；见到 finish_reason 也视为完整（部分中转省略 [DONE]）
    const complete = sawDone || pendingFinishReason !== null;
    yield {
      type: 'done',
      finishReason: finishReasonFromOpenAi(pendingFinishReason),
      partial: !complete,
    };
  }

  async listModels(provider: Provider, context: AdapterContext): Promise<ModelDiscovery> {
    try {
      const { models, note } = await fetchOpenAiModels(provider, context);
      if (models.length === 0) return manualModelsDiscovery(provider);
      return {
        models,
        source: 'remote',
        ...(note ? { note } : {}),
      };
    } catch {
      // 与连接测试保持一致：列模型失败不抛，回退手填清单
      return manualModelsDiscovery(provider);
    }
  }

  countTokens(messages: readonly ChatMessage[]): TokenEstimate {
    // OpenAI 兼容端普遍不提供计数接口，统一走启发式估算
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
