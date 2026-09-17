import { useEffect, useRef, useState } from 'react';

/**
 * 元素尺寸观察（分栏拖拽 / 高分屏适配共用）。
 * 返回 [ref, size]：ref 为可写 RefObject（可读 ref.current），
 * size 随 ResizeObserver 更新；jsdom 等无 ResizeObserver 的环境安全降级。
 */

export interface ElementSize {
  width: number;
  height: number;
}

export function useResizeObserver<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  ElementSize,
] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    setSize({ width: node.clientWidth, height: node.clientHeight });
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}
