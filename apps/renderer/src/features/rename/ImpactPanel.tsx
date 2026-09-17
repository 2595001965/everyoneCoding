/**
 * 影响面分析面板（T7-03 要点 4/5，FR-UNI-04 / FR-UNI-05 / FR-UNI-13）。
 *
 * - 三组折叠展示：`auto` 与 `confirm` **默认勾选**、`warn` **默认不勾选**（PRD 验收要点）；
 * - 每条可展开查看 **±3 行上下文**；顶部支持**检索定位**；
 * - 顶部显示总计与预计耗时（NFR-P-06 预算 1500ms）；
 * - 顶部**必须原样展示** `report.scopeNotice`（D-07：仅限本项目生效）。
 */

import { useEffect, useMemo, useState } from 'react';

import type { ImpactGroup, ImpactItem, ImpactReport, RiskLevel } from '@ec/registry';
import { RISK_LEVEL_LABELS, summarizeImpact } from '@ec/registry';
import { Button, EmptyState, SearchInput, Spinner } from '@ec/ui';

import { RiskGroup, describeLocation } from './RiskGroup';

/** 组顺序（面板展示顺序，与"自动 → 确认 → 警告"一致） */
const GROUP_ORDER: readonly RiskLevel[] = ['auto', 'confirm', 'warn'];

export interface ImpactPanelProps {
  report: ImpactReport | null;
  loading?: boolean | undefined;
  error?: string | null | undefined;
  /** 受控勾选集合；不传则内部自持 */
  selection?: ReadonlySet<string> | undefined;
  onSelectionChange?: ((selection: ReadonlySet<string>) => void) | undefined;
  /** 点击"确认执行" */
  onExecute?: ((selection: ReadonlySet<string>) => void) | undefined;
  busy?: boolean | undefined;
  onReload?: (() => void) | undefined;
  className?: string | undefined;
}

/** 默认勾选：auto + confirm（warn 不勾选） */
export function defaultImpactSelection(report: ImpactReport): Set<string> {
  const selection = new Set<string>();
  for (const group of report.groups) {
    if (group.level === 'warn') continue;
    for (const item of group.items) selection.add(item.id);
  }
  return selection;
}

function matchQuery(item: ImpactItem, keyword: string): boolean {
  if (keyword.length === 0) return true;
  return [
    item.refPath,
    item.locator ?? '',
    item.oldText,
    item.newText,
    item.detail ?? '',
    item.matchedSymbol ?? '',
    describeLocation(item),
  ]
    .join(' ')
    .toLowerCase()
    .includes(keyword);
}

/** 按检索词过滤（保持三组结构，只裁剪条目） */
export function filterGroups(groups: readonly ImpactGroup[], query: string): ImpactGroup[] {
  const keyword = query.trim().toLowerCase();
  if (keyword.length === 0) return [...groups];
  return groups.map((group) => ({ ...group, items: group.items.filter((item) => matchQuery(item, keyword)) }));
}

