/**
 * 统一 diff 预览视图（T7-04 要点 1，FR-UNI-05）。
 *
 * - 四栏：代码 / 文档 / 记忆 / 逻辑结构（DIFF_COLUMNS + DIFF_COLUMN_LABELS）；
 * - 逐条可勾选、可检索定位、可展开 ±3 行上下文；文档栏支持"显示 / 隐藏修订标记"；
 * - 底部固定文案用 diffFooterText；diff.scopeNotice 原样展示（D-07 边界提示）。
 */
import { useMemo, useState } from 'react';

import type { DiffEntry, DiffStatus, OccurrenceKind, UnifiedDiff } from '@ec/registry';
import {
  DIFF_COLUMN_LABELS,
  DIFF_COLUMNS,
  RISK_LEVEL_LABELS,
  PROJECTION_LABELS,
  diffFooterText,
  searchEntries,
  selectionOf,
  setRevisionMarks,
  toggleColumn,
  toggleEntry,
} from '@ec/registry';
import { Badge, Button, Checkbox, SearchInput, Switch } from '@ec/ui';

import './components.css';

export interface UnifiedDiffViewProps {
  diff: UnifiedDiff;
  onChange?: (next: UnifiedDiff) => void;
  onExecute?: (selection: ReadonlySet<string>) => void;
  busy?: boolean;
}

function ColumnView(props: {
  column: OccurrenceKind;
  entries: readonly DiffEntry[];
  showRevisionMarks: boolean;
  busy: boolean;
  onToggleEntry: (id: string, selected: boolean) => void;
  onToggleColumn: (column: OccurrenceKind, selected: boolean) => void;
  onToggleRevisionMarks: (next: boolean) => void;
}): JSX.Element {
  const {
    column,
    entries,
    showRevisionMarks,
    busy,
    onToggleEntry,
    onToggleColumn,
    onToggleRevisionMarks,
  } = props;
  const selected = entries.filter((entry) => entry.selected).length;
  const allSelected = entries.length > 0 && selected === entries.length;

  return (
    <section className="ec-rename-column" data-testid="diff-column" data-column={column}>
      <div className="ec-rename-column__header">
        <label className="ec-rename-inline">
          <Checkbox
            checked={allSelected}
            disabled={busy || entries.length === 0}
            aria-label={`全选${DIFF_COLUMN_LABELS[column]}`}
            onChange={(next) => onToggleColumn(column, next)}
          />
          <span>{DIFF_COLUMN_LABELS[column]}</span>
          <span className="ec-rename-column__count">
            （已选 {selected}/{entries.length}）
          </span>
        </label>
        {column === 'doc' && (
          <Switch
            label="显示修订标记"
            checked={showRevisionMarks}
            disabled={busy}
            onChange={onToggleRevisionMarks}
          />
        )}
      </div>
      {entries.length === 0 ? (
        <span className="ec-rename-muted">无内容</span>
      ) : (
        entries.map((entry) => (
          <DiffEntryRow key={entry.id} entry={entry} busy={busy} onToggle={onToggleEntry} />
        ))
      )}
    </section>
  );
}

