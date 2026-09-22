import {
  decodeFrame,
  encodeFrame,
  HOST_CAPABILITIES,
  SIDECAR_EVENTS,
  type HostResultFrame,
  type RequestFrame,
  type SidecarToHostFrame,
  type WelcomeFrame,
  type WireError,
} from './protocol';

/**
 * 侧车侧的链路层：帧收发、请求关联、宿主能力调用。
 *
 * 与 `protocol.ts` 的分工：那边只做**纯**编解码（无 IO、可单测），
 * 这边负责**状态**（未决请求表、关闭标志）与**IO 适配**。
 *
 * 之所以把 IO 抽象成 `SidecarTransport`：单测里用一对内存管道即可跑完整的
 * 请求/响应/事件/宿主能力回环，不需要真的起进程；生产里则由 `index.ts`
 * 用 `process.stdin` / `process.stdout` 实现同一接口。
 */

export interface SidecarTransport {
  /** 逐行读取；迭代结束时表示对端关闭了管道 */
  lines(): AsyncIterable<string>;
  write(line: string): void | Promise<void>;
}

export interface InboundHandlers {
  onWelcome(frame: WelcomeFrame): void;
  onRequest(frame: RequestFrame): void;
  /** 流结束（宿主退出 / 主动关闭） */
  onEnd(): void;
}

/** 宿主能力调用失败时的错误（可跨帧传递的 `{code,message}` 形状） */
export class HostCallError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HostCallError';
    this.code = code;
  }

  toWire(): WireError {
    return { code: this.code, message: this.message };
  }
}

export interface SidecarLink {
  send(frame: SidecarToHostFrame): void;
  /** 推一条单向事件（域进度 / AI 分片） */
  emitEvent(op: string, payload: unknown): void;
  /** 推一条日志（走正式通道而不是 stdout，避免污染协议流） */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /**
   * 请求宿主能力。
   *
   * 宿主未登记该能力、或拒绝执行时**抛 `HostCallError`** —— 不返回 `undefined`：
   * 那会让调用方（DPAPI 加解密 / 打开外链）把"没做"当成"做完了"，
   * 正是本任务明令禁止的伪造成功。
   */
  callHost(capability: string, payload: unknown, timeoutMs?: number): Promise<unknown>;
  readonly closed: boolean;
}

export interface CreateLinkOptions {
  /** 宿主能力调用默认超时（毫秒）。宿主被独占时可短些，DPAPI 很快不占时间。 */
  callTimeoutMs?: number;
  /** 事件/日志写出失败时的回调（默认忽略：对端已死时再报错没有意义） */
  onWriteError?(error: unknown): void;
}

export const DEFAULT_HOST_CALL_TIMEOUT_MS = 30_000;

export function createLink(transport: SidecarTransport, options: CreateLinkOptions = {}) {
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  const closeListeners = new Set<() => void>();
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_HOST_CALL_TIMEOUT_MS;
  let closed = false;
  let seq = 0;

  const settleAll = (error: Error): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    settleAll(new HostCallError('CANCELLED', '宿主连接已关闭'));
    for (const listener of closeListeners) {
      try {
        listener();
      } catch {
        // 单个监听器抛错不影响关闭流程
      }
    }
  };

  const writeRaw = (frame: SidecarToHostFrame): void => {
    if (closed) return;
    try {
      void transport.write(encodeFrame(frame));
    } catch (error) {
      options.onWriteError?.(error);
      markClosed();
    }
  };

  const link: SidecarLink = {
    send: writeRaw,
    emitEvent(op, payload) {
      writeRaw({ t: 'evt', op, payload });
    },
    log(level, message) {
      writeRaw({ t: 'evt', op: SIDECAR_EVENTS.log, payload: { level, message } });
    },
    callHost(capability, payload, timeoutMs = callTimeoutMs) {
      if (closed) {
        return Promise.reject(new HostCallError('CANCELLED', '宿主连接已关闭'));
      }
      const id = `host-${(seq += 1).toString(36)}`;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new HostCallError(
              'TIMEOUT',
              `宿主能力调用超时（${capability}，${timeoutMs}ms 无应答）`,
            ),
          );
        }, timeoutMs);
        // 让定时器不阻止进程退出：侧车退出不应被未决调用吊住
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        writeRaw({ t: 'host', id, capability, payload });
      });
    },
    get closed() {
      return closed;
    },
  };

  /** 消费入站帧；返回的 Promise 在流结束时兑现 */
  const run = async (handlers: InboundHandlers): Promise<void> => {
    try {
      for await (const line of transport.lines()) {
        if (closed) break;
        const frame = decodeFrame(line);
        if (frame === null) continue;
        switch (frame.t) {
          case 'welcome':
            handlers.onWelcome(frame);
            break;
          case 'req':
            handlers.onRequest(frame);
            break;
          case 'hostres':
            resolveHostResult(frame);
            break;
          default:
            // 侧车不认识的入站帧类型：忽略而不是崩掉（新宿主 + 旧侧车的正常组合）
            break;
        }
      }
    } catch (error) {
      options.onWriteError?.(error);
    } finally {
      markClosed();
      handlers.onEnd();
    }
  };

  const resolveHostResult = (frame: HostResultFrame): void => {
    const entry = pending.get(frame.id);
    if (entry === undefined) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.ok) {
      entry.resolve(frame.result);
      return;
    }
    entry.reject(
      new HostCallError(frame.error?.code ?? 'UNKNOWN', frame.error?.message ?? '宿主能力调用失败'),
    );
  };

  return { link, run, onClose: (listener: () => void) => closeListeners.add(listener) };
}

/** 宿主能力名的集中出口（避免各处写字符串字面量时拼错） */
export { HOST_CAPABILITIES, SIDECAR_EVENTS };