export function ImpactPanel({
  report,
  loading,
  error,
  selection,
  onSelectionChange,
  onExecute,
  busy,
  onReload,
  className,
}: ImpactPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [internal, setInternal] = useState<ReadonlySet<string>>(new Set());
  const [expandedLevels, setExpandedLevels] = useState<ReadonlySet<RiskLevel>>(
    new Set<RiskLevel>(['auto', 'confirm', 'warn']),
  );
  const [expandedItems, setExpandedItems] = useState<ReadonlySet<string>>(new Set());

  // 报告切换（对象标识变化）时按默认口径重置勾选
  useEffect(() => {
    if (report === null) {
      setInternal(new Set());
      return;
    }
    setInternal(defaultImpactSelection(report));
    setExpandedItems(new Set());
  }, [report]);

  const current = selection ?? internal;
  const groups = useMemo(() => filterGroups(report?.groups ?? [], query), [report, query]);
  const orderedGroups = useMemo(
    () =>
      [...groups].sort(
        (a, b) => GROUP_ORDER.indexOf(a.level) - GROUP_ORDER.indexOf(b.level),
      ),
    [groups],
  );

  const update = (next: ReadonlySet<string>): void => {
    if (selection === undefined) setInternal(next);
    onSelectionChange?.(next);
  };

  const toggleItem = (id: string, selected: boolean): void => {
    const next = new Set(current);
    if (selected) next.add(id);
    else next.delete(id);
    update(next);
  };

  const toggleAll = (level: RiskLevel, selected: boolean): void => {
    const group = report?.groups.find((item) => item.level === level);
    if (group === undefined) return;
    const next = new Set(current);
    for (const item of group.items) {
      if (selected) next.add(item.id);
      else next.delete(item.id);
    }
    update(next);
  };

  const toggleLevel = (level: RiskLevel): void => {
    const next = new Set(expandedLevels);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    setExpandedLevels(next);
  };

  const toggleItemContext = (id: string): void => {
    const next = new Set(expandedItems);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedItems(next);
  };

  if (error !== null && error !== undefined && error !== '') {
    return (
      <section className={className} data-testid="impact-panel" data-state="error">
        <EmptyState title="影响面分析失败" description={error} />
        {onReload !== undefined && <Button onClick={onReload}>重试</Button>}
      </section>
    );
  }

  if (loading === true && report === null) {
    return (
      <section
        className={className}
        data-testid="impact-panel"
        data-state="loading"
        style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 12 }}
      >
        <Spinner size={14} />
        <span>正在分析影响面…</span>
      </section>
    );
  }

  if (report === null) {
    return (
      <section className={className} data-testid="impact-panel" data-state="empty">
        <EmptyState title="尚未分析" description="修改名称后将自动分析影响面" />
      </section>
    );
  }

  const selectedCount = [...current].length;

  return (
    <section
      className={className}
      data-testid="impact-panel"
      data-state="ready"
      data-selected={selectedCount}
      aria-label="影响面分析"
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong data-testid="impact-summary">{summarizeImpact(report)}</strong>
          <span style={{ color: 'var(--ec-color-text-secondary)' }} data-testid="impact-elapsed">
            分析耗时 {report.elapsedMs}ms（预算 1500ms）
          </span>
        </div>
        <p
          data-testid="impact-scope-notice"
          style={{ margin: 0, color: 'var(--ec-color-text-secondary)' }}
        >
          {report.scopeNotice}
        </p>
        {report.warnings.length > 0 && (
          <ul data-testid="impact-warnings" style={{ margin: 0, paddingLeft: 18 }}>
            {report.warnings.map((warning) => (
              <li key={warning} style={{ color: 'var(--ec-color-text-secondary)' }}>
                {warning}
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="检索文件、段落、符号或说明"
            aria-label="检索受影响位置"
          />
          <span style={{ color: 'var(--ec-color-text-secondary)' }} data-testid="impact-groups-count">
            {orderedGroups.length} 组 / 共 {report.totals.total} 处
          </span>
        </div>
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {orderedGroups.map((group) => (
          <RiskGroup
            key={group.level}
            group={group}
            selection={current}
            expanded={expandedLevels.has(group.level)}
            expandedItems={expandedItems}
            onToggleExpand={() => toggleLevel(group.level)}
            onToggleItem={toggleItem}
            onToggleAll={(checked) => toggleAll(group.level, checked)}
            onToggleItemContext={toggleItemContext}
          />
        ))}
      </div>

      <footer style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          variant="primary"
          disabled={busy === true || selectedCount === 0}
          loading={busy === true}
          onClick={() => onExecute?.(current)}
          data-testid="impact-execute"
        >
          确认执行 {selectedCount} 处
        </Button>
        <span style={{ color: 'var(--ec-color-text-secondary)' }}>
          {RISK_LEVEL_LABELS.warn}默认不勾选，需要时请手动勾选
        </span>
      </footer>
    </section>
  );
}
