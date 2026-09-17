/**
 * Zustand 持久化中间件（本地优先）。
 *
 * 与官方 persist 的区别：
 * - 存储层可插拔（外壳文件 / localStorage），默认走异步 StateStorage
 * - 落盘前可选脱敏与裁剪（partialize）
 * - 支持版本号与迁移，旧状态不会把应用打挂
 */

export interface StateStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export interface PersistOptions<T> {
  key: string;
  storage: StateStorage;
  version?: number;
  /** 只持久化部分状态（如只存 ui 布局与设置） */
  partialize?: (state: T) => Partial<T>;
  /** 版本迁移；返回 null 表示放弃旧状态 */
  migrate?: (persisted: unknown, version: number) => Partial<T> | null;
  /** 合并策略：默认浅合并 */
  merge?: (persisted: unknown, current: T) => T;
}

export interface PersistedEnvelope {
  version: number;
  state: unknown;
}

/** 包装一个 store 的 setState，使其变更后自动落盘 */
export function createPersistHandler<T>(
  options: PersistOptions<T>,
): {
  hydrate: () => Promise<Partial<T> | null>;
  persist: (state: T) => Promise<void>;
  clear: () => Promise<void>;
} {
  const version = options.version ?? 1;

  const read = async (): Promise<Partial<T> | null> => {
    const raw = await options.storage.getItem(options.key);
    if (!raw) return null;
    try {
      const envelope = JSON.parse(raw) as PersistedEnvelope;
      const envelopeVersion = typeof envelope.version === 'number' ? envelope.version : 0;
      if (options.migrate) {
        return options.migrate(envelope.state, envelopeVersion);
      }
      if (envelopeVersion !== version) return null;
      return envelope.state as Partial<T>;
    } catch {
      // 损坏的持久化数据不应导致启动失败
      return null;
    }
  };

  return {
    hydrate: read,
    persist: async (state) => {
      const slice = options.partialize ? options.partialize(state) : state;
      const envelope: PersistedEnvelope = { version, state: slice };
      await options.storage.setItem(options.key, JSON.stringify(envelope));
    },
    clear: async () => {
      await options.storage.removeItem(options.key);
    },
  };
}

/** 内存存储实现：测试与无外壳环境使用 */
export function memoryStorage(initial: Record<string, string> = {}): StateStorage & {
  dump: () => Record<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

/** 默认合并：浅合并，持久化状态覆盖当前同名键 */
export function shallowMerge<T>(persisted: unknown, current: T): T {
  if (persisted === null || typeof persisted !== 'object') return current;
  return { ...current, ...(persisted as Partial<T>) } as T;
}
