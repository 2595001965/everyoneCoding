/**
 * HTTP 传输抽象。
 *
 * 为什么不用全局 fetch：
 * - 需要逐块读取 SSE 字节流（跨 chunk 粘包必须在字节层处理）
 * - 需要为 AI 请求单独配置代理（HTTP / HTTPS / SOCKS5），与系统代理分离
 * - 需要可控的超时与中断语义（中断必须保留已生成部分）
 *
 * 因此传输层抽象为 `HttpTransport`，Node 环境由 `node-transport.ts` 实现，
 * 测试可直接起本地 HTTP 服务跑真实请求，也可用脚本化实现模拟异常流。
 */

/** AI 请求独立代理（FR-MDL-11）：与系统代理分离 */
export type ProxyKind = 'http' | 'https' | 'socks5';

export interface ProxyConfig {
  kind: ProxyKind;
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
}

export type HttpMethod = 'GET' | 'POST';

export interface HttpRequest {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  /** 整体超时（毫秒）；缺省由调用方指定 */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 本次请求使用的代理；未设置则直连 */
  proxy?: ProxyConfig | undefined;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** 响应字节流；非流式场景消费完即结束 */
  body: AsyncIterable<Uint8Array>;
  /** 便捷方法：读完整响应体（非流式请求使用） */
  text(): Promise<string>;
}

export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
  /** 释放底层连接；可重复调用 */
  close?(): Promise<void>;
}

/** 传输层异常：未拿到响应（连接失败 / 超时 / 中断） */
export class TransportError extends Error {
  readonly aborted: boolean;
  readonly timedOut: boolean;

  constructor(
    message: string,
    options: { aborted?: boolean; timedOut?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'TransportError';
    this.aborted = options.aborted ?? false;
    this.timedOut = options.timedOut ?? false;
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false });
    }
    Object.setPrototypeOf(this, TransportError.prototype);
  }
}

/** 把 Node 流包装成 AsyncIterable<Uint8Array>（含背压与错误传播） */
export function toAsyncIterable(stream: {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}): AsyncIterable<Uint8Array> & { cancel(): void } {
  const queue: Uint8Array[] = [];
  let done = false;
  let failure: Error | null = null;
  let notify: (() => void) | null = null;
  let cancelled = false;

  const push = (chunk: Buffer | string): void => {
    queue.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : new Uint8Array(chunk));
    stream.pause();
    const fn = notify;
    notify = null;
    if (fn) fn();
  };

  const finish = (error?: Error): void => {
    if (error) failure = error;
    done = true;
    const fn = notify;
    notify = null;
    if (fn) fn();
  };

  const onData = ((chunk: Buffer | string) => push(chunk)) as (...args: unknown[]) => void;
  const onEnd = (() => finish()) as (...args: unknown[]) => void;
  const onError = ((error: Error) => finish(error)) as (...args: unknown[]) => void;
  // 客户端 destroy 时先 aborted 再 close：视为中断，已读到的字节仍然保留
  const onAborted = (() => finish(new TransportError('响应被中断', { aborted: true }))) as (
    ...args: unknown[]
  ) => void;
  const onClose = (() => finish()) as (...args: unknown[]) => void;

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('error', onError);
  stream.on('aborted', onAborted);
  stream.on('close', onClose);

  const iterable = {
    cancel(): void {
      cancelled = true;
      done = true;
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('aborted', onAborted);
      stream.off('close', onClose);
      const fn = notify;
      notify = null;
      if (fn) fn();
    },
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          return new Promise((resolve, reject) => {
            const flush = (): void => {
              if (cancelled) {
                resolve({ value: undefined, done: true });
                return;
              }
              if (queue.length > 0) {
                const value = queue.shift() as Uint8Array;
                resolve({ value, done: false });
                return;
              }
              if (failure) {
                reject(failure);
                return;
              }
              if (done) {
                resolve({ value: undefined, done: true });
                return;
              }
              notify = flush;
              stream.resume();
            };
            flush();
          });
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          iterable.cancel();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return iterable;
}
