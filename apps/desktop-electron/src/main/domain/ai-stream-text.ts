/**
 * 网关流块 → 文本的**唯一**判定点。
 *
 * ## 为什么需要这个模块（这不是"多一层封装"）
 *
 * `AiGateway.chat()` 产出的是 `StreamChunk`，其判别值只有五种：
 * `delta` / `tool_call` / `usage` / `error` / `done`（见 `packages/ai/src/core/stream.ts`）。
 * **文本块的判别值是 `'delta'`**。
 *
 * 此前 code / designer / git / pipeline / rename / docs 六个域各自手写了一遍
 * `chunk.type === 'chunk'` —— 六处全错。这种错的可怕之处在于它**不会报错**：
 * 条件恒不成立，`raw` 永远是空串，最后表现成"模型返回为空，请检查模型配置"。
 * 排查方向会被整体带偏到模型/Key/网络上，而真正的原因是拼错了一个字符串字面量。
 *
 * 所以把判定收成一处：**改一次就够了，也不可能只改一半**。
 * （测试夹具里出现的 `'chunk'` 属于 `@ec/shell-api` 的 `AiStreamEvent` 信封标签，
 * 与这里说的原始网关流块不是一回事，别混。）
 */

/** 网关流块的最小结构（不 import @ec/ai 全量类型，保持主进程装配的轻依赖） */
export interface GatewayStreamChunkLike {
  type?: unknown;
  text?: unknown;
  model?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/**
 * 取文本增量：只有 `delta` 块带文本，其余（tool_call/usage/error/done）返回 `null`。
 *
 * 顺带把块里附带的 `model` 透出来，方便调用方记录"这次到底是哪个模型答的"——
 * 实际回答的模型可能因故障转移与请求时的选择不同。
 */
export function textOfStreamChunk(chunk: GatewayStreamChunkLike): {
  text: string;
  model: string | null;
} {
  const model = typeof chunk.model === 'string' && chunk.model.length > 0 ? chunk.model : null;
  if (chunk.type !== 'delta') return { text: '', model };
  return { text: typeof chunk.text === 'string' ? chunk.text : '', model };
}

/** `error` 块转成可读原因；非错误块返回 `null`（错误码映射仍由各域自己决定） */
export function errorOfStreamChunk(chunk: GatewayStreamChunkLike): string | null {
  if (chunk.type !== 'error') return null;
  const raw = chunk.error;
  if (raw === null || raw === undefined) return '模型返回错误';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && 'message' in raw && typeof raw.message === 'string') {
    return raw.message;
  }
  return String(raw);
}
