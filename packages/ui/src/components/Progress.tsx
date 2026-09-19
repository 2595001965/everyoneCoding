/**
 * Progress：进度条。支持百分比与不确定（indeterminate）态。role=progressbar + aria-valuenow。
 */
import type * as React from 'react';
import { cx } from '../cx';

export interface ProgressProps {
  value?: number;
  max?: number;
  indeterminate?: boolean;
  className?: string;
}

export function Progress({
  value,
  max = 100,
  indeterminate = false,
  className,
}: ProgressProps): React.ReactElement {
  const pct = indeterminate ? undefined : Math.max(0, Math.min(100, ((value ?? 0) / max) * 100));
  return (
    <div
      className={cx('ec-progress', indeterminate && 'ec-progress--indeterminate', className)}
      role="progressbar"
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : max}
      aria-valuenow={indeterminate ? undefined : value}
    >
      <div
        className="ec-progress__bar"
        style={indeterminate ? undefined : { width: `${pct ?? 0}%` }}
      />
    </div>
  );
}
