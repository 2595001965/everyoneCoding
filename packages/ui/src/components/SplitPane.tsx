/**
 * SplitPane：可拖拽分隔的左右/上下双栏。指针拖拽 + 键盘（分隔条聚焦后用方向键微调）。
 * role=separator + aria-orientation/aria-valuenow（百分比）。
 *
 * `initial/min/max/step` 单位为像素，作用于固定尺寸的那一栏（`fixed`，默认第一栏）；
 * 另一栏 `flex: 1` 随容器伸缩。外壳布局里右侧面板需要"固定右栏、内容区伸缩"，用 `fixed="second"`。
 */
import * as React from 'react';
import { cx } from '../cx';
import { useResizeObserver } from '../hooks/useResizeObserver';

export interface SplitPaneProps {
  direction?: 'horizontal' | 'vertical';
  /** 固定尺寸的栏（像素），另一栏自动伸缩 */
  fixed?: 'first' | 'second';
  initial?: number;
  min?: number;
  max?: number;
  step?: number;
  first: React.ReactNode;
  second: React.ReactNode;
  className?: string;
  /** Called when a pointer drag ends or the keyboard changes the fixed pane size. */
  onResize?: (size: number) => void;
}

export function SplitPane({
  direction = 'horizontal',
  fixed = 'first',
  initial = 240,
  min = 80,
  max = 1024,
  step = 16,
  first,
  second,
  className,
  onResize,
}: SplitPaneProps): React.ReactElement {
  const isH = direction === 'horizontal';
  const fixFirst = fixed === 'first';
  const [ref, size] = useResizeObserver<HTMLDivElement>();
  const [primary, setPrimary] = React.useState(() => Math.max(min, Math.min(max, initial)));
  const dragging = React.useRef(false);
  const cleanupDrag = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => cleanupDrag.current?.(), []);

  const clamp = (v: number) => Math.max(min, Math.min(max, v));

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    cleanupDrag.current?.();
    dragging.current = true;
    let lastSize = primary;
    const move = (ev: PointerEvent) => {
      if (!dragging.current || !ref.current) return;
      const r = ref.current.getBoundingClientRect();
      // 固定栏在后时，尺寸 = 容器末端到指针的距离
      const v = isH
        ? fixFirst
          ? ev.clientX - r.left
          : r.right - ev.clientX
        : fixFirst
          ? ev.clientY - r.top
          : r.bottom - ev.clientY;
      lastSize = clamp(v);
      setPrimary(lastSize);
    };
    const up = () => {
      dragging.current = false;
      window.removeEventListener('pointermove', move);
      cleanupDrag.current = null;
    };
    const finish = () => {
      up();
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      onResize?.(lastSize);
    };
    cleanupDrag.current = () => {
      up();
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 方向键语义 = 分隔条移动方向；固定栏在后时右移/下移意味着它变小
    const dec = isH ? 'ArrowLeft' : 'ArrowUp';
    const inc = isH ? 'ArrowRight' : 'ArrowDown';
    const sign = fixFirst ? 1 : -1;
    if (e.key === dec) {
      e.preventDefault();
      const next = clamp(primary - sign * step);
      setPrimary(next);
      onResize?.(next);
    } else if (e.key === inc) {
      e.preventDefault();
      const next = clamp(primary + sign * step);
      setPrimary(next);
      onResize?.(next);
    }
  };

  const total = isH ? size.width : size.height;
  const firstPx = fixFirst ? primary : Math.max(0, total - primary);
  const pct = total > 0 ? Math.round((firstPx / total) * 100) : 0;

  const fixedStyle: React.CSSProperties = isH
    ? { flex: `0 0 ${primary}px`, minWidth: 0 }
    : { flex: `0 0 ${primary}px`, minHeight: 0 };
  const flexStyle: React.CSSProperties = { flex: 1, minWidth: 0, minHeight: 0 };

  return (
    <div
      ref={ref as React.Ref<HTMLDivElement>}
      className={cx('ec-split-pane', `ec-split-pane--${direction}`, className)}
      style={{
        display: 'flex',
        flexDirection: isH ? 'row' : 'column',
        height: '100%',
        width: '100%',
      }}
    >
      <div className="ec-split-pane__pane" style={fixFirst ? fixedStyle : flexStyle}>
        {first}
      </div>
      <div
        className="ec-split-pane__divider"
        role="separator"
        tabIndex={0}
        aria-orientation={isH ? 'vertical' : 'horizontal'}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="调整面板大小"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <div className="ec-split-pane__pane" style={fixFirst ? flexStyle : fixedStyle}>
        {second}
      </div>
    </div>
  );
}
