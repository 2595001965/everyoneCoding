import type { FinishReason, StreamChunk } from '../../core/stream';
import { usageOf, type Usage } from '../../core/usage';
import type { ToolCallDelta } from '../../core/tool';
import { ProtocolError } from '../../core/error';
import { tokenCount, type MeteringUpdate } from '../../core/metering';

/**
 * Anthropic 响应 → 内部 StreamChunk。
 *
 * 非流式：`content` 是块数组（text / tool_use），`stop_reason` 映射为 finish reason。
 * 流式：按 content block index 累积，支持多个并行 block（text 与 tool_use 交错）。
 */

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export interface AnthropicResponse {
  id?: string;
  type?: string;
  role?: string;
  content?: AnthropicContentBlock[];
  model?: string;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: AnthropicUsage;
}

/** Anthropic 的缓存 token 计入输入侧，避免费用统计漏项 */
export function usageFromAnthropic(usage: AnthropicUsage | undefined): Usage | null {
  if (!usage) return null;
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  return usageOf(input, usage.output_tokens ?? 0);
}

export function meteringFromAnthropic(
  usage: AnthropicUsage, final: boolean, providerRequestId?: string,
): MeteringUpdate {
  const report: MeteringUpdate['report'] = {
    inputIncludesCache: false, reasoningTokensIncludedInOutput: true,
  };
  if ('input_tokens' in usage) report.inputTokens = tokenCount(usage.input_tokens);
  if ('output_tokens' in usage) report.outputTokens = tokenCount(usage.output_tokens);
  if ('cache_read_input_tokens' in usage) report.cacheReadTokens = tokenCount(usage.cache_read_input_tokens);
  if ('cache_creation_input_tokens' in usage || 'cache_creation' in usage) {
    const total = tokenCount(usage.cache_creation_input_tokens);
    const five = tokenCount(usage.cache_creation?.ephemeral_5m_input_tokens);
    const hour = tokenCount(usage.cache_creation?.ephemeral_1h_input_tokens);
    // TTL 缺失时保留 unknown 桶；不能擅自按默认 5m 计价。
    const buckets: Record<string, number> = {};
    if (five !== null) buckets['5m'] = five;
    if (hour !== null) buckets['1h'] = hour;
    const known = (five ?? 0) + (hour ?? 0);
    if (total !== null && total > known) buckets['unknown'] = total - known;
    report.cacheWriteTokensByTtl = total !== null && total < known ? null
      : total !== null || five !== null || hour !== null ? buckets : null;
  }
  return { report, mode: 'snapshot', final, raw: usage,
    ...(providerRequestId ? { providerRequestId } : {}) };
}

export function finishReasonFromAnthropic(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    default:
      return 'stop';
  }
}

export function chunksFromAnthropicResponse(
  payload: AnthropicResponse,
  providerId?: string,
): StreamChunk[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.content)) {
    throw new ProtocolError('响应缺少 content 字段', {
      ...(providerId ? { providerId } : {}),
      snippet: JSON.stringify(payload ?? null).slice(0, 300),
    });
  }
  const chunks: StreamChunk[] = [];

  payload.content.forEach((block, index) => {
    if (block.type === 'text') {
      chunks.push({ type: 'delta', text: block.text });
      return;
    }
    if (block.type === 'tool_use') {
      const delta: ToolCallDelta = {
        index,
        id: block.id,
        name: block.name,
        argumentsDelta: JSON.stringify(block.input ?? {}),
      };
      chunks.push({ type: 'tool_call', delta });
    }
  });

  const usage = usageFromAnthropic(payload.usage);
  if (usage) chunks.push({ type: 'usage', usage, metering: meteringFromAnthropic(payload.usage!, true, payload.id) });
  chunks.push({
    type: 'done',
    finishReason: finishReasonFromAnthropic(payload.stop_reason),
    partial: false,
  });
  return chunks;
}

/* ------------------------------ 流式事件 ------------------------------ */

export type AnthropicStreamEvent =
  | { type: 'message_start'; message?: AnthropicResponse }
  | { type: 'content_block_start'; index?: number; content_block?: AnthropicContentBlock }
  | {
      type: 'content_block_delta';
      index?: number;
      delta?: { type?: string; text?: string; partial_json?: string };
    }
  | { type: 'content_block_stop'; index?: number }
  | { type: 'message_delta'; delta?: { stop_reason?: string | null }; usage?: AnthropicUsage }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error?: { type?: string; message?: string } };

/** 每个流式事件 → 0~N 个 chunk */
export function chunksFromAnthropicStreamEvent(
  event: AnthropicStreamEvent,
  providerId?: string,
): StreamChunk[] {
  switch (event.type) {
    case 'message_start': {
      const usage = usageFromAnthropic(event.message?.usage);
      return usage ? [{ type: 'usage', usage, metering: meteringFromAnthropic(event.message!.usage!, false, event.message?.id) }] : [];
    }
    case 'content_block_start': {
      const block = event.content_block;
      if (!block) return [];
      if (block.type === 'text') {
        return block.text.length > 0 ? [{ type: 'delta', text: block.text }] : [];
      }
      if (block.type === 'tool_use') {
        // 仅声明工具调用的 id / name；真实参数以 input_json_delta 流式下发，
        // 切勿把 content_block_start 里的 input:{} 当作 argumentsDelta 重复拼接。
        const delta: ToolCallDelta = {
          index: event.index ?? 0,
          id: block.id,
          name: block.name,
        };
        return [{ type: 'tool_call', delta }];
      }
      return [];
    }
    case 'content_block_delta': {
      const delta = event.delta;
      if (!delta) return [];
      if (delta.type === 'text_delta' && delta.text) return [{ type: 'delta', text: delta.text }];
      if (delta.type === 'input_json_delta' && delta.partial_json) {
        const toolDelta: ToolCallDelta = {
          index: event.index ?? 0,
          argumentsDelta: delta.partial_json,
        };
        return [{ type: 'tool_call', delta: toolDelta }];
      }
      // 少数中转不带 type 字段，按内容推断
      if (!delta.type && delta.text) return [{ type: 'delta', text: delta.text }];
      if (!delta.type && delta.partial_json) {
        return [
          {
            type: 'tool_call',
            delta: { index: event.index ?? 0, argumentsDelta: delta.partial_json },
          },
        ];
      }
      return [];
    }
    case 'message_delta': {
      const chunks: StreamChunk[] = [];
      const usage = usageFromAnthropic(event.usage);
      if (usage) chunks.push({ type: 'usage', usage, metering: meteringFromAnthropic(event.usage!, event.delta?.stop_reason != null) });
      if (event.delta?.stop_reason !== undefined) {
        chunks.push({
          type: 'done',
          finishReason: finishReasonFromAnthropic(event.delta.stop_reason),
          partial: false,
        });
      }
      return chunks;
    }
    case 'message_stop':
      return [{ type: 'done', finishReason: 'stop', partial: false }];
    case 'ping':
      return [];
    case 'error':
      throw new ProtocolError(` Anthropic 流式错误：${event.error?.message ?? '未知错误'}`, {
        ...(providerId ? { providerId } : {}),
        snippet: JSON.stringify(event.error ?? {}),
      });
    default:
      return [];
  }
}

export function parseAnthropicEvent(data: string): AnthropicStreamEvent | null {
  if (data.trim().length === 0) return null;
  try {
    return JSON.parse(data) as AnthropicStreamEvent;
  } catch {
    return null;
  }
}
