/**
 * 拖拽总线（T3-03 要点 1）。
 *
 * 用 DndProvider 包住 dnd-kit 的 `DndContext`，向上暴露 `useDnd()`：
 * - `commitDrag(data, resolution)`：在拖拽结束时**唯一一次**提交到 store
 *   （insertElement / moveElement / removeElements 各自只产生一步 undo）
 * - `cancelDrag()`：Esc 取消，不提交，结构不变
 * - `resolution` / `setResolution`：拖拽期间实时解析结果，供插入指示线消费
 *
 * 拖拽期间屏蔽 click / dblclick（由 dnd-kit sensor 的激活距离保证，点击不触发拖拽）；
 * 只有拖拽结束才提交，保证「一次拖拽 = 一步 undo」。
 */
import * as React from 'react';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  pointerWithin,
} from '@dnd-kit/core';
import { useDesignerStore } from '../store/designer-context';
import { isDescendant } from '../dsl/traverse';
import { CONTAINER_TYPES, type ElementNode } from '../dsl/types';
import { computeInsertion, type CollisionTarget, type DragResolution } from './collision';

/** 拖拽载荷：来自组件面板（新增）或画布内（移动） */
export type DragData =
  | { source: 'panel'; element: ElementNode }
  | { source: 'canvas'; id: string };

interface DndContextValue {
  /** 拖拽结束提交（一步 undo） */
  commitDrag: (data: DragData, resolution: DragResolution) => boolean;
  /** Esc 取消：不提交 */
  cancelDrag: () => void;
  /** 当前解析结果（供插入指示线） */
  resolution: DragResolution | null;
  setResolution: (r: DragResolution | null) => void;
  /** 容器是否接受子节点（缺省依据 CONTAINER_TYPES） */
  acceptsChildren: (type: string) => boolean;
}

const Ctx = React.createContext<DndContextValue | null>(null);

/** 取拖拽总线上下文 */
export function useDnd(): DndContextValue {
  const value = React.useContext(Ctx);
  if (!value) throw new Error('useDnd 必须在 <DndProvider> 内使用');
  return value;
}

export interface DndProviderProps {
  children: React.ReactNode;
  /** 容器类型判定（缺省 CONTAINER_TYPES） */
  acceptsChildren?: (type: string) => boolean;
  /** 画布表面 DOM（用于删除判定：指针离开即删除） */
  canvasRectRef?: React.RefObject<HTMLElement | null>;
}

/**
 * 拖拽总线：包裹 dnd-kit DndContext，并暴露 useDnd。
 * 需在 DesignerProvider 内使用（以便取到 store）。
 */
export function DndProvider({ children, acceptsChildren, canvasRectRef }: DndProviderProps): React.ReactElement {
  const store = useDesignerStore();
  const [resolution, setResolutionState] = React.useState<DragResolution | null>(null);
  const accept = acceptsChildren ?? ((type: string) => CONTAINER_TYPES.includes(type));

  const lastPointer = React.useRef<{ x: number; y: number } | null>(null);
  const draggedId = React.useRef<string | null>(null);
  const pending = React.useRef<DragResolution | null>(null);

  const setResolution = React.useCallback((r: DragResolution | null) => {
    pending.current = r;
    setResolutionState(r);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const root = React.useCallback(() => store.getState().dsl.tree, [store]);

  const resolveFromOver = React.useCallback(
    (over: DragOverEvent['over'], pointer: { x: number; y: number } | null): DragResolution | null => {
      if (!over) {
        // 指针离开所有 droppable：若同时离开画布表面 → 删除
        if (pointer && canvasRectRef?.current) {
          const r = canvasRectRef.current.getBoundingClientRect();
          const inside = pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
          if (!inside) return { kind: 'delete' };
        }
        return null;
      }
      const target = over.data.current?.target as CollisionTarget | undefined;
      if (!target) return null;
      const rect = over.rect
        ? { x: over.rect.left, y: over.rect.top, width: over.rect.width, height: over.rect.height }
        : target.rect;
      const id = draggedId.current ?? undefined;
      return computeInsertion({
        pointer: pointer ?? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        target: { ...target, rect },
        isDescendant: (a, d) => isDescendant(root(), a, d),
        draggedId: id,
        canvasRect: canvasRectRef?.current
          ? (() => {
              const r = canvasRectRef.current!.getBoundingClientRect();
              return { x: r.left, y: r.top, width: r.width, height: r.height };
            })()
          : undefined,
      });
    },
    [canvasRectRef, root],
  );

  const commitDrag = React.useCallback(
    (data: DragData, res: DragResolution): boolean => {
      if (res.kind === 'none') return false;
      if (res.kind === 'delete') {
        if (data.source !== 'canvas') return false;
        return store.getState().removeElements([data.id]) > 0;
      }
      // insert
      if (data.source === 'panel') {
        return store
          .getState()
          .insertElement(res.parentId, data.element, { ...(res.index !== undefined ? { index: res.index } : {}), select: true });
      }
      return store.getState().moveElement(data.id, res.parentId, res.index);
    },
    [store],
  );

  const cancelDrag = React.useCallback(() => {
    pending.current = null;
    setResolutionState(null);
  }, []);

  const handlePointerTrack = React.useCallback((e: PointerEvent) => {
    lastPointer.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleDragStart = React.useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as DragData | undefined;
      draggedId.current = data?.source === 'canvas' ? data.id : null;
      window.addEventListener('pointermove', handlePointerTrack);
    },
    [handlePointerTrack],
  );

  const handleDragOver = React.useCallback(
    (event: DragOverEvent) => {
      const res = resolveFromOver(event.over, lastPointer.current);
      setResolution(res);
    },
    [resolveFromOver, setResolution],
  );

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      window.removeEventListener('pointermove', handlePointerTrack);
      const data = event.active.data.current as DragData | undefined;
      const res = pending.current;
      draggedId.current = null;
      setResolutionState(null);
      pending.current = null;
      if (data && res) commitDrag(data, res);
    },
    [handlePointerTrack, commitDrag],
  );

  const handleDragCancel = React.useCallback(() => {
    window.removeEventListener('pointermove', handlePointerTrack);
    draggedId.current = null;
    setResolutionState(null);
    pending.current = null;
  }, [handlePointerTrack]);

  const collisionDetection: CollisionDetection = pointerWithin;

  const value: DndContextValue = {
    commitDrag,
    cancelDrag,
    resolution,
    setResolution,
    acceptsChildren: accept,
  };

  return (
    <Ctx.Provider value={value}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {children}
      </DndContext>
    </Ctx.Provider>
  );
}
