/**
 * EmptyState：空状态占位。中文文案提示，可带图标与操作区。
 */
import type * as React from 'react';
import { cx } from '../cx';

export interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title = '暂无内容',
  description,
  icon,
  action,
  className,
}: EmptyStateProps): React.ReactElement {
  return (
    <div className={cx('ec-empty', className)} role="status">
      {icon && (
        <div className="ec-empty__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="ec-empty__title">{title}</div>
      {description && <div className="ec-empty__desc">{description}</div>}
      {action && <div className="ec-empty__action">{action}</div>}
    </div>
  );
}
