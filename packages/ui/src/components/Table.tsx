/**
 * Table：虚拟化表格。固定行高 + 表头吸顶，基于 useVirtualList 仅渲染可视行。
 * 键盘：↑/↓ 在行间移动（roving 焦点）、Enter 选择、Home/End。
 */
import * as React from 'react';
import { cx } from '../cx';
import { useVirtualList } from '../hooks/useVirtualList';

export interface Column<T = unknown> {
  /** 自定义渲染（可选，缺省走 renderCell） */
  render?: (row: T, index: number) => React.ReactNode;
  key: string;
  title: React.ReactNode;
  width?: number | string;
  align?: 'left' | 'center' | 'right';
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => React.Key;
  rowHeight?: number;
  height: number;
  renderCell?: (row: T, column: Column<T>, index: number) => React.ReactNode;
  onRowSelect?: (key: React.Key, row: T) => void;
  selectedKey?: React.Key;
  overscan?: number;
  className?: string;
  'aria-label'?: string;
}

export function Table<T>(props: TableProps<T>): React.ReactElement {
  const {
    columns,
    rows,
    rowKey,
    rowHeight = 32,
    height,
    renderCell,
    onRowSelect,
    selectedKey,
    overscan,
    className,
    'aria-label': ariaLabel,
  } = props;

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const rowRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  const { items: virtual, totalHeight } = useVirtualList({
    count: rows.length,
    itemHeight: rowHeight,
    overscan,
    getScrollElement: () => scrollRef.current,
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIdx(rows.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[activeIdx];
      if (row) onRowSelect?.(rowKey(row, activeIdx), row);
    }
  };

  React.useEffect(() => {
    const el = rowRefs.current[activeIdx];
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  return (
    <div
      className={cx('ec-table', className)}
      style={{ height, display: 'flex', flexDirection: 'column' }}
    >
      <div className="ec-table__header" role="rowgroup">
        <div className="ec-table__row ec-table__row--head" role="row">
          {columns.map((col) => (
            <div
              key={col.key}
              role="columnheader"
              className="ec-table__cell ec-table__cell--head"
              style={{ width: col.width, textAlign: col.align }}
            >
              {col.title}
            </div>
          ))}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="ec-table__body"
        role="rowgroup"
        tabIndex={0}
        style={{ overflow: 'auto', flex: 1 }}
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
      >
        <div className="ec-table__sizer" style={{ height: totalHeight, position: 'relative' }}>
          {virtual.map((vi) => {
            const row = rows[vi.index];
            if (row === undefined) return null;
            const key = rowKey(row, vi.index);
            const isActive = vi.index === activeIdx;
            const isSelected = key === selectedKey;
            return (
              <div
                key={key}
                ref={(el) => {
                  rowRefs.current[vi.index] = el;
                }}
                role="row"
                aria-rowindex={vi.index + 1}
                aria-selected={isSelected}
                tabIndex={isActive ? 0 : -1}
                className={cx(
                  'ec-table__row',
                  isActive && 'ec-table__row--active',
                  isSelected && 'ec-table__row--selected',
                )}
                style={{
                  position: 'absolute',
                  top: vi.start,
                  left: 0,
                  right: 0,
                  height: rowHeight,
                }}
                onClick={() => {
                  setActiveIdx(vi.index);
                  onRowSelect?.(key, row);
                }}
                onMouseEnter={() => setActiveIdx(vi.index)}
              >
                {columns.map((col) => (
                  <div
                    key={col.key}
                    role="gridcell"
                    className="ec-table__cell"
                    style={{ width: col.width, textAlign: col.align }}
                  >
                    {renderCell
                      ? renderCell(row, col, vi.index)
                      : col.render
                        ? col.render(row, vi.index)
                        : (row as Record<string, React.ReactNode>)[col.key]}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
