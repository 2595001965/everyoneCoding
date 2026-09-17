/**
 * useLayerDnd：图层树拖拽（调整顺序 + 改父子关系）。
 *
 * 设计要点：
 * - 纯函数 `resolveDrop(dsl, draggedId, overId)` 负责「拖到谁身上 => 目标父节点 + 插入下标」，
 *   并做**循环检测**（禁止拖入自身子树），便于单测；
 * - 落入容器 => 作为其子节点追加；落入叶子/非容器 => 作为其兄弟插到其后；
 * - 真正写库走 `editorStore.moveElement`，一次拖拽 = 一次 `apply` = 一步撤销栈；
 * - 拖拽高亮目标容器：父级负责把 `dragState.overId` 对应行加上 `ec-layer-row--drop-target`。
 *
 * 拖拽事件挂在图层树容器上，行内 span（`LayerNode`）设了 `draggable`，事件冒泡到容器后
 * 通过 `closest('[role=treeitem]')` 解析出元素 id。
 */
import * as React from 'react';

import type { PageDsl } from '../dsl/types';
import { CONTAINER_TYPES } from '../dsl/types';
import { locateById } from '../dsl/traverse';
import { draftIsDescendant } from '../store/draft-tree';
import { useDesignerStore } from '../store/designer-context';

export interface DropResolution {
  /** 目标父节点 id（根页面容器或某个容器元素） */
  targetParentId: string;
  /** 插入下标；省略表示追加到末尾 */
  index?: number;
}

/** 从拖拽事件里取行对应的元素 id（ec-tree-<id>） */
export function rowIdFromEvent(e: React.DragEvent | React.MouseEvent): string | null {
  const target = e.target as HTMLElement | null;
  const row = target?.closest?.('[role="treeitem"]') as HTMLElement | null;
  if (!row) return null;
  const raw = row.id;
  if (!raw.startsWith('ec-tree-')) return null;
  return raw.slice('ec-tree-'.length);
}

/**
 * 计算拖放结果。返回 null 表示非法（自身 / 自身子树 / 找不到目标）。
 */
export function resolveDrop(dsl: PageDsl, draggedId: string, overId: string): DropResolution | null {
  if (draggedId === overId) return null;
  const root = dsl.tree;
  // 禁止拖入自身子树（含自身）—— 循环检测
  if (draftIsDescendant(root, draggedId, overId)) return null;

  const overLoc = locateById(root, overId);
  if (overLoc === null) return null;
  const overNode = overLoc.node;

  const isContainer = (overNode.children?.length ?? 0) > 0 || CONTAINER_TYPES.includes(overNode.type);
  if (isContainer) {
    // 落入容器：作为其子节点追加到末尾
    return { targetParentId: overId };
  }
  // 落入普通元素：作为兄弟插到其后
  const parentId = overLoc.parent?.id ?? root.id;
  return { targetParentId: parentId, index: overLoc.indexInParent + 1 };
}

export interface LayerDndState {
  draggedId: string | null;
  overId: string | null;
}

export interface LayerDnd {
  dragState: LayerDndState;
  handlers: {
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
}

export function useLayerDnd(): LayerDnd {
  const store = useDesignerStore();
  const [dragState, setDragState] = React.useState<LayerDndState>({ draggedId: null, overId: null });

  const onDragStart = React.useCallback(
    (e: React.DragEvent) => {
      const id = rowIdFromEvent(e);
      if (!id) return;
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
      setDragState({ draggedId: id, overId: null });
    },
    [],
  );

  const onDragOver = React.useCallback((e: React.DragEvent) => {
    const id = rowIdFromEvent(e);
    if (!id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragState((prev) => (prev.overId === id ? prev : { ...prev, overId: id }));
  }, []);

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const overId = rowIdFromEvent(e);
      const draggedId = e.dataTransfer.getData('text/plain') || dragState.draggedId;
      setDragState({ draggedId: null, overId: null });
      if (!overId || !draggedId) return;
      const resolution = resolveDrop(store.getState().dsl, draggedId, overId);
      if (resolution) {
        store.getState().moveElement(draggedId, resolution.targetParentId, resolution.index);
      }
    },
    [dragState.draggedId, store],
  );

  const onDragEnd = React.useCallback(() => setDragState({ draggedId: null, overId: null }), []);

  return { dragState, handlers: { onDragStart, onDragOver, onDrop, onDragEnd } };
}
