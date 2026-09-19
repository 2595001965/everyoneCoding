import type { ChatRequest } from '../../core/adapter';
import type { ChatMessage } from '../../core/message';
import type { ToolDefinition } from '../../core/tool';

/**
 * 内部消息模型 → OpenAI /chat/completions 请求体。
 *
 * 差异处理：
 * - system 是消息数组里的普通一员
 * - assistant 的工具调用放在 `tool_calls`，content 可为 null
 * - tool 结果必须是独立消息，用 tool_call_id 关联
 * - 图片走 `image_url`，支持 http(s) 与 data URI（base64）
 */

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAiContentPart[] | null;
  name?: string;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface OpenAiRequestBody {
  model: string;
  messages: OpenAiMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAiTool[];
  tool_choice?: 'auto' | 'none' | 'required';
}

export function toOpenAiMessages(messages: readonly ChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        out.push({ role: 'system', content: message.content });
        break;
      case 'user': {
        if (typeof message.content === 'string') {
          out.push({ role: 'user', content: message.content });
          break;
        }
        const parts: OpenAiContentPart[] = [];
        const toolResults = message.content.filter((block) => block.type === 'tool_result');
        for (const block of message.content) {
          if (block.type === 'text') parts.push({ type: 'text', text: block.text });
          else if (block.type === 'image') {
            parts.push({
              type: 'image_url',
              image_url: {
                url: block.source.kind === 'url' ? block.source.url : toDataUri(block.source),
              },
            });
          }
        }
        if (parts.length > 0) out.push({ role: 'user', content: parts });
        // 部分中转不支持 user 消息内嵌 tool_result，统一拆成独立 tool 消息
        for (const result of toolResults) {
          if (result.type !== 'tool_result') continue;
          out.push({ role: 'tool', tool_call_id: result.toolUseId, content: result.output });
        }
        break;
      }
      case 'assistant': {
        if (typeof message.content === 'string') {
          out.push({ role: 'assistant', content: message.content });
          break;
        }
        const text = message.content
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('');
        const toolCalls: OpenAiToolCall[] = message.content
          .filter((block) => block.type === 'tool_use')
          .map((block) =>
            block.type === 'tool_use'
              ? {
                  id: block.id,
                  type: 'function' as const,
                  function: { name: block.name, arguments: stringifyArgs(block.input) },
                }
              : (undefined as never),
          );
        out.push({
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        break;
      }
      case 'tool':
        for (const result of message.content) {
          out.push({ role: 'tool', tool_call_id: result.toolUseId, content: result.output });
        }
        break;
      default:
        break;
    }
  }
  return out;
}

export function toOpenAiTools(
  tools: readonly ToolDefinition[] | undefined,
): OpenAiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  }));
}

export function buildOpenAiBody(
  request: ChatRequest,
  options: { stream: boolean; includeUsage?: boolean },
): string {
  const body: OpenAiRequestBody = {
    model: request.model,
    messages: toOpenAiMessages(request.messages),
    ...(options.stream
      ? {
          stream: true,
          ...(options.includeUsage ? { stream_options: { include_usage: true } } : {}),
        }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
  };
  const tools = toOpenAiTools(request.tools);
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return JSON.stringify(body);
}

export function openAiHeaders(
  provider: { headers: Record<string, string> },
  apiKey: string | null,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(provider.headers ?? {}),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

function toDataUri(source: { data: string; mediaType: string }): string {
  return `data:${source.mediaType};base64,${source.data}`;
}

function stringifyArgs(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return '{}';
  }
}
