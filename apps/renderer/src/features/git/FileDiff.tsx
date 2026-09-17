/**
 * 文件差异视图（T6-02 要点 1）：并排 / 内联切换、折叠未修改区域、大文件跳过。
 *
 * - 并排：用 `alignHunk` 把每个 hunk 配成左右对齐行，行号严格对应同一视觉行；
 * - 折叠：连续上下文超过阈值用 `foldAlignedRows` 折成「已折叠 N 行」；
 * - 大文件 / 二进制：file.skipped 为 true 时**不渲染内容**，只显示 skipReason；
 * - skippedFiles > 0：面板顶部给出汇总提示。
 */
import { useMemo, useState, type CSSProperties } from 'react';

import { Tag } from '@ec/ui';
import {
  alignHunk,
  diffLineSign,
  FILE_STATUS_LABELS,
  foldAlignedRows,
  type GitDiff,
  type GitDiffFile,
  type SideBySideRow,
  type UnchangedFold,
} from '@ec/git';

export interface FileDiffProps {
  /** 整个 diff（可能含多个文件）；skippedFiles>0 时顶部汇总 */
  diff: GitDiff;
}

type View = 'side' | 'inline';

export function FileDiff({ diff }: FileDiffProps): JSX.Element {
  const [view, setView] = useState<View>('side');

  // 预计算每个文件的并排行（含折叠），依赖 diff 指纹
  const sideRows = useMemo(() => {
    const map = new Map<string, (SideBySideRow | UnchangedFold)[]>();
    for (const file of diff.files) {
      if (file.skipped) {
        map.set(file.path, []);
        continue;
      }
      const rows: SideBySideRow[] = [];
      for (const hunk of file.hunks) rows.push(...alignHunk(hunk));
      map.set(file.path, foldAlignedRows(rows, 3));
    }
    return map;
  }, [diff]);

  return (
    <div className="ec-file-diff" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {diff.skippedFiles > 0 && (
        <div
          className="ec-file-diff__skipped-summary"
          role="status"
          style={{ padding: 8, background: 'var(--ec-color-bg-subtle)', borderRadius: 6 }}
          data-testid="skipped-summary"
        >
          有 {diff.skippedFiles} 个文件因体积过大或二进制被跳过内容对比，可单独打开查看状态。
        </div>
      )}

      <div className="ec-file-diff__toolbar" style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => setView('side')}
          aria-pressed={view === 'side'}
          data-testid="view-side-by-side"
          style={toggleStyle(view === 'side')}
        >
          并排
        </button>
        <button
          type="button"
          onClick={() => setView('inline')}
          aria-pressed={view === 'inline'}
          data-testid="view-inline"
          style={toggleStyle(view === 'inline')}
        >
          内联
        </button>
      </div>

      {diff.files.length === 0 && <span role="status">没有文件变更。</span>}

      {diff.files.map((file) => (
        <FileBlock key={file.path} file={file} view={view} rows={sideRows.get(file.path) ?? []} />
      ))}
    </div>
  );
}

function FileBlock({
  file,
  view,
  rows,
}: {
  file: GitDiffFile;
  view: View;
  rows: (SideBySideRow | UnchangedFold)[];
}): JSX.Element {
  return (
    <div
      className="ec-file-diff__file"
      data-testid={`file-${file.path}`}
      style={{ border: '1px solid var(--ec-color-border)', borderRadius: 6 }}
    >
      <header
        className="ec-file-diff__file-head"
        style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 8px', background: 'var(--ec-color-bg-subtle)' }}
      >
        <span className="ec-file-diff__path" style={{ fontFamily: 'monospace' }}>
          {file.path}
        </span>
        <Tag color="neutral">{FILE_STATUS_LABELS[file.status]}</Tag>
        <span className="ec-file-diff__stat" style={{ color: 'var(--ec-color-success)' }}>
          +{file.additions}
        </span>
        <span className="ec-file-diff__stat" style={{ color: 'var(--ec-color-danger)' }}>
          -{file.deletions}
        </span>
      </header>

      {file.skipped ? (
        <div
          className="ec-file-diff__skipped"
          role="status"
          style={{ padding: 8, color: 'var(--ec-color-text-secondary)' }}
          data-testid={`skipped-${file.path}`}
        >
          {file.skipReason}
        </div>
      ) : view === 'side' ? (
        <SideBySide rows={rows} />
      ) : (
        <Inline file={file} />
      )}
    </div>
  );
}

