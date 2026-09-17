import type { AdapterContext } from '../../core/adapter';
import type { EmbeddingSuccess, EmbeddingUnavailable } from '../../core/embedding';
import { embeddingUnavailable } from '../../core/embedding';
import { ProtocolError, toAiError } from '../../core/error';
import { TransportError } from '../../core/http';
import type { Model } from '../../domain/model';
import { resolveEndpoint, type Provider } from '../../domain/provider';
import { mapHttpError } from '../shared/error-map';
import { openAiHeaders } from './request-map';

/**
 * OpenAI 兼容协议的 `/embeddings` 调用（T2-03 的向量来源）。
 *
 * 约定：
 * - 只有 openai 兼容协议可用；Anthropic 协议没有 embedding 接口，直接返回不可用
 * - 任何失败都转成 `{ ok: false }`（含 401 / 404 / 超时），**不抛错**
 *   —— 检索路径必须能无感降级为关键词模式
 */

export interface OpenAiEmbeddingRequestBody {
  model: string;
  input: string[];
  dimensions?: number;
  encoding_format?: 'float';
}

export interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export function buildOpenAiEmbeddingBody(
  model: string,
  inputs: readonly string[],
  dimensions?: number | null,
): string {
  const body: OpenAiEmbeddingRequestBody = {
    model,
    input: [...inputs],
    encoding_format: 'float',
  };
  if (dimensions !== undefined && dimensions !== null) body.dimensions = dimensions;
  return JSON.stringify(body);
}

/** 解析响应；结构不可用返回 null（由调用方转成不可用结果） */
export function parseOpenAiEmbeddingResponse(raw: string): OpenAiEmbeddingResponse | null {
  try {
    const parsed = JSON.parse(raw) as OpenAiEmbeddingResponse;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.data)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 按 index 排序取回向量，保证与输入顺序一致 */
export function vectorsFromEmbeddingResponse(response: OpenAiEmbeddingResponse, expected: number): number[][] | null {
  const entries = response.data ?? [];
  if (entries.length !== expected) return null;
  const ordered = [...entries].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors: number[][] = [];
  for (const entry of ordered) {
    if (!Array.isArray(entry.embedding) || entry.embedding.length === 0) return null;
    vectors.push(entry.embedding);
  }
  return vectors;
}

export async function embedWithOpenAi(input: {
  provider: Provider;
  model: Model;
  inputs: readonly string[];
  context: AdapterContext;
  dimensions?: number | null;
  modelName?: string;
}): Promise<EmbeddingSuccess | EmbeddingUnavailable> {
  const { provider, model, inputs, context } = input;
  if (inputs.length === 0) {
    return embeddingUnavailable('failed', '没有需要向量化的文本');
  }

  const modelName = input.modelName ?? model.name;
  let response;
  try {
    response = await context.transport.request({
      url: resolveEndpoint(provider.baseUrl, provider.protocol, 'embeddings'),
      method: 'POST',
      headers: openAiHeaders(provider, context.apiKey),
      body: buildOpenAiEmbeddingBody(modelName, inputs, input.dimensions ?? null),
      timeoutMs: context.timeoutMs ?? provider.timeoutMs,
      ...(input.context.proxy ? { proxy: input.context.proxy } : {}),
    });
  } catch (error) {
    if (error instanceof TransportError) {
      return embeddingUnavailable('failed', `向量化请求未完成：${error.message}`);
    }
    const mapped = toAiError(error, { providerId: provider.id, modelId: model.id });
    return embeddingUnavailable('failed', `向量化失败：${mapped.userMessage}`);
  }

  const text = await response.text();
  if (response.status >= 400) {
    const mapped = mapHttpError(response.status, text, { providerId: provider.id, modelId: model.id, headers: response.headers });
    // 404 / 400 往往意味着该中转不提供 /embeddings：归为「不支持」而非「失败」
    const code: EmbeddingUnavailable['code'] = response.status === 404 ? 'unsupported-model' : 'failed';
    return embeddingUnavailable(code, `向量化不可用（HTTP ${response.status}）：${mapped.userMessage}`);
  }

  const payload = parseOpenAiEmbeddingResponse(text);
  if (!payload) {
    const protocolError = new ProtocolError('向量化响应不是合法 JSON', { providerId: provider.id, snippet: text });
    return embeddingUnavailable('failed', protocolError.userMessage);
  }

  const vectors = vectorsFromEmbeddingResponse(payload, inputs.length);
  if (!vectors) {
    return embeddingUnavailable('failed', '向量化响应条数与输入不一致，已忽略本次结果');
  }

  return {
    ok: true,
    vectors,
    model: payload.model ?? modelName,
    dimensions: vectors[0]?.length ?? 0,
    usage: payload.usage
      ? {
          promptTokens: payload.usage.prompt_tokens ?? 0,
          totalTokens: payload.usage.total_tokens ?? payload.usage.prompt_tokens ?? 0,
        }
      : null,
    latencyMs: 0,
  };
}
