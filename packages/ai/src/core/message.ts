/**
 * AI 层统一消息模型。
 *
 * 目标：屏蔽 OpenAI 与 Anthropic 两协议差异，上层（上下文引擎 / 流水线 / 记忆抽取）
 * 只与本文件定义的类型打交道。
 *
 * 约定：
 * - 内容一律为「块数组」，纯文本场景可用 `text()` 快捷构造
 * - system 在内部模型中是一条独立消息；由各适配器决定是否提升为顶层字段
 * - tool_use 与 tool_result 都是内容块，两协议可无损互转
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/* ----------------------------- 内容块 ----------------------------- */

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageSourceUrl {
  kind: 'url';
  url: string;
}

export interface ImageSourceBase64 {
  kind: 'base64';
  data: string;
  mediaType: string;
}

export interface ImageBlock {
  type: 'image';
  source: ImageSourceUrl | ImageSourceBase64;
}

/** 助手发起的工具调用 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  /** 已解析的入参对象；解析失败时为原始字符串 */
  input: unknown;
}

/** 工具执行结果（回传给模型） */
export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  /** 文本化结果（图片等多模态结果暂以占位文本表达） */
  output: string;
  isError?: boolean;
}

export type UserContentBlock = TextBlock | ImageBlock | ToolResultBlock;
export type AssistantContentBlock = TextBlock | ToolUseBlock;
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

/* ------------------------------ 消息 ------------------------------ */

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string | UserContentBlock[];
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | AssistantContentBlock[];
}

export interface ToolResultMessage {
  role: 'tool';
  content: ToolResultBlock[];
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/* ----------------------------- 构造器 ----------------------------- */

export function systemMessage(content: string): SystemMessage {
  return { role: 'system', content };
}

export function userMessage(content: string | UserContentBlock[]): UserMessage {
  return { role: 'user', content };
}

export function assistantMessage(content: string | AssistantContentBlock[]): AssistantMessage {
  return { role: 'assistant', content };
}

export function toolResultMessage(results: ToolResultBlock[]): ToolResultMessage {
  return { role: 'tool', content: results };
}

/* ----------------------------- 读取器 ----------------------------- */

/** 取消息的块数组形式（纯文本自动包装为单 text 块） */
export function blocksOf(message: ChatMessage): ContentBlock[] {
  if (message.role === 'system') return [{ type: 'text', text: message.content }];
  if (message.role === 'tool') return [...message.content];
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return [...message.content];
}

/** 取消息的全部文本（tool_use 输出为 JSON，便于日志与 token 估算） */
export function textOf(message: ChatMessage): string {
  return blocksOf(message)
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'image':
          return block.source.kind === 'url' ? `[图片 ${block.source.url}]` : '[图片]';
        case 'tool_use':
          return `[调用 ${block.name}] ${safeStringify(block.input)}`;
        case 'tool_result':
          return block.output;
        default:
          return '';
      }
    })
    .join('');
}

/** 取出 assistant 消息中的全部工具调用 */
export function toolUsesOf(message: ChatMessage): ToolUseBlock[] {
  if (message.role !== 'assistant') return [];
  if (typeof message.content === 'string') return [];
  return message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? '';
  } catch {
    return '';
  }
}
