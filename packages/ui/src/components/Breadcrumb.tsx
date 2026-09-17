/**
 * Breadcrumb：面包屑导航。nav > ol 结构，最后一项 aria-current=page。
 */
import type * as React from 'react';
import { cx } from '../cx';

export interface BreadcrumbItem {
  label: React.ReactNode;
  onClick?: () => void;
  href?: string;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
  separator?: React.ReactNode;
}

export function Breadcrumb({
  items,
  className,
  separator = '/',
}: BreadcrumbProps): React.ReactElement {
  return (
    <nav className={cx('ec-breadcrumb', className)} aria-label="面包屑">
      <ol className="ec-breadcrumb__list">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={i} className="ec-breadcrumb__item">
              {item.href && !isLast ? (
                <a className="ec-breadcrumb__link" href={item.href} onClick={item.onClick}>
                  {item.label}
                </a>
              ) : (
                <button
                  type="button"
                  className="ec-breadcrumb__link"
                  aria-current={isLast ? 'page' : undefined}
                  disabled={isLast}
                  onClick={item.onClick}
                >
                  {item.label}
                </button>
              )}
              {!isLast && (
                <span className="ec-breadcrumb__sep" aria-hidden="true">
                  {separator}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
