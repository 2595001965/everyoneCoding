/**
 * 冲突与非法检测提示（T7-03 要点 3，FR-UNI-11 / FR-UNI-03）。
 *
 * 命中保留字 / 冲突 / 超长 / 非法字符时**阻断**，并把 3 个建议名做成可点按钮。
 * 点击建议名只做"填入输入框"（由 `onPick` 回调），**不自动执行**——用户仍需确认。
 */

import type { ConflictCheckResult, ProjectionKind } from '@ec/registry';
import { PROJECTION_LABELS, VIOLATION_LABELS } from '@ec/registry';
import { Tag } from '@ec/ui';

export interface ConflictWarningProps {
  /** 校验结果；`null` 或 `ok === true` 时不渲染 */
  result: ConflictCheckResult | null;
  /** 点击建议名 */
  onPick?: ((name: string) => void) | undefined;
  className?: string | undefined;
}

function projectionLabel(kind: ProjectionKind | null): string {
  return kind === null ? '规范名' : PROJECTION_LABELS[kind];
}

export function ConflictWarning({
  result,
  onPick,
  className,
}: ConflictWarningProps): JSX.Element | null {
  if (result === null || result.ok) return null;

  return (
    <section
      className={className}
      data-testid="conflict-warning"
      data-violations={result.violations.length}
      aria-label="命名不合法"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        border: '1px solid var(--ec-color-danger, #d4380d)',
        borderRadius: 6,
        background: 'var(--ec-color-danger-subtle, rgba(212, 56, 13, 0.06))',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Tag color="danger">无法使用该名称</Tag>
        <span style={{ color: 'var(--ec-color-text-secondary)' }}>
          共 {result.violations.length} 项问题，已阻断影响面分析
        </span>
      </header>

      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {result.violations.map((violation, index) => (
          <li
            key={`${violation.kind}-${violation.projection ?? 'name'}-${index}`}
            data-testid="violation"
          >
            <strong>{VIOLATION_LABELS[violation.kind]}</strong>
            <span style={{ color: 'var(--ec-color-text-secondary)' }}>
              {' '}
              · {projectionLabel(violation.projection)} · {violation.detail}
            </span>
          </li>
        ))}
      </ul>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--ec-color-text-secondary)' }}>建议名：</span>
        {result.suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            data-testid="suggestion"
            onClick={() => onPick?.(suggestion)}
            style={{
              padding: '2px 8px',
              border: '1px solid var(--ec-color-border)',
              borderRadius: 4,
              background: 'var(--ec-color-bg-surface)',
              color: 'var(--ec-color-text-primary)',
              cursor: 'pointer',
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </section>
  );
}
