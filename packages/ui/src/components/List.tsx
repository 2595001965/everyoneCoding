/**
 * List：虚拟化列表。基于 useVirtualList，仅渲染可视窗口内的少量节点。
 * 1 万条数据下 DOM 节点数远小于数据量（≈ 视口高度/行高 + overscan）。
 */
import * as React from 'react';
import { cx } from '../cx';
import { useVirtualList } from '../hooks/useVirtualList';

export interface ListProps<T> {
  items: T[];
  itemHeight: number;
  height: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  overscan?: number;
  getItemKey?: (item: T, index: number) => React.Key;
  className?: string;
  'aria-label'?: string;
}

export function List<T>(props: ListProps<T>): React.ReactElement {
  const {
    items,
    itemHeight,
    height,
    renderItem,
    overscan,
    getItemKey,
    className,
    'aria-label': ariaLabel,
  } = props;
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const { items: virtual, totalHeight } = useVirtualList({
    count: items.length,
    itemHeight,
    overscan,
    getScrollElement: () => scrollRef.current,
  });

  return (
    <div
      ref={scrollRef}
      className={cx('ec-list', className)}
      style={{ height, overflow: 'auto' }}
      role="list"
      aria-label={ariaLabel}
    >
      <div className="ec-list__sizer" style={{ height: totalHeight, position: 'relative' }}>
        {virtual.map((vi) => {
          const item = items[vi.index];
          const key = getItemKey ? getItemKey(item as T, vi.index) : vi.index;
          return (
            <div
              key={key}
              role="listitem"
              className="ec-list__row"
              style={{ position: 'absolute', top: vi.start, left: 0, right: 0, height: itemHeight }}
            >
              {renderItem(item as T, vi.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
