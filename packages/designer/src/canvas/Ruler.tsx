/**
 * 标尺（T3-02 要点 5）。
 *
 * px 标尺：随缩放与平移更新刻度。顶部水平、左侧垂直各一条。
 * 纯展示，不影响布局（pointer-events:none）。
 */
import * as React from 'react';
import { cx } from '@ec/ui';

export interface RulerProps {
  /** 'x' 水平标尺 / 'y' 垂直标尺 */
  orientation: 'x' | 'y';
  /** 缩放比例 */
  zoom: number;
  /** 该轴画布逻辑长度（px） */
  length: number;
  /** 平移偏移（屏幕像素），用于让刻度跟随平移 */
  offset?: number;
  /** 主刻度步长（画布 px），默认 50 */
  step?: number;
  className?: string;
}

function buildTicks(length: number, step: number): number[] {
  const ticks: number[] = [];
  for (let pos = 0; pos <= length; pos += step) ticks.push(pos);
  return ticks;
}

/**
 * 单条标尺。刻度标签显示画布坐标系下的像素值（已按 zoom 缩放绘制，但数值为设计稿像素）。
 */
export function Ruler({
  orientation,
  zoom,
  length,
  offset = 0,
  step = 50,
  className,
}: RulerProps): React.ReactElement {
  const ticks = React.useMemo(() => buildTicks(length, step), [length, step]);
  const isX = orientation === 'x';
  const thickness = 18;

  return (
    <div
      data-testid={`ruler-${orientation}`}
      aria-hidden="true"
      className={cx('ec-ruler', `ec-ruler--${orientation}`, className)}
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        background: 'var(--ec-ruler-bg, #f5f5f5)',
        borderColor: 'var(--ec-border, #e5e5e5)',
        ...(isX
          ? { top: 0, left: 0, right: 0, height: thickness, borderBottom: '1px solid' }
          : { top: 0, left: 0, bottom: 0, width: thickness, borderRight: '1px solid' }),
      }}
    >
      {ticks.map((pos) => {
        const screenPos = pos * zoom + offset;
        return (
          <div
            key={pos}
            style={{
              position: 'absolute',
              ...(isX
                ? {
                    left: screenPos,
                    top: 0,
                    height: thickness,
                    borderLeft: '1px solid var(--ec-border, #e5e5e5)',
                  }
                : {
                    top: screenPos,
                    left: 0,
                    width: thickness,
                    borderTop: '1px solid var(--ec-border, #e5e5e5)',
                  }),
            }}
          >
            {pos % (step * 2) === 0 && (
              <span
                style={{
                  position: 'absolute',
                  fontSize: 9,
                  color: '#999',
                  ...(isX ? { top: 2, left: 2 } : { left: 2, top: 1, writingMode: 'vertical-rl' }),
                }}
              >
                {pos}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
