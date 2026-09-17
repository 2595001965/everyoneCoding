import type { FinishReason, StreamChunk } from '../../core/stream';
import type { Usage } from '../../core/usage';
import { usageOf } from '../../core/usage';
import type { ToolCallDelta } from '../../core/tool';
import { ProtocolError } from '../../core/error';

/**
 * OpenAI 响应 → 内部 StreamChunk 序列。
 *
 * 流式与非流式统一产出 chunk，上层用 collect() 就能还原完整消息。
 * 非标准中转允许字段缺失：缺字段时不抛错，按"该 chunk 无内容"处理。
 */

export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface OpenAiDelta {
  content?: string | null;
  role?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface OpenAiChoice {
  index?: number;
  delta?: OpenAiDelta;
  message?: OpenAiDelta & { content?: string | null };
  finish_reason?: string | null;
}

export interface OpenAiResponse {
  id?: string;
  choices?: OpenAiChoice[];
  usage?: OpenAiUsage;
  error?: unknown;
}

export function usageFromOpenAi(usage: OpenAiUsage | undefined): Usage | null {
  if (!usage) return null;
  return usageOf(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
}

export function finishReasonFromOpenAi(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** 非流式：整包响应 → chunk 序列 */
export function chunksFromOpenAiResponse(payload: OpenAiResponse, providerId?: string): StreamChunk[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.choices)) {
    throw new ProtocolError('响应缺少 choices 字段', {
      ...(providerId ? { providerId } : {}),
      snippet: JSON.stringify(payload ?? null).slice(0, 300),
    });
  }
  const chunks: StreamChunk[] = [];
  const choice = payload.choices[0];
  const message = choice?.message;

  if (message?.content) chunks.push({ type: 'delta', text: message.content });

  for (const [index, call] of (message?.tool_calls ?? []).entries()) {
    const delta: ToolCallDelta = {
      index: call.index ?? index,
      ...(call.id ? { id: call.id } : {}),
      ...(call.function?.name ? { name: call.function.name } : {}),
      ...(call.function?.arguments ? { argumentsDelta: call.function.arguments } : {}),
    };
    chunks.push({ type: 'tool_call', delta });
  }

  const usage = usageFromOpenAi(payload.usage);
  if (usage) chunks.push({ type: 'usage', usage });
  // 非流式必须尊重服务端 finish_reason（length / tool_calls / content_filter …）
  chunks.push({ type: 'done', finishReason: finishReasonFromOpenAi(choice?.finish_reason), partial: false });
  return chunks;
}

/** 流式：单个 SSE data 对象 → 若干 chunk（usage 只在末帧出现） */
export function chunksFromOpenAiStreamEvent(payload: OpenAiResponse): StreamChunk[] {
  if (!payload || typeof payload !== 'object') return [];
  const chunks: StreamChunk[] = [];
  const choice = payload.choices?.[0];

  if (choice?.delta?.content) chunks.push({ type: 'delta', text: choice.delta.content });

  for (const [order, call] of (choice?.delta?.tool_calls ?? []).entries()) {
    const delta: ToolCallDelta = {
      index: call.index ?? order,
      ...(call.id ? { id: call.id } : {}),
      ...(call.function?.name ? { name: call.function.name } : {}),
      ...(call.function?.arguments ? { argumentsDelta: call.function.arguments } : {}),
    };
    chunks.push({ type: 'tool_call', delta });
  }

  const usage = usageFromOpenAi(payload.usage);
  if (usage) chunks.push({ type: 'usage', usage });

  if (choice?.finish_reason) {
    chunks.push({ type: 'done', finishReason: finishReasonFromOpenAi(choice.finish_reason), partial: false });
  }
  return chunks;
}

/** 解析 SSE data 行；非 JSON 行返回 null（交给上层忽略） */
export function parseOpenAiEvent(data: string): OpenAiResponse | null {
  if (data.trim().length === 0) return null;
  try {
    return JSON.parse(data) as OpenAiResponse;
  } catch {
    return null;
  }
}
