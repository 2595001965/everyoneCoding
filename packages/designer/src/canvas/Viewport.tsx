/**
 * 视口（T3-02 要点 3）。
 *
 * 缩放走 CSS `transform: scale()`，平移走 translate；内容（组件树）作为 children 注入，
 * 叠加层（安全区 / 对齐参考线 / 拖拽插入指示）作为 overlays 注入。
 * 本组件只负责「按 zoom/pan 把画布摆到屏幕正确位置」，不持有状态。
 */
import type * as React from 'react';
import { cx } from '@ec/ui';
import { GridOverlay } from './GridOverlay';

export interface ViewportProps {
  /** 缩放比例 */
  zoom: number;
  /** 平移（屏幕像素） */
  pan: { x: number; y: number };
  /** 画布逻辑宽（设计稿像素，未缩放） */
  width: number;
  /** 画布逻辑高 */
  height: number;
  /** 是否显示栅格 */
  showGrid?: boolean;
  /** 组件树 */
  children?: React.ReactNode;
  /** 叠加层（安全区 / 对齐线 / 插入指示） */
  overlays?: React.ReactNode;
  surfaceRef?: React.Ref<HTMLDivElement>;
  className?: string;
}

/**
 * 视口：外层裁切 + 内层缩放表面。组件树在此渲染，随 zoom/pan 整体变换。
 */
export function Viewport({
  zoom,
  pan,
  width,
  height,
  showGrid = true,
  children,
  overlays,
  surfaceRef,
  className,
}: ViewportProps): React.ReactElement {
  return (
    <div
      data-testid="viewport"
      className={cx('ec-viewport', className)}
      style={{ position: 'relative', overflow: 'hidden', width: '100%', height: '100%' }}
    >
      <div
        ref={surfaceRef}
        data-testid="canvas-surface"
        className="ec-canvas__surface"
        style={{
          width,
          height,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          position: 'relative',
          background: '#fff',
          color: '#1c2333',
          colorScheme: 'light',
        }}
      >
        {children}
        {showGrid && <GridOverlay visible zoom={zoom} width={width} height={height} />}
        {overlays}
      </div>
    </div>
  );
}
