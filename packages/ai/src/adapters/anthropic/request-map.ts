import type { ChatRequest } from '../../core/adapter';
import type { ChatMessage } from '../../core/message';
import type { ToolDefinition } from '../../core/tool';

/**
 * 内部消息模型 → Anthropic /v1/messages 请求体。
 *
 * 与 OpenAI 的三大差异：
 * 1. `system` 是顶层独立字段，不进 messages 数组
 * 2. `max_tokens` 必填（缺省时用默认值兜底，否则服务端直接 400）
 * 3. 工具结果 `tool_result` 放在 **user** 消息的 content 块中
 */

export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MAX_TOKENS = 4096;

export type AnthropicRequestBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64' | 'url'; media_type: string; data: string } | { type: 'url'; url: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicRequestBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  stream?: boolean;
  temperature?: number;
  tools?: AnthropicTool[];
}

export interface AnthropicRequestParts {
  system: string | undefined;
  messages: AnthropicMessage[];
}

/** 拆出 system 并转换其余消息；相邻同角色消息会被合并（Anthropic 要求严格交替） */
export function toAnthropicParts(messages: readonly ChatMessage[]): AnthropicRequestParts {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      const blocks: AnthropicRequestBlock[] = message.content.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.toolUseId,
        content: result.output,
        ...(result.isError ? { is_error: true } : {}),
      }));
      appendUser(out, blocks);
      continue;
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        appendUser(out, message.content);
        continue;
      }
      const blocks: AnthropicRequestBlock[] = [];
      for (const block of message.content) {
        if (block.type === 'text') blocks.push({ type: 'text', text: block.text });
        else if (block.type === 'image') {
          if (block.source.kind === 'base64') {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: block.source.mediaType, data: block.source.data },
            });
          } else {
            blocks.push({ type: 'image', source: { type: 'url', url: block.source.url } });
          }
        } else if (block.type === 'tool_result') {
          blocks.push({
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.output,
            ...(block.isError ? { is_error: true } : {}),
          });
        }
      }
      appendUser(out, blocks);
      continue;
    }

    // assistant
    const blocks: AnthropicRequestBlock[] = [];
    if (typeof message.content === 'string') {
      blocks.push({ type: 'text', text: message.content });
    } else {
      for (const block of message.content) {
        if (block.type === 'text') blocks.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use') {
          blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} });
        }
      }
    }
    appendAssistant(out, blocks);
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
  };
}

function appendUser(out: AnthropicMessage[], content: string | AnthropicRequestBlock[]): void {
  const last = out[out.length - 1];
  if (last && last.role === 'user') {
    last.content = mergeContent(last.content, content);
    return;
  }
  out.push({ role: 'user', content });
}

function appendAssistant(out: AnthropicMessage[], content: AnthropicRequestBlock[]): void {
  const last = out[out.length - 1];
  if (last && last.role === 'assistant') {
    last.content = mergeContent(last.content, content) as AnthropicRequestBlock[];
    return;
  }
  out.push({ role: 'assistant', content });
}

function mergeContent(
  current: string | AnthropicRequestBlock[],
  incoming: string | AnthropicRequestBlock[],
): string | AnthropicRequestBlock[] {
  const currentBlocks = typeof current === 'string' ? [{ type: 'text' as const, text: current }] : current;
  const incomingBlocks = typeof incoming === 'string' ? [{ type: 'text' as const, text: incoming }] : incoming;
  return [...currentBlocks, ...incomingBlocks];
}

export function toAnthropicTools(tools: readonly ToolDefinition[] | undefined): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
  }));
}

export function buildAnthropicBody(
  request: ChatRequest,
  options: { stream: boolean; anthropicVersion?: string },
): string {
  const parts = toAnthropicParts(request.messages);
  const body: AnthropicRequestBody = {
    model: request.model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: parts.messages,
    ...(parts.system !== undefined ? { system: parts.system } : {}),
    ...(options.stream ? { stream: true } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };
  const tools = toAnthropicTools(request.tools);
  if (tools) body.tools = tools;
  return JSON.stringify(body);
}

export function anthropicHeaders(
  provider: { headers: Record<string, string> },
  apiKey: string | null,
  version: string = DEFAULT_ANTHROPIC_VERSION,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'anthropic-version': version,
    ...(provider.headers ?? {}),
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
  };
}
