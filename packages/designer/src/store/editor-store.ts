import { UndoManager } from '@ec/core';
import { createStore, type StoreApi } from 'zustand';

import { createElement, createEmptyPage, createRandomIdFactory } from '../dsl/factory';
import { cloneSubtree, findById, locateById } from '../dsl/traverse';
import type {
  CodeAnchor,
  ElementNode,
  EventDef,
  PageDsl,
  PageStateVar,
  Viewport,
} from '../dsl/types';
import { draftInsertChild, draftMoveNode, draftRemoveNode, draftUpdateNode } from './draft-tree';

/**
 * 设计器编辑器内核（T3-01 之后冻结的共享状态层）。
 *
 * 三向联动（画布 / 图层树 / 属性面板）共享**同一份状态**，避免各自维护选中集：
 * - `dsl`：文档（进撤销栈，patch 级）
 * - `selectedIds` / `hoveredId` / `editingElementId`：交互态（**不进**撤销栈）
 *
 * 撤销能力直接复用 `@ec/core` 的 `UndoManager`（T0-09），因此：
 * - 一次拖拽 = 一次 `apply()` = 一步 undo（T3-03 验收）
 * - 文本类连续输入通过 `coalesceKey` 合并为一步（T3-05 验收）
 */

export interface EditorUndoInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  undoDepth: number;
  redoDepth: number;
}

export type SelectionMode = 'replace' | 'add' | 'toggle';

/** 元素元信息可控字段（不含 props / style / bindings / children） */
export interface ElementMetaPatch {
  name?: string;
  locked?: boolean;
  hidden?: boolean;
  featureRef?: string | null;
  noteId?: string | null;
  masterRef?: ElementNode['masterRef'];
  /** 条件渲染（传 null 清除） */
  condition?: ElementNode['condition'];
  /** 权限规则（传 null 清除） */
  permission?: ElementNode['permission'];
}

export interface ApplyOptions {
  /** 合并键：同键且处于合并窗口内（默认 600ms）的连续变更合并为一步 undo */
  coalesceKey?: string;
}

export interface EditorStoreState {
  /** 当前页面文档 */
  dsl: PageDsl;
  /** 选中元素 id（可多选） */
  selectedIds: string[];
  /** hover 高亮元素 id */
  hoveredId: string | null;
  /** 正在双击进入编辑的元素 id */
  editingElementId: string | null;
  /** 当前页面文件路径（未落盘为 null） */
  filePath: string | null;
  /** 存在未保存变更 */
  dirty: boolean;
  undoState: EditorUndoInfo;
}

export interface EditorStoreActions {
  /** 唯一的文档变更入口：所有写操作都必须走这里才能进撤销栈 */
  apply(label: string, recipe: (draft: PageDsl) => void, options?: ApplyOptions): void;
  undo(): void;
  redo(): void;
  loadDsl(dsl: PageDsl, options?: { filePath?: string | null; resetHistory?: boolean }): void;
  markSaved(): void;

  select(ids: readonly string[], options?: { mode?: SelectionMode }): void;
  clearSelection(): void;
  setHovered(id: string | null): void;
  setEditing(id: string | null): void;

  insertElement(
    parentId: string,
    element: ElementNode,
    options?: { index?: number; label?: string; select?: boolean },
  ): boolean;
  moveElement(id: string, targetParentId: string, index?: number): boolean;
  removeElements(ids: readonly string[], options?: { label?: string }): number;
  duplicateElement(id: string, options?: { idFactory?: () => string }): string | null;

  updateProps(id: string, patch: Record<string, unknown>, options?: ApplyOptions): void;
  setProps(id: string, props: Record<string, unknown>, options?: ApplyOptions): void;
  updateStyle(id: string, patch: Record<string, unknown>, options?: ApplyOptions): void;
  setStyle(id: string, style: Record<string, unknown>, options?: ApplyOptions): void;
  /** 整体替换绑定；值为 null 的键表示删除该绑定 */
  setBindings(id: string, bindings: Record<string, string | null>, options?: ApplyOptions): void;
  updateMeta(id: string, patch: ElementMetaPatch, options?: ApplyOptions): void;
  /** 断点差异属性（T3-11 响应式） */
  setResponsive(
    id: string,
    breakpoint: string,
    style: Record<string, unknown> | null,
    options?: ApplyOptions,
  ): void;

