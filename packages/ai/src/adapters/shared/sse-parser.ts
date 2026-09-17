/**
 * SSE（text/event-stream）字节级解析器。
 *
 * 必须处理的真实场景：
 * - 一次网络分片只含半条 `data:` 行（粘包 / 截断），需跨分片拼接
 * - 心跳注释行 `: ping` 与空行必须忽略
 * - `[DONE]` 终止标记
 * - `\r\n` 与 `\n` 混用（不同中转实现不一致）
 */

export interface SseEvent {
  /** event: 行指定的事件名（OpenAI 一般不带，Anthropic 必带） */
  event: string | null;
  data: string;
}

const LINE_BREAK = /\r\n|\r|\n/;

export async function* parseSse(
  bytes: AsyncIterable<Uint8Array>,
  options: { decoder?: TextDecoder } = {},
): AsyncGenerator<SseEvent> {
  const decoder = options.decoder ?? new TextDecoder('utf8');
  let buffer = '';
  let event: string | null = null;
  let data: string[] = [];

  const flush = function* (): Generator<SseEvent> {
    if (data.length > 0) {
      yield { event, data: data.join('\n') };
    }
    event = null;
    data = [];
  };

  for await (const chunk of bytes) {
    buffer += decoder.decode(chunk, { stream: true });

    let match: RegExpExecArray | null;
    while ((match = LINE_BREAK.exec(buffer)) !== null) {
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);

      if (line === '') {
        yield* flush();
        continue;
      }
      if (line.startsWith(':')) continue; // 心跳注释
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const line = buffer.replace(/\s+$/, '');
    if (line.startsWith('data:')) data.push(line.slice(5).trim());
    else if (line.startsWith('data')) data.push(line.slice(4).trim());
  }
  // 服务端经常在 EOF 前省略最后一个空行；保留未刷新的 data 事件。
  if (data.length > 0) yield* flush();
}

/** 测试用：把字符串切成字节分片（可精确复现粘包场景） */
export function byteChunks(input: string, chunkSize = 16): Uint8Array[] {
  const bytes = new TextEncoder().encode(input);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    out.push(bytes.slice(i, i + chunkSize));
  }
  return out;
}

/** 判断是否为终止标记（兼容 [DONE] 与部分中转的 [DONE]\n\n 变体） */
export function isDoneSignal(data: string): boolean {
  return data.trim() === '[DONE]';
}
