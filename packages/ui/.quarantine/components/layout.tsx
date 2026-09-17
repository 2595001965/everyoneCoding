import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cx } from '../cx';
import { useVirtualList } from '../hooks/useVirtualList';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export interface TabItem {
  key: string;
  label: string;
  disabled?: boolean;
  content: React.ReactNode;
}

/** 方向键切换 + Home/End 跳转（roving tabindex） */
export function Tabs({ items, initialKey, onChange }: { items: TabItem[]; initialKey?: string; onChange?: (key: string) => void }) {
  const selectable = items.filter((item) => !item.disabled);
  const [active, setActive] = useState(initialKey ?? selectable[0]?.key ?? '');
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const activate = useCallback(
    (key: string) => {
      setActive(key);
      onChange?.(key);
    },
    [onChange],
  );

  const onKeyDown = (event: React.KeyboardEvent, currentKey: string) => {
    const keys = selectable.map((item) => item.key);
    const index = keys.indexOf(currentKey);
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % keys.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + keys.length) % keys.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = keys.length - 1;
    else return;
    event.preventDefault();
    const nextKey = keys[nextIndex];
    if (nextKey !== undefined) {
      activate(nextKey);
      tabRefs.current.get(nextKey)?.focus();
    }
  };

  const activeItem = items.find((item) => item.key === active);

  return (
    <div className="ec-tabs">
      <div role="tablist" className="ec-tabs__list">
        {items.map((item) => {
          const selected = item.key === active;
          return (
            <button
              key={item.key}
              ref={(node) => {
                if (node) tabRefs.current.set(item.key, node);
                else tabRefs.current.delete(item.key);
              }}
              type="button"
              role="tab"
              id={`ec-tab-${item.key}`}
              aria-selected={selected}
              aria-controls={`ec-tabpanel-${item.key}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              className={cx('ec-tabs__tab', selected && 'ec-tabs__tab--active')}
              onClick={() => activate(item.key)}
              onKeyDown={(event) => onKeyDown(event, item.key)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {activeItem !== undefined ? (
        <div
          role="tabpanel"
          id={`ec-tabpanel-${activeItem.key}`}
          aria-labelledby={`ec-tab-${activeItem.key}`}
          tabIndex={0}
          className="ec-tabs__panel"
        >
          {activeItem.content}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List（虚拟化）
// ---------------------------------------------------------------------------

export interface ListRow {
  id: string;
  label: string;
  meta?: string;
  disabled?: boolean;
}

export interface ListProps {
  rows: ListRow[];
  /** 虚拟化阈值：超过该数量启用窗口渲染 */
  virtualThreshold?: number;
  height?: number;
  selectedId?: string | null;
  onSelect?: (row: ListRow) => void;
  ariaLabel?: string;
}

export function List({
  rows,
  virtualThreshold = 200,
  height = 320,
  selectedId = null,
  onSelect,
  ariaLabel = '列表',
}: ListProps) {
  const virtual = rows.length > virtualThreshold;
  const vlist = useVirtualList({ count: rows.length, itemHeight: 32 });
  const listId = useId();

  const renderRow = (row: ListRow, index: number) => (
    <div
      key={row.id}
      id={`${listId}-row-${row.id}`}
      role="option"
      aria-selected={row.id === selectedId}
      aria-disabled={row.disabled}
      className={cx('ec-list__row', row.id === selectedId && 'ec-list__row--selected')}
      style={virtual ? { height: 32 } : undefined}
      onClick={() => !row.disabled && onSelect?.(row)}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !row.disabled) {
          event.preventDefault();
          onSelect?.(row);
        }
      }}
      tabIndex={0}
      data-index={index}
    >
      <span className="ec-list__label">{row.label}</span>
      {row.meta !== undefined ? <span className="ec-list__meta">{row.meta}</span> : null}
    </div>
  );

  return (
    <div
      ref={virtual ? vlist.containerRef : undefined}
      role="listbox"
      aria-label={ariaLabel}
      className="ec-list"
      style={{ height }}
      onKeyDown={(event) => {
        if (!onSelect) return;
        const index = rows.findIndex((row) => row.id === selectedId);
        if (event.key === 'ArrowDown' && index < rows.length - 1) {
          event.preventDefault();
          const next = rows[index + 1];
          if (next) onSelect(next);
          if (virtual) vlist.scrollToIndex(index + 1);
        } else if (event.key === 'ArrowUp' && index > 0) {
          event.preventDefault();
          const prev = rows[index - 1];
          if (prev) onSelect(prev);
          if (virtual) vlist.scrollToIndex(index - 1);
        }
      }}
    >
      {virtual ? (
        <div {...vlist.innerProps}>
          {rows.slice(vlist.range.start, vlist.range.end).map((row, offset) => renderRow(row, vlist.range.start + offset))}
        </div>
      ) : (
        rows.map((row, index) => renderRow(row, index))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree（虚拟化 + 键盘导航）
// ---------------------------------------------------------------------------

export interface TreeNodeData {
  id: string;
  label: string;
  children?: TreeNodeData[];
}

interface FlatNode {
  node: TreeNodeData;
  depth: number;
  hasChildren: boolean;
}

function flattenTree(nodes: TreeNodeData[], expanded: Set<string>, depth = 0): FlatNode[] {
  const out: FlatNode[] = [];
  for (const node of nodes) {
    const hasChildren = (node.children?.length ?? 0) > 0;
    out.push({ node, depth, hasChildren });
    if (hasChildren && expanded.has(node.id)) {
      out.push(...flattenTree(node.children ?? [], expanded, depth + 1));
    }
  }
  return out;
}

export interface TreeProps {
  data: TreeNodeData[];
  defaultExpanded?: string[];
  selectedId?: string | null;
  onSelect?: (node: TreeNodeData) => void;
  height?: number;
  ariaLabel?: string;
}

export function Tree({ data, defaultExpanded = [], selectedId = null, onSelect, height = 320, ariaLabel = '树' }: TreeProps) {
  const [expanded, setExpanded] = useState(() => new Set(defaultExpanded));
  const flat = useMemo(() => flattenTree(data, expanded), [data, expanded]);
  const vlist = useVirtualList({ count: flat.length, itemHeight: 32 });

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = flat.findIndex((entry) => entry.node.id === selectedId);
    if (event.key === 'ArrowDown' && index < flat.length - 1) {
      event.preventDefault();
      const next = flat[index + 1];
      if (next) onSelect?.(next.node);
      vlist.scrollToIndex(index + 1);
    } else if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault();
      const prev = flat[index - 1];
      if (prev) onSelect?.(prev.node);
      vlist.scrollToIndex(index - 1);
    } else if (event.key === 'ArrowRight' && index >= 0) {
      const entry = flat[index];
      if (entry?.hasChildren && !expanded.has(entry.node.id)) toggle(entry.node.id);
    } else if (event.key === 'ArrowLeft' && index >= 0) {
      const entry = flat[index];
      if (entry?.hasChildren && expanded.has(entry.node.id)) toggle(entry.node.id);
    }
  };

  return (
    <div ref={vlist.containerRef} role="tree" aria-label={ariaLabel} className="ec-tree" style={{ height }} onKeyDown={onKeyDown}>
      <div {...vlist.innerProps}>
        {flat.slice(vlist.range.start, vlist.range.end).map((entry, offset) => {
          const index = vlist.range.start + offset;
          const isSelected = entry.node.id === selectedId;
          return (
            <div
              key={entry.node.id}
              role="treeitem"
              aria-level={entry.depth + 1}
              aria-expanded={entry.hasChildren ? expanded.has(entry.node.id) : undefined}
              aria-selected={isSelected}
              className={cx('ec-tree__row', isSelected && 'ec-tree__row--selected')}
              style={{ height: 32, paddingLeft: entry.depth * 16 }}
              tabIndex={-1}
              data-index={index}
              onClick={() => {
                onSelect?.(entry.node);
                if (entry.hasChildren) toggle(entry.node.id);
              }}
            >
              <span aria-hidden="true" className="ec-tree__arrow">
                {entry.hasChildren ? (expanded.has(entry.node.id) ? '▾' : '▸') : ''}
              </span>
              <span className="ec-tree__label">{entry.node.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table（虚拟化）
// ---------------------------------------------------------------------------

export interface TableColumn<T> {
  key: string;
  header: string;
  width?: number;
  render: (row: T) => React.ReactNode;
}

export interface TableProps<T> {
  columns: Array<TableColumn<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  height?: number;
  ariaLabel?: string;
  caption?: string;
}

export function Table<T>({ columns, rows, rowKey, height = 320, ariaLabel = '表格', caption }: TableProps<T>) {
  const vlist = useVirtualList({ count: rows.length, itemHeight: 36 });

  return (
    <div className="ec-table" role="table" aria-label={ariaLabel} aria-rowcount={rows.length}>
      {caption !== undefined ? <div className="ec-table__caption">{caption}</div> : null}
      <div role="row" className="ec-table__head">
        {columns.map((column) => (
          <div
            key={column.key}
            role="columnheader"
            className="ec-table__th"
            style={column.width !== undefined ? { width: column.width } : undefined}
          >
            {column.header}
          </div>
        ))}
      </div>
      <div ref={vlist.containerRef} className="ec-table__body" style={{ height }}>
        <div {...vlist.innerProps}>
          {rows.slice(vlist.range.start, vlist.range.end).map((row, offset) => {
            const index = vlist.range.start + offset;
            return (
              <div key={rowKey(row)} role="row" aria-rowindex={index + 1} className="ec-table__tr" style={{ height: 36 }}>
                {columns.map((column) => (
                  <div
                    key={column.key}
                    role="cell"
                    className="ec-table__td"
                    style={column.width !== undefined ? { width: column.width } : undefined}
                  >
                    {column.render(row)}
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

// ---------------------------------------------------------------------------
// SplitPane / Resizable
// ---------------------------------------------------------------------------

export interface SplitPaneProps {
  /** 左侧（或上侧）初始占比 0–1 */
  initialRatio?: number;
  direction?: 'horizontal' | 'vertical';
  minRatio?: number;
  maxRatio?: number;
  first: React.ReactNode;
  second: React.ReactNode;
  /** 分隔条无障碍名 */
  dividerLabel?: string;
}

/** 可拖拽分栏：支持键盘微调（←→ / ↑±2%） */
export function SplitPane({
  initialRatio = 0.3,
  direction = 'horizontal',
  minRatio = 0.1,
  maxRatio = 0.9,
  first,
  second,
  dividerLabel = '拖拽调整分栏大小',
}: SplitPaneProps) {
  const [ratio, setRatio] = useState(initialRatio);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const applyPointer = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const raw = direction === 'horizontal' ? (clientX - rect.left) / rect.width : (clientY - rect.top) / rect.height;
      setRatio(Math.max(minRatio, Math.min(maxRatio, raw)));
    },
    [direction, minRatio, maxRatio],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragging.current) return;
      applyPointer(event.clientX, event.clientY);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [applyPointer]);

  const isHorizontal = direction === 'horizontal';

  return (
    <div
      ref={containerRef}
      className={cx('ec-split', isHorizontal ? 'ec-split--horizontal' : 'ec-split--vertical')}
    >
      <div className="ec-split__pane" style={isHorizontal ? { width: `${ratio * 100}%` } : { height: `${ratio * 100}%` }}>
        {first}
      </div>
      <div
        role="separator"
        aria-label={dividerLabel}
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={Math.round(minRatio * 100)}
        aria-valuemax={Math.round(maxRatio * 100)}
        tabIndex={0}
        className={cx('ec-split__divider', isHorizontal ? 'ec-split__divider--h' : 'ec-split__divider--v')}
        onPointerDown={(event) => {
          event.preventDefault();
          dragging.current = true;
          document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
        }}
        onKeyDown={(event) => {
          const step = 0.02;
          if (isHorizontal && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            setRatio((value) => Math.max(minRatio, Math.min(maxRatio, value + (event.key === 'ArrowRight' ? step : -step))));
          } else if (!isHorizontal && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            setRatio((value) => Math.max(minRatio, Math.min(maxRatio, value + (event.key === 'ArrowDown' ? step : -step))));
          }
        }}
      />
      <div className="ec-split__pane ec-split__pane--grow">{second}</div>
    </div>
  );
}

export interface ResizableProps {
  /** 初始宽高 */
  width: number;
  height: number;
  onResize?: (size: { width: number; height: number }) => void;
  children: React.ReactNode;
  ariaLabel?: string;
}

/** 右下角拖拽缩放容器 */
export function Resizable({ width, height, onResize, children, ariaLabel = '可调整大小区域' }: ResizableProps) {
  const [size, setSize] = useState({ width, height });
  const resizing = useRef(false);
  const startRef = useRef({ x: 0, y: 0, width: 0, height: 0 });

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!resizing.current) return;
      const next = {
        width: Math.max(120, startRef.current.width + event.clientX - startRef.current.x),
        height: Math.max(80, startRef.current.height + event.clientY - startRef.current.y),
      };
      setSize(next);
      onResize?.(next);
    };
    const onUp = () => {
      resizing.current = false;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [onResize]);

  return (
    <div className="ec-resizable" style={{ width: size.width, height: size.height }} aria-label={ariaLabel}>
      {children}
      <div
        role="separator"
        aria-label="拖拽调整大小"
        tabIndex={0}
        className="ec-resizable__handle"
        onPointerDown={(event) => {
          event.preventDefault();
          resizing.current = true;
          startRef.current = { x: event.clientX, y: event.clientY, width: size.width, height: size.height };
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            setSize((current) => ({ ...current, width: current.width + 16 }));
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSize((current) => ({ ...current, height: current.height + 16 }));
          }
        }}
      />
    </div>
  );
}
