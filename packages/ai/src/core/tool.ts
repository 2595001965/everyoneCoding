/**
 * 工具（function calling / tool_use）统一模型。
 *
 * 两种协议的差异点：
 * - OpenAI：`tools[]` 为 `{type:'function', function:{name,description,parameters}}`，
 *   调用结果以 `{role:'tool', tool_call_id, content}` 消息回传
 * - Anthropic：`tools[]` 为 `{name,description,input_schema}`，
 *   调用结果以 user 消息 content 中 `{type:'tool_result', tool_use_id, content}` 回传
 *
 * 本文件只定义内部结构与两侧共用的参数解析，映射逻辑放在各适配器。
 */

import type { ToolUseBlock } from './message';

/** JSON Schema 描述（不引入 ajv 等依赖，仅作透传与浅校验） */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters: JsonSchema;
}

/** 流式过程中的增量工具调用 */
export interface ToolCallDelta {
  /** 同一条消息内多个并行调用的序号 */
  index: number;
  id?: string | undefined;
  name?: string | undefined;
  /** JSON 字符串片段，需累积后整体解析 */
  argumentsDelta?: string | undefined;
}

/** 累积完成的工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  /** 解析成功为对象；解析失败保留原始字符串 */
  arguments: unknown;
}

/** 解析工具调用参数：非法 JSON 保留原文，便于上层提示模型修正 */
export function parseToolArguments(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** 把增量序列累积为完整调用列表（按 index 归并，容忍乱序与重复 id） */
export function accumulateToolCalls(deltas: readonly ToolCallDelta[]): ToolCall[] {
  const buckets = new Map<number, { id: string; name: string; args: string }>();
  for (const delta of deltas) {
    const current = buckets.get(delta.index) ?? { id: '', name: '', args: '' };
    if (delta.id) current.id = delta.id;
    if (delta.name) current.name = delta.name;
    if (delta.argumentsDelta) current.args += delta.argumentsDelta;
    buckets.set(delta.index, current);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, value], order) => ({
      id: value.id.length > 0 ? value.id : `call_${index}_${order}`,
      name: value.name,
      arguments: parseToolArguments(value.args),
    }));
}

/** ToolCall → 内部 tool_use 内容块 */
export function toToolUseBlock(call: ToolCall): ToolUseBlock {
  return { type: 'tool_use', id: call.id, name: call.name, input: call.arguments };
}
