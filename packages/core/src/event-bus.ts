/**
 * 类型化事件总线。
 *
 * - `EventMap` 声明式：`on('project:opened', (payload: ProjectOpened) => ...)`
 * - 支持 once / off / 通配符（`*` 与 `前缀:*`）
 * - 异步监听串行执行：前一个监听 resolve 后才执行下一个，异常互不影响（汇总抛出）
 */

export type Unsubscribe = () => void;

export interface EventMapShape {
  [event: string]: unknown;
}

export type EventHandler<T> = (payload: T) => void | Promise<void>;

/**
 * 事件总线。
 * 泛型约束用 `M extends object` 而非带索引签名的接口，
 * 这样普通的 `interface AppEventMap { ... }` 也能直接作为类型参数使用。
 */

interface Listener {
  /** 订阅模式：精确事件名、`前缀:*` 或 `*` */
  pattern: string;
  handler: (payload: unknown, event: string) => void | Promise<void>;
  once: boolean;
}

function matches(pattern: string, event: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) return event.startsWith(pattern.slice(0, -1));
  return pattern === event;
}

export class EventBus<M extends object = EventMapShape> {
  private readonly listeners = new Set<Listener>();

  on<K extends keyof M & string>(event: K, handler: EventHandler<M[K]>): Unsubscribe {
    const listener: Listener = {
      pattern: event,
      handler: handler as (payload: unknown, event: string) => void | Promise<void>,
      once: false,
    };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  once<K extends keyof M & string>(event: K, handler: EventHandler<M[K]>): Unsubscribe {
    const listener: Listener = {
      pattern: event,
      handler: handler as (payload: unknown, event: string) => void | Promise<void>,
      once: true,
    };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  off<K extends keyof M & string>(event: K, handler: EventHandler<M[K]>): void {
    for (const listener of [...this.listeners]) {
      if (
        listener.pattern === event &&
        listener.handler === (handler as unknown as Listener['handler'])
      ) {
        this.listeners.delete(listener);
      }
    }
  }

  /** 通配符订阅：`*` 监听全部，`domain:*` 监听某域 */
  onAny(
    pattern: string,
    handler: (event: string, payload: unknown) => void | Promise<void>,
  ): Unsubscribe {
    const listener: Listener = {
      pattern,
      handler: (payload, event) => handler(event, payload),
      once: false,
    };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 广播事件。异步监听串行 await；某个监听抛错不中断其余监听（错误汇总后抛出）。
   */
  async emit<K extends keyof M & string>(event: K, payload: M[K]): Promise<void> {
    const matched = [...this.listeners].filter((listener) => matches(listener.pattern, event));
    const errors: unknown[] = [];
    for (const listener of matched) {
      if (listener.once) this.listeners.delete(listener);
      try {
        await listener.handler(payload, event);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `事件 ${event} 的监听中出现 ${errors.length} 个异常`);
    }
  }

  /** 同步广播（不等待异步监听返回） */
  emitSync<K extends keyof M & string>(event: K, payload: M[K]): void {
    for (const listener of [...this.listeners]) {
      if (!matches(listener.pattern, event)) continue;
      if (listener.once) this.listeners.delete(listener);
      void listener.handler(payload, event);
    }
  }

  listenerCount(pattern?: string): number {
    if (pattern === undefined) return this.listeners.size;
    return [...this.listeners].filter((listener) => matches(listener.pattern, pattern)).length;
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** 应用级默认事件总线；各模块通过扩展 AppEventMap 增加事件 */
export interface AppEventMap extends EventMapShape {
  'app:ready': { version: string };
  'app:error': { message: string };
}

export const appEventBus = new EventBus<AppEventMap>();
