/**
 * 运行时状态容器（T3-08）。
 *
 * 与文档状态（PageDsl.state）**完全分离**：文档里的状态变量只是「声明」，
 * 这里是预览 / 运行时真正持有的可变状态。预览模式下驱动真实交互（T6-05 接入），
 * 本次仅做实现与单测。
 *
 * 读写统一走 `shared/expression` 的 `readPath` / `writePath`，因此支持 `user.list[0].name`
 * 这类对象 / 数组路径。`set` 之后会通知全部订阅者。
 */

import { parsePath, readPath, writePath, type PathSegment } from '../shared/expression';

/** 订阅回调：收到最新快照 */
export type StateListener = (snapshot: Record<string, unknown>) => void;
/** 取消订阅函数 */
export type Unsubscribe = () => void;

/** 深拷贝初始值，避免外部对象被运行时污染 */
function cloneValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = cloneValue(val);
  }
  return out;
}

/**
 * 运行时状态容器。
 *
 * 示例：
 * ```ts
 * const store = new StateStore({ user: { list: [{ name: 'a' }] } });
 * store.get('user.list[0].name'); // 'a'
 * store.set('user.list[0].name', 'b');
 * store.subscribe(snap => console.log(snap));
 * ```
 */
export class StateStore {
  private data: Record<string, unknown>;
  private readonly listeners = new Set<StateListener>();

  constructor(initial?: Record<string, unknown>) {
    this.data = initial ? (cloneValue(initial) as Record<string, unknown>) : {};
  }

  /** 读取路径（支持字符串表达式或 PathSegment 数组） */
  get(path: string | readonly PathSegment[]): unknown {
    return readPath(this.data, path);
  }

  /**
   * 按路径写入值。
   * - 单段路径：直接写根字段；
   * - 多段路径：优先 `writePath`；若中间层缺失则自动补全容器后写入。
   * 写入后通知订阅者。
   */
  set(path: string | readonly PathSegment[], value: unknown): void {
    const segments = typeof path === 'string' ? parsePath(path) : path;
    if (segments === null || segments.length === 0) return;
    if (segments.length === 1) {
      this.data[segments[0] as string] = cloneValue(value);
    } else if (!writePath(this.data, segments, cloneValue(value))) {
      this.writeDeep(segments, value);
    }
    this.emit();
  }

  /** 浅合并顶层字段（partial 中的键覆盖，不删除其它键），随后通知订阅者 */
  patch(partial: Record<string, unknown>): void {
    for (const [key, val] of Object.entries(partial)) {
      this.data[key] = cloneValue(val);
    }
    this.emit();
  }

  /** 订阅状态变更，返回取消订阅函数 */
  subscribe(listener: StateListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 重置为初始值（缺省清空），随后通知订阅者 */
  reset(initial?: Record<string, unknown>): void {
    this.data = initial ? (cloneValue(initial) as Record<string, unknown>) : {};
    this.emit();
  }

  /** 返回当前状态快照（浅拷贝，调用方拿到的是独立引用） */
  snapshot(): Record<string, unknown> {
    return { ...this.data };
  }

  /** 中间层缺失时递归补全容器后写入 */
  private writeDeep(segments: readonly PathSegment[], value: unknown): void {
    // 同一循环里既可能遇到对象容器也可能遇到数组容器，因此用联合类型而非 any
    let current: Record<string, unknown> | unknown[] = this.data;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as PathSegment;
      const nextSegment = segments[index + 1] as PathSegment;
      const isArrayNext = typeof nextSegment === 'number';
      const existing = Array.isArray(current)
        ? current[segment as number]
        : (current as Record<string, unknown>)[segment as string];
      let child = existing;
      if (child === undefined || child === null || typeof child !== 'object') {
        child = isArrayNext ? [] : {};
        if (Array.isArray(current)) current[segment as number] = child;
        else (current as Record<string, unknown>)[segment as string] = child;
      }
      current = child as Record<string, unknown> | unknown[];
    }
    const last = segments[segments.length - 1] as PathSegment;
    if (Array.isArray(current)) current[last as number] = cloneValue(value);
    else (current as Record<string, unknown>)[last as string] = cloneValue(value);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }
}