function SideBySide({ rows }: { rows: (SideBySideRow | UnchangedFold)[] }): JSX.Element {
  return (
    <div className="ec-file-diff__sbs" data-testid="sbs" style={{ fontFamily: 'monospace', fontSize: 12 }}>
      {rows.map((row, index) => {
        if (row.kind === 'fold') {
          return (
            <div
              key={`fold-${index}`}
              className="ec-file-diff__fold"
              style={{ padding: '2px 8px', color: 'var(--ec-color-text-secondary)' }}
              data-testid="fold-row"
            >
              已折叠 {row.count} 行
            </div>
          );
        }
        return (
          <div
            key={`row-${index}`}
            className="ec-file-diff__sbs-row"
            data-testid="sbs-row"
            style={{ display: 'grid', gridTemplateColumns: '48px 1fr 48px 1fr' }}
          >
            <span
              className="ec-file-diff__sbs-leftnum"
              style={{ color: 'var(--ec-color-text-secondary)', textAlign: 'right', paddingRight: 4 }}
            >
              {row.left?.number ?? ''}
            </span>
            <span className="ec-file-diff__sbs-left" style={cellStyle(sideBg(row, 'left'))}>
              {row.left?.text ?? ''}
            </span>
            <span
              className="ec-file-diff__sbs-rightnum"
              style={{ color: 'var(--ec-color-text-secondary)', textAlign: 'right', paddingRight: 4 }}
            >
              {row.right?.number ?? ''}
            </span>
            <span className="ec-file-diff__sbs-right" style={cellStyle(sideBg(row, 'right'))}>
              {row.right?.text ?? ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Inline({ file }: { file: GitDiffFile }): JSX.Element {
  return (
    <div className="ec-file-diff__inline" data-testid="inline" style={{ fontFamily: 'monospace', fontSize: 12 }}>
      {file.hunks.map((hunk) =>
        hunk.lines.map((line, index) => (
          <div
            key={`${hunk.index}-${index}`}
            className={`ec-file-diff__inline-line ec-file-diff__inline-${line.kind}`}
            data-testid="inline-line"
            style={cellStyle(
              line.kind === 'add' ? 'var(--ec-color-success)' : line.kind === 'del' ? 'var(--ec-color-danger)' : '',
            )}
          >
            <span
              className="ec-file-diff__sign"
              style={{ display: 'inline-block', width: 16, textAlign: 'center', color: 'var(--ec-color-text-secondary)' }}
            >
              {diffLineSign(line.kind)}
            </span>
            <span className="ec-file-diff__text">{line.text}</span>
          </div>
        )),
      )}
    </div>
  );
}

/** 并排单元格底色：由行级 kind 决定（replace 左删右增），context 透明 */
function sideBg(row: SideBySideRow, side: 'left' | 'right'): string {
  if (row.kind === 'context') return '';
  if (row.kind === 'replace') return side === 'left' ? 'var(--ec-color-danger)' : 'var(--ec-color-success)';
  if (row.kind === 'add') return side === 'right' ? 'var(--ec-color-success)' : '';
  return side === 'left' ? 'var(--ec-color-danger)' : '';
}

function cellStyle(bg: string): CSSProperties {
  return { padding: '0 4px', background: bg === '' ? undefined : bg, whiteSpace: 'pre-wrap' };
}

function toggleStyle(active: boolean): CSSProperties {
  return {
    padding: '4px 10px',
    border: '1px solid var(--ec-color-border)',
    borderRadius: 6,
    cursor: 'pointer',
    background: active ? 'var(--ec-color-primary)' : 'var(--ec-color-surface)',
    color: active ? 'var(--ec-color-text-on-accent)' : 'var(--ec-color-text)',
  };
}