  updatePageMeta(
    patch: Partial<Pick<PageDsl, 'name' | 'route' | 'platform' | 'featureId'>> & {
      viewport?: Viewport;
    },
    options?: ApplyOptions,
  ): void;
  setPageStateVars(vars: readonly PageStateVar[], options?: ApplyOptions): void;
  setPageEvents(events: readonly EventDef[], options?: ApplyOptions): void;
  setApiDeps(deps: readonly string[], options?: ApplyOptions): void;
  setAnchors(anchors: Record<string, CodeAnchor>, options?: ApplyOptions): void;
}

export type EditorStore = EditorStoreState & EditorStoreActions;

/** 元素层级索引（供图层树 / 画布命中测试复用） */
export function elementExists(dsl: PageDsl, id: string): boolean {
  return findById(dsl.tree, id) !== null;
}

function pruneSelection(dsl: PageDsl, ids: readonly string[]): string[] {
  return ids.filter((id) => elementExists(dsl, id));
}

export interface CreateEditorStoreOptions {
  dsl?: PageDsl;
  filePath?: string | null;
  /** 撤销栈深度上限 */
  undoLimit?: number;
  /** 同类操作合并窗口（毫秒），0 关闭合并 */
  coalesceWindowMs?: number;
}

/**
 * 创建独立的编辑器 store。
 * 组件测试应显式创建并注入（`EditorStoreProvider`），避免用例之间互相污染。
 */
