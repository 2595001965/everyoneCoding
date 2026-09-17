import * as React from 'react';

import { NOTE_TYPE_META, type NoteType } from './note-model';
import type { NoteBadgeInfo } from './note-repo';

/**
 * NoteBadge：备注角标（T4-01 要点 3）。
 *
 * 两处使用：
 * - 元素右上角（画布）：由 {@link ElementNoteBadges} 浮层统一渲染；
 * - 图层树节点（`LayerNode` 的可选 `note` 属性）。
 *
 * 类型着色规则：单一类型用该类型的颜色；多类型时以「禁止事项 > 优先级最高」的类型着色；
 * 含禁止事项时额外加红色描边，保证硬约束在任何缩放/密度下都能被一眼看到。
 */

export interface NoteBadgeProps {
  info: NoteBadgeInfo;
  size?: 'sm' | 'md';
  /** 点击后跳转 / 打开备注（不传则不可交互） */
  onClick?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
  className?: string;
}

/** 角标主色：禁止事项 > 高优先级类型 */
function dominantType(types: readonly NoteType[]): NoteType {
  const sorted = [...types].sort((a, b) => {
    const weightA = NOTE_TYPE_META[a].mustFollow ? 100 : NOTE_TYPE_META[a].basePriority;
    const weightB = NOTE_TYPE_META[b].mustFollow ? 100 : NOTE_TYPE_META[b].basePriority;
    return weightB - weightA;
  });
  return sorted[0] ?? 'todo';
}

export function describeNoteBadge(info: NoteBadgeInfo): string {
  const labels = info.types.map((type) => NOTE_TYPE_META[type].label).join('、');
  return `备注 ${info.count} 条（${labels}）${info.hasMustFollow ? '，含禁止事项' : ''}`;
}

export function NoteBadge({ info, size = 'sm', onClick, className }: NoteBadgeProps): React.ReactElement {
  const meta = NOTE_TYPE_META[dominantType(info.types)];
  const interactive = onClick !== undefined;
  const dimension = size === 'sm' ? 16 : 20;

  const style: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: dimension,
    height: dimension,
    padding: '0 4px',
    borderRadius: 8,
    fontSize: size === 'sm' ? 10 : 11,
    lineHeight: 1,
    fontWeight: 600,
    color: meta.color,
    background: meta.background,
    border: `1px solid ${meta.color}`,
    boxShadow: info.hasMustFollow ? `0 0 0 2px ${NOTE_TYPE_META.forbidden.background}` : 'none',
    cursor: interactive ? 'pointer' : 'default',
    userSelect: 'none',
  };

  return (
    <span
      className={['ec-note-badge', `ec-note-badge--${metaColorKey(meta.label)}`, className].filter(Boolean).join(' ')}
      data-note-badge={info.count}
      data-note-must-follow={info.hasMustFollow ? 'true' : 'false'}
      style={style}
      title={describeNoteBadge(info)}
      role={interactive ? 'button' : 'img'}
      aria-label={describeNoteBadge(info)}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick?.(event as unknown as React.MouseEvent<HTMLElement>);
              }
            }
          : undefined
      }
    >
      {info.count > 99 ? '99+' : info.count}
    </span>
  );
}

function metaColorKey(label: string): string {
  switch (label) {
    case '业务规则':
      return 'rule';
    case '校验要求':
      return 'validation';
    case '交互说明':
      return 'interaction';
    case '待办':
      return 'todo';
    case '疑问':
      return 'question';
    case '禁止事项':
      return 'forbidden';
    default:
      return 'neutral';
  }
}

/* ------------------------- 画布元素角标浮层 ------------------------- */

export interface MeasuredRect {
  top: number;
  left: number;
  width: number;
}

export interface ElementNoteBadgesProps {
  /** 元素 id → 角标信息（由 `NoteRepository.badgeMap('element')` 提供） */
  badges: Record<string, NoteBadgeInfo>;
  /** 测量函数：返回坐标（默认从 DOM 的 `data-element-id` 取矩形） */
  measure?: (elementId: string) => MeasuredRect | null;
  /** 定位容器：给定时按容器坐标绝对定位；缺省按视口坐标固定定位 */
  container?: HTMLElement | null;
  /** 变化触发重算（画布缩放 / 平移后由调用方递增） */
  refreshKey?: number;
  onSelect?: ((elementId: string) => void) | undefined;
}

function defaultMeasure(elementId: string): MeasuredRect | null {
  if (typeof document === 'undefined') return null;
  const node = document.querySelector<HTMLElement>(`[data-element-id="${elementId}"]`);
  if (node === null) return null;
  const rect = node.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width };
}

/**
 * 元素角标浮层：不侵入画布渲染（Canvas 的 memo 结构保持原样），
 * 而是在画布之外按 `data-element-id` 测量后覆盖角标。
 */
export function ElementNoteBadges({
  badges,
  measure,
  container = null,
  refreshKey = 0,
  onSelect,
}: ElementNoteBadgesProps): React.ReactElement | null {
  const measureFn = measure ?? defaultMeasure;
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = (): void => setTick((value) => value + 1);
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, []);

  const ids = React.useMemo(() => Object.keys(badges).sort(), [badges]);
  if (ids.length === 0) return null;

  const containerRect = container?.getBoundingClientRect() ?? null;
  const positioned = container !== null;

  return (
    <div
      className="ec-note-badges"
      data-testid="ec-note-badges"
      style={
        positioned
          ? { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }
          : { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 900 }
      }
    >
      {ids.map((elementId) => {
        const rect = measureFn(elementId);
        const info = badges[elementId];
        if (rect === null || info === undefined) return null;
        const top = containerRect === null ? rect.top : rect.top - containerRect.top;
        const left = containerRect === null ? rect.left : rect.left - containerRect.left;
        return (
          <span
            key={`${elementId}:${refreshKey}:${tick}`}
            data-note-anchor={elementId}
            style={{
              position: 'absolute',
              top,
              left: left + rect.width - 8,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'auto',
            }}
          >
            <NoteBadge
              info={info}
              onClick={
                onSelect === undefined
                  ? undefined
                  : () => {
                      onSelect(elementId);
                    }
              }
            />
          </span>
        );
      })}
    </div>
  );
}
