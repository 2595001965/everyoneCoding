import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';

enablePatches();

/**
 * 撤销 / 重做管理器（patch 级）。
 *
 * 基于 Immer 的 `produceWithPatches`：每次变更只记录正向 / 反向补丁，
 * 内存占用远低于整树快照，且天然支持「按 store 域隔离多个 undo 栈」。
 *
 * - `apply(label, recipe)`：在当前状态上执行变更并入栈
 * - 连续同类操作（相同 label 且在合并时间窗内）合并为一步
 * - 栈深可裁剪（默认 100 步）
 */

export interface UndoEntry {
  label: string;
  /**
   * 合并键：同类操作据此合并。缺省等于 label；
   * 显式传入 `coalesceKey` 时可让不同 label 的操作互不干扰地按域合并
   * （例如「修改属性」下按元素 + 字段名分组合并）。
   */
  coalesceKey: string;
  patches: Patch[];
  inverse: Patch[];
  timestamp: number;
}

export interface UndoManagerOptions<T extends object> {
  getState: () => T;
  setState: (state: T) => void;
  /** 栈深上限，超出丢弃最旧的 */
  limit?: number;
  /** 同类操作合并时间窗（毫秒），0 表示不合并 */
  coalesceWindowMs?: number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_COALESCE_MS = 600;

export class UndoManager<T extends object> {
  private readonly undoStack: UndoEntry[] = [];
  private readonly redoStack: UndoEntry[] = [];
  private readonly options: Required<UndoManagerOptions<T>>;

  constructor(options: UndoManagerOptions<T>) {
    this.options = {
      getState: options.getState,
      setState: options.setState,
      limit: options.limit ?? DEFAULT_LIMIT,
      coalesceWindowMs: options.coalesceWindowMs ?? DEFAULT_COALESCE_MS,
    };
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  /** 当前待撤销 / 待重做的标签，便于 UI 展示"撤销：移动元素" */
  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  /**
   * 执行一次可撤销的变更。
   * @param label 操作名（同类操作据此合并）
   * @param recipe Immer 变更函数
   * @param options.coalesceKey 显式指定合并键（缺省用 label）
   */
  apply(label: string, recipe: (draft: T) => void, options: { coalesceKey?: string } = {}): T {
    const current = this.options.getState();
    const [next, patches, inverse] = produceWithPatches(current, (draft: T) => {
      recipe(draft);
    });

    if (patches.length === 0) return current;

    const now = Date.now();
    const key = options.coalesceKey ?? label;
    const last = this.undoStack[this.undoStack.length - 1];
    const canCoalesce =
      last !== undefined &&
      this.options.coalesceWindowMs > 0 &&
      now - last.timestamp <= this.options.coalesceWindowMs &&
      last.coalesceKey === key;

    if (canCoalesce && last) {
      // 合并：追加补丁，反向补丁按相反顺序叠加
      last.patches = [...last.patches, ...patches];
      last.inverse = [...inverse, ...last.inverse];
      last.timestamp = now;
    } else {
      this.undoStack.push({ label, coalesceKey: key, patches, inverse, timestamp: now });
      if (this.undoStack.length > this.options.limit) this.undoStack.shift();
    }

    // 新变更使重做栈失效
    this.redoStack.length = 0;
    this.options.setState(next);
    return next;
  }

  undo(): T | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const current = this.options.getState();
    const next = applyPatches(current, entry.inverse);
    this.redoStack.push(entry);
    this.options.setState(next);
    return next;
  }

  redo(): T | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const current = this.options.getState();
    const next = applyPatches(current, entry.patches);
    this.undoStack.push(entry);
    this.options.setState(next);
    return next;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** 快照当前栈状态，供测试与调试 */
  inspect(): { undo: string[]; redo: string[] } {
    return {
      undo: this.undoStack.map((entry) => entry.label),
      redo: this.redoStack.map((entry) => entry.label),
    };
  }
}

/**
 * 多域撤销栈：设计器、记忆编辑等各自独立，互不干扰。
 */
type AnyUndoManager = UndoManager<object>;

export class UndoManagerRegistry {
  private readonly managers = new Map<string, AnyUndoManager>();

  register<T extends object>(domain: string, manager: UndoManager<T>): void {
    this.managers.set(domain, manager as unknown as AnyUndoManager);
  }

  get<T extends object>(domain: string): UndoManager<T> | undefined {
    return this.managers.get(domain) as unknown as UndoManager<T> | undefined;
  }

  domains(): string[] {
    return [...this.managers.keys()];
  }

  /** 清除指定域（切换项目时调用）；缺省清除全部 */
  clear(domain?: string): void {
    if (domain) {
      this.managers.get(domain)?.clear();
      return;
    }
    for (const manager of this.managers.values()) manager.clear();
  }
}

export const undoRegistry = new UndoManagerRegistry();