export function createEditorStore(options: CreateEditorStoreOptions = {}): StoreApi<EditorStore> {
  const initialDsl =
    options.dsl ??
    createEmptyPage({
      id: 'untitled',
      projectId: 'P0',
      name: '未命名页面',
      platform: 'web',
      route: '/untitled',
    });

  return createStore<EditorStore>((set, get) => {
    const manager = new UndoManager<{ dsl: PageDsl }>({
      getState: () => ({ dsl: get().dsl }),
      setState: (state) => set({ dsl: state.dsl }),
      limit: options.undoLimit ?? 200,
      coalesceWindowMs: options.coalesceWindowMs ?? 600,
    });

    const readUndo = (): EditorUndoInfo => ({
      canUndo: manager.canUndo,
      canRedo: manager.canRedo,
      undoLabel: manager.undoLabel,
      redoLabel: manager.redoLabel,
      undoDepth: manager.undoDepth,
      redoDepth: manager.redoDepth,
    });

    const syncUndo = (): void => set({ undoState: readUndo() });

    /** 统一的文档写入：进撤销栈 + 标记脏 + 同步撤销信息 + 清理失效选中 */
    const write = (
      label: string,
      recipe: (draft: PageDsl) => void,
      applyOptions?: ApplyOptions,
    ): void => {
      const before = get().dsl;
      // UndoManager 的 draft 是状态对象 `{ dsl }`，此处把页面草稿透传给业务回调
      const next = manager.apply(
        label,
        (draft) => {
          recipe(draft.dsl);
        },
        applyOptions ?? {},
      );
      if (next.dsl === before) return;
      const selection = pruneSelection(next.dsl, get().selectedIds);
      const hoveredId = get().hoveredId;
      set({
        dirty: true,
        selectedIds: selection,
        hoveredId: hoveredId !== null && elementExists(next.dsl, hoveredId) ? hoveredId : null,
        editingElementId:
          get().editingElementId !== null &&
          elementExists(next.dsl, get().editingElementId as string)
            ? get().editingElementId
            : null,
      });
      syncUndo();
    };

    return {
      dsl: initialDsl,
      selectedIds: [],
      hoveredId: null,
      editingElementId: null,
      filePath: options.filePath ?? null,
      dirty: false,
      undoState: {
        canUndo: false,
        canRedo: false,
        undoLabel: null,
        redoLabel: null,
        undoDepth: 0,
        redoDepth: 0,
      },

      apply: write,

      undo: () => {
        const next = manager.undo();
        if (next === null) return;
        const hovered = get().hoveredId;
        const editing = get().editingElementId;
        set({
          dirty: true,
          selectedIds: pruneSelection(next.dsl, get().selectedIds),
          hoveredId: hovered !== null && elementExists(next.dsl, hovered) ? hovered : null,
          editingElementId: editing !== null && elementExists(next.dsl, editing) ? editing : null,
        });
        syncUndo();
      },

      redo: () => {
        const next = manager.redo();
        if (next === null) return;
        const hovered = get().hoveredId;
        const editing = get().editingElementId;
        set({
          dirty: true,
          selectedIds: pruneSelection(next.dsl, get().selectedIds),
          hoveredId: hovered !== null && elementExists(next.dsl, hovered) ? hovered : null,
          editingElementId: editing !== null && elementExists(next.dsl, editing) ? editing : null,
        });
        syncUndo();
      },

      loadDsl: (dsl, loadOptions) => {
        if (loadOptions?.resetHistory !== false) manager.clear();
        set({
          dsl,
          selectedIds: [],
          hoveredId: null,
          editingElementId: null,
          dirty: false,
          ...(loadOptions && 'filePath' in loadOptions
            ? { filePath: loadOptions.filePath ?? null }
            : {}),
        });
        syncUndo();
      },

      markSaved: () => set({ dirty: false }),

      select: (ids, selectOptions) => {
        const mode = selectOptions?.mode ?? 'replace';
        const current = get().selectedIds;
        let next: string[];
        if (mode === 'add') next = [...new Set([...current, ...ids])];
        else if (mode === 'toggle') {
          const set0 = new Set(current);
          for (const id of ids) {
            if (set0.has(id)) set0.delete(id);
            else set0.add(id);
          }
          next = [...set0];
        } else next = [...new Set(ids)];
        set({ selectedIds: pruneSelection(get().dsl, next) });
      },

      clearSelection: () => set({ selectedIds: [] }),
      setHovered: (id) => set({ hoveredId: id }),
      setEditing: (id) => set({ editingElementId: id }),

      insertElement: (parentId, element, insertOptions) => {
        let inserted = false;
        write(
          insertOptions?.label ?? '插入元素',
          (draft) => {
            inserted = draftInsertChild(draft.tree, parentId, element, insertOptions?.index);
          },
          {},
        );
        if (inserted && insertOptions?.select !== false) set({ selectedIds: [element.id] });
        return inserted;
      },

      moveElement: (id, targetParentId, index) => {
        let moved = false;
        write('移动元素', (draft) => {
          moved = draftMoveNode(draft.tree, id, targetParentId, index);
        });
        // 未真正移动时不希望留下空撤销步，交由 UndoManager 的 patch 为空自动忽略
        return moved;
      },

      removeElements: (ids, removeOptions) => {
        let removedCount = 0;
        write(removeOptions?.label ?? '删除元素', (draft) => {
          for (const id of ids) {
            if (draftRemoveNode(draft.tree, id) !== null) removedCount += 1;
          }
        });
        if (removedCount > 0) {
          set({ selectedIds: pruneSelection(get().dsl, get().selectedIds) });
        }
        return removedCount;
      },

      duplicateElement: (id, duplicateOptions) => {
        const location = locateById(get().dsl.tree, id);
        if (location === null || location.parent === null) return null;
        const idFactory = duplicateOptions?.idFactory ?? createRandomIdFactory('el');
        const clone = cloneSubtree(location.node, idFactory);
        const parentId = location.parent.id;
        const index = location.indexInParent + 1;
        const ok = get().insertElement(parentId, clone, { index, label: '复制元素' });
        return ok ? clone.id : null;
      },

      updateProps: (id, patch, applyOptions) => {
        write(
          '修改属性',
          (draft) => {
            draftUpdateNode(draft.tree, id, (node) => {
              node.props = { ...(node.props ?? {}), ...patch };
            });
          },
          applyOptions,
        );
      },

      setProps: (id, props, applyOptions) => {
        write(
          '修改属性',
          (draft) => {
            draftUpdateNode(draft.tree, id, (node) => {
              node.props = { ...props };
            });
          },
          applyOptions,
        );
      },

      updateStyle: (id, patch, applyOptions) => {
        write(
          '修改样式',
          (draft) => {
            draftUpdateNode(draft.tree, id, (node) => {
              node.style = { ...(node.style ?? {}), ...patch };
            });
          },
          applyOptions,
        );
      },

      setStyle: (id, style, applyOptions) => {
        write(
          '修改样式',
          (draft) => {
            draftUpdateNode(draft.tree, id, (node) => {
              node.style = { ...style };
            });
          },
          applyOptions,
        );
      },

      setBindings: (id, bindings, applyOptions) => {
        write(
          '修改数据绑定',
          (draft) => {
            draftUpdateNode(draft.tree, id, (node) => {
              const next: Record<string, string> = { ...(node.bindings ?? {}) };
              for (const [key, value] of Object.entries(bindings)) {
                if (value === null) delete next[key];
                else next[key] = value;
              }
              if (Object.keys(next).length === 0) delete node.bindings;
              else node.bindings = next;
            });
          },
          applyOptions,
        );
      },

      updateMeta: (id, patch, applyOptions) => {
        write(
          '修改元素信息',
          (draft) => {
            draftUpdateNode(draft.tree, id, (node) => {
              if (patch.name !== undefined) node.name = patch.name;
              if (patch.locked !== undefined) node.locked = patch.locked;
              if (patch.hidden !== undefined) node.hidden = patch.hidden;
              if (patch.featureRef !== undefined) node.featureRef = patch.featureRef;
              if (patch.noteId !== undefined) node.noteId = patch.noteId;
              if (patch.masterRef !== undefined) node.masterRef = patch.masterRef;
              if (patch.condition !== undefined) node.condition = patch.condition;
              if (patch.permission !== undefined) node.permission = patch.permission;
            });
          },
          applyOptions,
        );
      },

      setResponsive: (id, breakpoint, style, applyOptions) => {
        write(
          '修改响应式规则',
          (draft) => {
            draftUpdateNode(draft.tree, id, (node) => {
              const map = { ...(node.responsive ?? {}) };
              if (style === null) delete map[breakpoint];
              else map[breakpoint] = { ...style };
              if (Object.keys(map).length === 0) delete node.responsive;
              else node.responsive = map;
            });
          },
          applyOptions,
        );
      },

      updatePageMeta: (patch, applyOptions) => {
        write(
          '修改页面信息',
          (draft) => {
            if (patch.name !== undefined) draft.name = patch.name;
            if (patch.route !== undefined) draft.route = patch.route;
            if (patch.platform !== undefined) draft.platform = patch.platform;
            if (patch.featureId !== undefined) draft.featureId = patch.featureId;
            if (patch.viewport !== undefined) draft.viewport = { ...patch.viewport };
          },
          applyOptions,
        );
      },

      setPageStateVars: (vars, applyOptions) => {
        write(
          '修改页面状态',
          (draft) => {
            draft.state = vars.map((item) => ({ ...item }));
          },
          applyOptions,
        );
      },

      setPageEvents: (events, applyOptions) => {
        write(
          '修改事件动作流',
          (draft) => {
            draft.events = events.map((event) => ({
              ...event,
              actions: event.actions.map((action) => ({ ...action })),
            }));
          },
          applyOptions,
        );
      },

      setApiDeps: (deps, applyOptions) => {
        write(
          '修改接口依赖',
          (draft) => {
            draft.apiDeps = [...new Set(deps)];
          },
          applyOptions,
        );
      },

      setAnchors: (anchors, applyOptions) => {
        write(
          '修改代码锚点',
          (draft) => {
            draft.anchors = { ...anchors };
          },
          applyOptions,
        );
      },
    };
  });
}

/** 模块单例：应用内默认编辑器实例 */
export const editorStore: StoreApi<EditorStore> = createEditorStore();

/** 重置单例（切换项目 / 测试隔离用） */
export function resetEditorStore(options: CreateEditorStoreOptions = {}): void {
  const fresh = createEditorStore(options);
  editorStore.setState(fresh.getState(), true);
}

/** 便捷读取：当前选中的唯一元素（多选时为 null） */
export function selectedElement(store: StoreApi<EditorStore>): ElementNode | null {
  const { dsl, selectedIds } = store.getState();
  if (selectedIds.length !== 1) return null;
  return findById(dsl.tree, selectedIds[0] as string);
}

/** 便捷读取：元素在父容器中的位置 */
export function elementLocation(
  store: StoreApi<EditorStore>,
  id: string,
): ReturnType<typeof locateById> {
  return locateById(store.getState().dsl.tree, id);
}

/** 便捷构造：默认空元素（供组件面板拖入时使用） */
export function createDefaultElement(type: string, idFactory?: () => string): ElementNode {
  const factory = idFactory ?? createRandomIdFactory('el');
  return createElement({ id: factory(), type });
}
