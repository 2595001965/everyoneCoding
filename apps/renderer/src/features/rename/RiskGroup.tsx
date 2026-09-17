/**
 * 影响面分析的单组（三级风险之一）（T7-03 要点 4，FR-UNI-04）。
 *
 * 一组 = `auto` / `confirm` / `warn` 之一：
 * - 组头：全选复选框（半选态用 `indeterminate`）+ 组名 + 已选计数 + 展开 / 收起；
 * - 条目：复选框、位置（文件 / 段落 / 记忆条目 + 行号）、命中投影、置信度、`旧值 → 新值`；
 * - 每条可展开查看 **±3 行上下文**（PRD FR-UNI-05）；
 * - `warn` 组的默认勾选由调用方决定（影响面面板按"warn 默认不勾选"初始化）。
 */

import type { ImpactGroup, ImpactItem } from '@ec/registry';
import { PROJECTION_LABELS, RISK_LEVEL_LABELS } from '@ec/registry';
import { Checkbox, Tag } from '@ec/ui';

const LEVEL_TAG_COLOR = {
  auto: 'success',
  confirm: 'warning',
  warn: 'danger',
} as const;

export interface RiskGroupProps {
  group: ImpactGroup;
  /** 已勾选的条目 id */
  selection: ReadonlySet<string>;
  /** 是否展开条目列表 */
  expanded: boolean;
  /** 已展开上下文的条目 id */
  expandedItems?: ReadonlySet<string> | undefined;
  onToggleExpand: () => void;
  onToggleItem: (id: string, selected: boolean) => void;
  onToggleAll: (selected: boolean) => void;
  onToggleItemContext?: ((id: string) => void) | undefined;
}

/** 位置展示：代码 `file:line:col`；文档 / 记忆用 `refPath#locator` */
export function describeLocation(item: ImpactItem): string {
  if (item.kind === 'code') return item.locator ?? item.refPath;
  if (item.locator === null) return `${item.refPath}（${item.kind}）`;
  return `${item.refPath}${item.locator.startsWith('#') ? item.locator : ` ${item.locator}`}`;
}

function matchedLabel(item: ImpactItem): string {
  return item.matchedSymbol === null ? '规范名' : PROJECTION_LABELS[item.matchedSymbol];
}

export function RiskGroup({
  group,
  selection,
  expanded,
  expandedItems,
  onToggleExpand,
  onToggleItem,
  onToggleAll,
  onToggleItemContext,
}: RiskGroupProps): JSX.Element {
  const selectedCount = group.items.filter((item) => selection.has(item.id)).length;
  const allSelected = group.items.length > 0 && selectedCount === group.items.length;

  return (
    <section
      data-testid="risk-group"
      data-level={group.level}
      data-selected={selectedCount}
      aria-label={RISK_LEVEL_LABELS[group.level]}
      style={{
        border: '1px solid var(--ec-color-border)',
        borderRadius: 6,
        background: 'var(--ec-color-bg-surface)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: expanded ? '1px solid var(--ec-color-border)' : 'none',
        }}
      >
        <Checkbox
          checked={allSelected}
          indeterminate={selectedCount > 0 && !allSelected}
          aria-label={`全选${RISK_LEVEL_LABELS[group.level]}`}
          onChange={(checked) => onToggleAll(checked)}
        />
        <Tag color={LEVEL_TAG_COLOR[group.level]}>{RISK_LEVEL_LABELS[group.level]}</Tag>
        <span data-testid="risk-group-count" style={{ color: 'var(--ec-color-text-secondary)' }}>
          已选 {selectedCount} / {group.items.length}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onToggleExpand} data-testid="risk-group-toggle">
          {expanded ? '收起' : '展开'}
        </button>
      </header>

      {expanded && (
        <div style={{ padding: '4px 10px 10px' }}>
          <p style={{ margin: '4px 0 8px', color: 'var(--ec-color-text-secondary)' }}>{group.hint}</p>
          {group.items.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--ec-color-text-secondary)' }} data-testid="risk-group-empty">
              该级别没有受影响的出现位置
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {group.items.map((item) => {
                const showContext = expandedItems?.has(item.id) === true && item.context !== null;
                return (
                  <li
                    key={item.id}
                    data-testid="impact-item"
                    data-item-id={item.id}
                    data-kind={item.kind}
                    data-selected={selection.has(item.id) ? 'true' : 'false'}
                    style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}
                  >
                    <Checkbox
                      checked={selection.has(item.id)}
                      aria-label={`选择 ${item.id}`}
                      onChange={(checked) => onToggleItem(item.id, checked)}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <code style={{ wordBreak: 'break-all' }}>{describeLocation(item)}</code>
                        <Tag color="info">{matchedLabel(item)}</Tag>
                        <span style={{ color: 'var(--ec-color-text-secondary)' }}>
                          置信度 {item.confidence.toFixed(2)}
                        </span>
                        {item.kind === 'memory' && item.scopeLayer !== null && (
                          <Tag color="neutral">{item.scopeLayer} 记忆</Tag>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <del>{item.oldText}</del>
                        <span aria-hidden="true">→</span>
                        <ins data-testid="impact-new-text">{item.newText}</ins>
                      </div>
                      {item.detail !== null && (
                        <span style={{ color: 'var(--ec-color-text-secondary)' }}>{item.detail}</span>
                      )}
                    </div>
                    {item.context !== null && (
                      <button
                        type="button"
                        data-testid="impact-context-toggle"
                        onClick={() => onToggleItemContext?.(item.id)}
                      >
                        {showContext ? '收起上下文' : '上下文 ±3 行'}
                      </button>
                    )}
                    {showContext && item.context !== null && (
                      <pre
                        data-testid="impact-context"
                        style={{
                          gridColumn: '1 / -1',
                          margin: 0,
                          padding: 8,
                          background: 'var(--ec-color-bg-subtle)',
                          color: 'var(--ec-color-text-primary)',
                          borderRadius: 4,
                          overflowX: 'auto',
                          fontSize: 12,
                        }}
                      >
                        {[...item.context.before, item.context.line, ...item.context.after].join('\n')}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
