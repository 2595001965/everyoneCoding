/**
 * Tree：虚拟化树。基于可见节点扁平化 + useVirtualList，固定行高。1 万节点也只渲染窗口内。
 * 键盘：↑/↓ 移动、→ 展开（已展开则进子级）、← 收起（已收起则回父级）、Enter/Space 切换、Home/End。
 */
import * as React from 'react';
import { cx } from '../cx';
import { useVirtualList } from '../hooks/useVirtualList';
import { useControllableState } from '../_internal';

export interface TreeNode {
  id: string;
  label: React.ReactNode;
  children?: TreeNode[];
  icon?: React.ReactNode;
}

interface FlatNode {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
}

export interface TreeProps {
  data: TreeNode[];
  itemHeight?: number;
  height: number;
  expanded?: string[];
  defaultExpanded?: string[];
  onExpandedChange?: (expanded: string[]) => void;
  selected?: string;
  onSelect?: (id: string) => void;
  overscan?: number;
  className?: string;
  'aria-label'?: string;
}

function flatten(data: TreeNode[], expandedSet: Set<string>): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      const hasChildren = !!n.children && n.children.length > 0;
      out.push({ node: n, depth, hasChildren });
      if (hasChildren && expandedSet.has(n.id)) walk(n.children as TreeNode[], depth + 1);
    }
  };
  walk(data, 0);
  return out;
}

export function Tree(props: TreeProps): React.ReactElement {
  const {
    data,
    itemHeight = 28,
    height,
    expanded,
    defaultExpanded = [],
    onExpandedChange,
    selected,
    onSelect,
    overscan,
    className,
    'aria-label': ariaLabel = '树',
  } = props;

  const [expandedSet, setExpandedSet] = useControllableState<Set<string>>({
    value: expanded ? new Set(expanded) : undefined,
    defaultValue: new Set(defaultExpanded),
    onChange: (s) => onExpandedChange?.(Array.from(s)),
  });

  const flat = React.useMemo(() => flatten(data, expandedSet), [data, expandedSet]);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const rowRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  const { items: virtual, totalHeight } = useVirtualList({
    count: flat.length,
    itemHeight,
    overscan,
    getScrollElement: () => scrollRef.current,
  });

  const [activeIdx, setActiveIdx] = React.useState(0);
  const activeId = flat[activeIdx]?.node.id;

  const toggle = (id: string) => {
    const next = new Set(expandedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedSet(next);
  };

  const selectByIndex = (idx: number) => {
    const f = flat[idx];
    if (!f) return;
    setActiveIdx(idx);
    onSelect?.(f.node.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cur = flat[activeIdx];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectByIndex(Math.min(flat.length - 1, activeIdx + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectByIndex(Math.max(0, activeIdx - 1));
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (cur?.hasChildren) {
          if (!expandedSet.has(cur.node.id)) toggle(cur.node.id);
          else selectByIndex(Math.min(flat.length - 1, activeIdx + 1));
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (cur?.hasChildren && expandedSet.has(cur.node.id)) {
          toggle(cur.node.id);
        } else {
          const parentIdx = findParentIndex(flat, activeIdx);
          if (parentIdx >= 0) selectByIndex(parentIdx);
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (cur?.hasChildren) toggle(cur.node.id);
        else if (cur) onSelect?.(cur.node.id);
        break;
      case 'Home':
        e.preventDefault();
        selectByIndex(0);
        break;
      case 'End':
        e.preventDefault();
        selectByIndex(flat.length - 1);
        break;
    }
  };

  React.useEffect(() => {
    const el = rowRefs.current[activeIdx];
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  return (
    <div
      ref={scrollRef}
      className={cx('ec-tree', className)}
      style={{ height, overflow: 'auto' }}
      role="tree"
      aria-label={ariaLabel}
      aria-activedescendant={activeId ? `ec-tree-${activeId}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="ec-tree__sizer" style={{ height: totalHeight, position: 'relative' }}>
        {virtual.map((vi) => {
          const f = flat[vi.index];
          if (!f) return null;
          const isExpanded = expandedSet.has(f.node.id);
          const isActive = vi.index === activeIdx;
          const isSelected = f.node.id === selected;
          return (
            <div
              key={f.node.id}
              id={`ec-tree-${f.node.id}`}
              ref={(el) => {
                rowRefs.current[vi.index] = el;
              }}
              role="treeitem"
              aria-level={f.depth + 1}
              aria-expanded={f.hasChildren ? isExpanded : undefined}
              aria-selected={isSelected}
              className={cx(
                'ec-tree__row',
                isActive && 'ec-tree__row--active',
                isSelected && 'ec-tree__row--selected',
              )}
              style={{
                position: 'absolute',
                top: vi.start,
                left: 0,
                right: 0,
                height: itemHeight,
                paddingLeft: 8 + f.depth * 16,
              }}
              onClick={() => selectByIndex(vi.index)}
              onMouseEnter={() => setActiveIdx(vi.index)}
            >
              {f.hasChildren ? (
                <span
                  className="ec-tree__twisty"
                  aria-hidden="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(f.node.id);
                  }}
                >
                  {isExpanded ? '▾' : '▸'}
                </span>
              ) : (
                <span className="ec-tree__twisty ec-tree__twisty--leaf" aria-hidden="true" />
              )}
              {f.node.icon && (
                <span className="ec-tree__icon" aria-hidden="true">
                  {f.node.icon}
                </span>
              )}
              <span className="ec-tree__label">{f.node.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function findParentIndex(flat: FlatNode[], idx: number): number {
  const depth = flat[idx]?.depth ?? 0;
  for (let i = idx - 1; i >= 0; i--) {
    const f = flat[i];
    if (f && f.depth === depth - 1) return i;
  }
  return -1;
}
