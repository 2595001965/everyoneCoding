import * as React from 'react';

import { Tag, Tooltip } from '@ec/ui';

import type { Breakpoint, PageDsl } from '../dsl/types';
import {
  overridesOf,
  RESPONSIVE_BREAKPOINTS,
  responsiveStats,
  setBreakpointOverride,
} from './responsive-rules';

/**
 * 断点切换条（T3-11 要点 4）。
 *
 * - 切换当前编辑断点（1920 / 1440 / 768 / 375）；
 * - 显示当前元素在该断点是否有覆盖，并支持「清除本断点覆盖」；
 * - 展示体积统计，直观体现「只存差异、不产生全量副本」。
 */

export const BREAKPOINT_LABELS: Record<string, string> = {
  '1920': '大屏 1920',
  '1440': '桌面 1440',
  '768': '平板 768',
  '375': '手机 375',
};

export interface BreakpointBarProps {
  value: Breakpoint;
  onChange: (breakpoint: Breakpoint) => void;
  /** 当前页面（用于统计与清除覆盖） */
  page?: PageDsl;
  /** 当前选中元素（显示该元素的覆盖状态） */
  elementId?: string | null;
  /** 清除某断点覆盖后的页面写回 */
  onChangePage?: (dsl: PageDsl) => void;
  className?: string;
}

export function BreakpointBar({
  value,
  onChange,
  page,
  elementId,
  onChangePage,
  className,
}: BreakpointBarProps): React.ReactElement {
  const stats = React.useMemo(() => (page ? responsiveStats(page) : null), [page]);
  const target = React.useMemo(() => {
    if (page === undefined || elementId === undefined || elementId === null) return null;
    const walk = (node: PageDsl['tree']): PageDsl['tree'] | null => {
      if (node.id === elementId) return node;
      for (const child of node.children ?? []) {
        const found = walk(child);
        if (found !== null) return found;
      }
      return null;
    };
    return walk(page.tree);
  }, [page, elementId]);

  const currentOverrides = target === null ? {} : overridesOf(target, value);

  return (
    <div
      className={className}
      data-testid="breakpoint-bar"
      role="group"
      aria-label="响应式断点"
      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
    >
      {RESPONSIVE_BREAKPOINTS.map((breakpoint) => {
        const active = breakpoint === value;
        return (
          <button
            key={breakpoint}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`breakpoint-${breakpoint}`}
            onClick={() => onChange(breakpoint)}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              borderRadius: 6,
              border: active
                ? '1px solid var(--ec-color-primary, #2f6bff)'
                : '1px solid var(--ec-color-border)',
              background: active ? 'var(--ec-color-bg-muted)' : 'var(--ec-color-surface)',
              cursor: 'pointer',
              color: 'var(--ec-color-text)',
            }}
          >
            {BREAKPOINT_LABELS[String(breakpoint)] ?? String(breakpoint)}
          </button>
        );
      })}

      {target !== null && (
        <>
          <Tag color={Object.keys(currentOverrides).length > 0 ? 'warning' : 'info'}>
            {`本断点差异 ${Object.keys(currentOverrides).length} 项`}
          </Tag>
          <button
            type="button"
            data-testid="clear-breakpoint-override"
            disabled={
              Object.keys(currentOverrides).length === 0 ||
              page === undefined ||
              onChangePage === undefined
            }
            onClick={() => {
              if (
                page === undefined ||
                onChangePage === undefined ||
                elementId === undefined ||
                elementId === null
              )
                return;
              onChangePage(setBreakpointOverride(page, elementId, value, null));
            }}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 12,
              cursor: 'pointer',
              color: 'var(--ec-color-text)',
              opacity: 0.75,
            }}
          >
            清除本断点覆盖
          </button>
        </>
      )}

      {stats !== null && (
        <Tooltip content="断点只存与基线的差异属性，不复制元素树">
          <Tag color="success" data-testid="responsive-stats">
            {`差异存储：${stats.overrideCount} 处覆盖 / 全量副本需 ${Math.round(stats.fullCopyBytes / 1024)}KB，实际 ${Math.round(stats.dslBytes / 1024)}KB`}
          </Tag>
        </Tooltip>
      )}
    </div>
  );
}
