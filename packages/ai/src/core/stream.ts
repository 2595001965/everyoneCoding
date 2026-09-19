/**
 * 流式统一模型。
 *
 * - 两协议（OpenAI SSE / Anthropic SSE）统一产出 `AsyncIterable<StreamChunk>`
 * - chunk 类型只有五种：delta / tool_call / usage / error / done
 * - 中断（AbortSignal）不是错误：`done.partial = true` 且已产出的 delta 全部保留
 */

import type { AiError } from './error';
import type { Usage, TokenEstimate } from './usage';
import { mergeUsage } from './usage';
import { accumulateToolCalls, type ToolCall, type ToolCallDelta } from './tool';

export type FinishReason = 'stop' | 'length' | 'tool_use' | 'content_filter' | 'error' | 'aborted';

export type StreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; delta: ToolCallDelta }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; error: AiError }
  | { type: 'done'; finishReason: FinishReason; partial: boolean };

export interface CollectedMessage {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage | null;
  finishReason: FinishReason;
  /** true 表示被中断或出错，内容不完整 */
  partial: boolean;
  error: AiError | null;
}

/** 把 chunk 数组转成 AsyncIterable（测试与回放用） */
export async function* streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) yield chunk;
}

/** 把字符串切成若干 delta（模拟真实流式分片） */
export function deltasOf(text: string, size = 8): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push({ type: 'delta', text: text.slice(i, i + size) });
  }
  return chunks;
}

/**
 * 把流无损重组为完整消息。
 *
 * 约定：
 * - 遇到 error / done 即停止消费（done 之后不再有内容）
 * - usage 以最后一个为准（部分中转会分段上报）
 * - 工具调用按 index 累积；未闭合的 JSON 参数保留原文
 */
export async function collect(chunks: AsyncIterable<StreamChunk>): Promise<CollectedMessage> {
  let text = '';
  const deltas: ToolCallDelta[] = [];
  let usage: Usage | null = null;
  let error: AiError | null = null;
  let finishReason: FinishReason = 'stop';
  let partial = false;

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'delta':
        text += chunk.text;
        break;
      case 'tool_call':
        deltas.push(chunk.delta);
        break;
      case 'usage':
        usage = mergeUsage(usage, chunk.usage);
        break;
      case 'error':
        error = chunk.error;
        partial = true;
        finishReason = 'error';
        break;
      case 'done':
        finishReason = chunk.finishReason;
        partial = chunk.partial;
        break;
      default:
        break;
    }
    // error / done 之后不再消费：done 是流的终点，后续不应再有内容帧
    if (chunk.type === 'done') break;
    if (finishReason === 'error') break;
  }

  const toolCalls = accumulateToolCalls(deltas);
  if (toolCalls.length > 0 && finishReason === 'stop') finishReason = 'tool_use';

  return { text, toolCalls, usage, finishReason, partial, error };
}

/** 只取文本（丢弃工具调用与用量），用于连接测试等极简场景 */
export async function collectText(chunks: AsyncIterable<StreamChunk>): Promise<string> {
  return (await collect(chunks)).text;
}

/** 把 token 估算结果挂到请求侧：供上层判断是否超预算 */
export interface StreamStats {
  promptTokens: TokenEstimate | null;
  chunks: number;
}
