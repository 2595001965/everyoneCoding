/**
 * 安全区覆盖层（T3-02 要点 4）。
 *
 * 仅视觉：状态栏 / 刘海挖孔 / 底部指示条，覆盖在画布内容之上，**不进入 DSL**。
 * 必须带 role / data-testid 便于断言。
 */
import type * as React from 'react';
import { cx } from '@ec/ui';
import type { DevicePreset, SafeArea } from './device-presets';

export interface SafeAreaOverlayProps {
  /** 设备预设（取其 safeArea） */
  preset?: DevicePreset | undefined;
  /** 画布缩放，用于等比缩放覆盖层 */
  zoom?: number;
  className?: string;
}

/**
 * 安全区覆盖层。移动端 / 鸿蒙预设才渲染（有 safeArea 时）。
 * 不拦截交互（pointer-events:none）。
 */
export function SafeAreaOverlay({
  preset,
  zoom = 1,
  className,
}: SafeAreaOverlayProps): React.ReactElement | null {
  const safe: SafeArea | undefined = preset?.safeArea;
  if (!safe) return null;

  const top = safe.top * zoom;
  const bottom = safe.bottom * zoom;
  const indicator = (safe.indicatorBar ?? 0) * zoom;

  return (
    <div
      data-testid="safe-area"
      role="img"
      aria-label="设备安全区"
      className={cx('ec-safe-area', className)}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}
    >
      {top > 0 && (
        <div
          data-testid="safe-area-top"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: top,
            background: 'rgba(0,0,0,0.04)',
          }}
        />
      )}
      {safe.notch && (
        <div
          data-testid="safe-area-notch"
          style={{
            position: 'absolute',
            top: 0,
            ...(safe.notch.position === 'left'
              ? { left: 0 }
              : { left: '50%', transform: 'translateX(-50%)' }),
            width: safe.notch.width * zoom,
            height: safe.notch.height * zoom,
            background: '#111',
            borderRadius: 8,
          }}
        />
      )}
      {bottom > 0 && (
        <div
          data-testid="safe-area-bottom"
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: bottom,
            background: 'rgba(0,0,0,0.04)',
          }}
        />
      )}
      {indicator > 0 && (
        <div
          data-testid="safe-area-indicator"
          style={{
            position: 'absolute',
            bottom: Math.max(0, bottom - indicator) * 0,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 120 * zoom,
            height: indicator,
            background: 'rgba(0,0,0,0.5)',
            borderRadius: 999,
          }}
        />
      )}
    </div>
  );
}