function DiffEntryRow(props: {
  entry: DiffEntry;
  busy: boolean;
  onToggle: (id: string, selected: boolean) => void;
}): JSX.Element {
  const { entry, busy, onToggle } = props;
  const [expanded, setExpanded] = useState(false);
  const projectionLabel =
    entry.matchedSymbol !== null ? PROJECTION_LABELS[entry.matchedSymbol] : null;
  const context = entry.context;

  return (
    <article
      className="ec-rename-entry"
      data-testid="diff-entry"
      data-column={entry.column}
      data-status={entry.status as DiffStatus}
    >
      <div className="ec-rename-entry__main">
        <Checkbox
          checked={entry.selected}
          disabled={busy}
          aria-label={`勾选 ${entry.refPath}`}
          onChange={(next) => onToggle(entry.id, next)}
        />
        <div className="ec-rename-block" style={{ flex: 1, minWidth: 0 }}>
          <span className="ec-rename-entry__loc">
            {entry.refPath}
            {entry.locator !== null ? ` · ${entry.locator}` : ''}
          </span>
          <span className="ec-rename-inline">
            <code className="ec-rename-entry__before">{entry.before}</code>
            <span className="ec-rename-muted">→</span>
            <code className="ec-rename-entry__after">{entry.after}</code>
            <Badge color="neutral">{RISK_LEVEL_LABELS[entry.riskLevel]}</Badge>
            {projectionLabel !== null && (
              <span className="ec-rename-muted">命中：{projectionLabel}</span>
            )}
          </span>
          {entry.detail !== null && <span className="ec-rename-muted">{entry.detail}</span>}
          {entry.column === 'doc' && entry.revision !== null && (
            <span className="ec-rename-entry__revision">
              修订：{entry.revision.oldText} → {entry.revision.newText}（{entry.revision.reason}）
            </span>
          )}
        </div>
      </div>
      {context !== null && (
        <button
          type="button"
          className="ec-rename-muted"
          onClick={() => setExpanded((value) => !value)}
        >
          上下文 ±3 行
        </button>
      )}
      {expanded && context !== null && (
        <pre className="ec-rename-entry__context" data-testid="diff-context">
          {context.before.map((line, index) => (
            <div key={`b-${index}`}>
              {context.startLine + index}: {line}
            </div>
          ))}
          <div>
            <strong>
              {context.startLine + context.before.length}: {context.line}
            </strong>
          </div>
          {context.after.map((line, index) => (
            <div key={`a-${index}`}>
              {context.startLine + context.before.length + 1 + index}: {line}
            </div>
          ))}
        </pre>
      )}
    </article>
  );
}

export function UnifiedDiffView(props: UnifiedDiffViewProps): JSX.Element {
  const { diff, onChange, onExecute, busy = false } = props;
  const [internal, setInternal] = useState<UnifiedDiff>(diff);
  const [query, setQuery] = useState('');

  const value = onChange === undefined ? internal : diff;
  const commit = (next: UnifiedDiff): void => {
    if (onChange === undefined) setInternal(next);
    else onChange(next);
  };

  const matchedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of searchEntries(value, query)) ids.add(entry.id);
    return ids;
  }, [value, query]);

  const handleToggleEntry = (id: string, selected: boolean): void => {
    commit(toggleEntry(value, id, selected));
  };
  const handleToggleColumn = (column: OccurrenceKind, selected: boolean): void => {
    commit(toggleColumn(value, column, selected));
  };
  const handleRevisionMarks = (next: boolean): void => {
    commit(setRevisionMarks(value, next));
  };

  return (
    <div className="ec-rename-root ec-rename-diff" data-testid="unified-diff">
      <div className="ec-rename-diff__toolbar">
        <SearchInput
          aria-label="检索定位"
          value={query}
          placeholder="检索文件路径 / 定位 / 符号 / 说明"
          onChange={setQuery}
        />
        {value.showRevisionMarks && <span className="ec-rename-muted">修订标记已显示</span>}
      </div>

      <div className="ec-rename-diff__columns">
        {DIFF_COLUMNS.map((column) => {
          const columnView = value.columns.find((view) => view.column === column);
          const entries = (columnView?.entries ?? []).filter((entry) => matchedIds.has(entry.id));
          const docRevision = column === 'doc' ? value.showRevisionMarks : false;
          return (
            <ColumnView
              key={column}
              column={column}
              entries={entries}
              showRevisionMarks={docRevision}
              busy={busy}
              onToggleEntry={handleToggleEntry}
              onToggleColumn={handleToggleColumn}
              onToggleRevisionMarks={handleRevisionMarks}
            />
          );
        })}
      </div>

      <footer className="ec-rename-footer">
        <div>{diffFooterText(value)}</div>
        <div className="ec-rename-scope-notice" data-testid="diff-scope-notice">
          {value.scopeNotice}
        </div>
      </footer>

      {onExecute !== undefined && (
        <div className="ec-rename-actions">
          <Button
            variant="primary"
            disabled={busy}
            data-testid="diff-execute"
            onClick={() => onExecute(selectionOf(value))}
          >
            执行重命名（{selectionOf(value).size} 处）
          </Button>
        </div>
      )}
    </div>
  );
}
