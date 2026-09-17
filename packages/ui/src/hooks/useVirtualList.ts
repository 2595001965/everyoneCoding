import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * 固定行高虚拟列表：1 万条数据只渲染可视窗口内的节点。
 * Tree / Table / List / CommandPalette 共用。
 *
 * 用法：组件把 `ref` 绑到滚动容器，并把 `getScrollElement` 指向同一元素；
 * 返回的 `items` 是当前窗口内的条目（`start` 为绝对偏移，用于绝对定位）。
 */

export interface VirtualListOptions {
  /** 条目总数 */
  count: number;
  /** 固定行高（px） */
  itemHeight: number;
  /** 视口外额外渲染的条目数（上下各 overscan） */
  overscan?: number | undefined;
  /** 滚动容器访问器（组件内 ref 的 getter） */
  getScrollElement?: (() => HTMLElement | null) | undefined;
}

export interface VirtualItem {
  index: number;
  /** 距列表顶部的绝对偏移（px），用于绝对定位 */
  start: number;
}

export interface VirtualListResult {
  /** 窗口内条目 */
  items: VirtualItem[];
  /** 撑高元素总高度（px） */
  totalHeight: number;
  scrollToIndex(index: number): void;
}

export function useVirtualList(options: VirtualListOptions): VirtualListResult {
  const { count, itemHeight, overscan = 6, getScrollElement } = options;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  /**
   * 访问器放 ref，**不进 effect 依赖**。
   *
   * 调用方普遍写 `getScrollElement={() => scrollRef.current}`（每次渲染新建箭头函数），
   * 若把它放进依赖数组，effect 会在每次渲染后重跑并 `setState`——React 会报
   * `Maximum update depth exceeded`（实测：工作台 1000 项目列表视图）。ref 只在事件/effect
   * 内部读取，没有这个不稳定的身份问题。
   */
  const getterRef = useRef(getScrollElement);
  getterRef.current = getScrollElement;

  const recompute = useCallback(() => {
    const element = getterRef.current?.() ?? null;
    if (element === null) return;
    setScrollTop(element.scrollTop);
    setViewportHeight(element.clientHeight || 600);
  }, []);

  useEffect(() => {
    const element = getterRef.current?.() ?? null;
    if (element === null) return;
    recompute();
    const onScroll = () => recompute();
    element.addEventListener('scroll', onScroll, { passive: true });
    // 容器尺寸变化（窗口缩放 / 分栏拖动）后视口高度会变，需要重算窗口条目数。
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => recompute());
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
    // 只依赖"结构"参数：元素身份在挂载后不变，访问器经 ref 读取。
  }, [count, itemHeight, recompute]);

  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(viewportHeight / itemHeight) + overscan * 2;
  const end = Math.min(count, start + visibleCount);

  const items = useMemo<VirtualItem[]>(() => {
    const out: VirtualItem[] = [];
    for (let index = start; index < end; index += 1) {
      out.push({ index, start: index * itemHeight });
    }
    return out;
  }, [start, end, itemHeight]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const element = getterRef.current?.() ?? null;
      if (element === null) return;
      element.scrollTop = Math.min(Math.max(0, index), Math.max(0, count - 1)) * itemHeight;
    },
    [count, itemHeight],
  );

  return {
    items,
    totalHeight: count * itemHeight,
    scrollToIndex,
  };
}
