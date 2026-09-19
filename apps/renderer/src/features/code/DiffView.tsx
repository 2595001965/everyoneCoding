import { useMemo, useState } from 'react';

import { Tag } from '@ec/ui';

import type { DiffViewModel, FilePreview, PreviewDiffLine } from '@ec/ai';

/**
 * DiffView：逐文件差异展示（T4-05 要点 4 / FR-AI-02 的可见性）。
 *
 * 能力：
 * - **内联 / 并排**两种排布的切换；
 * - **按文件**与**按块（hunk）**选择，选择结果交给 ApplyBar 决定"应用哪些"；
 * - 大文件（>1MB）跳过内容 diff 并明确提示，但仍可整体应用；
 * - 被阻塞的文件（补丁无法应用 / 目标已存在）用红色标注并给出原因。
 */

export type DiffLayout = 'inline' | 'side-by-side';

export interface DiffViewProps {
  model: DiffViewModel;
  layout?: DiffLayout;
  onToggleFile?: ((path: string) => void) | undefined;
  onToggleHunk?: ((path: string, hunkIndex: number) => void) | undefined;
  /** 要求 AI 重改（带上当前选择范围） */
  onRequestRework?: ((paths: readonly string[]) => void) | undefined;
  height?: number;
}

export function DiffView({
  model,
  layout: initialLayout = 'inline',
  onToggleFile,
  onToggleHunk,
  onRequestRework,
  height = 360,
}: DiffViewProps): JSX.Element {
  const [layout, setLayout] = useState<DiffLayout>(initialLayout);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const selectedPaths = useMemo(
    () => model.files.filter((file) => file.selected).map((file) => file.path),
    [model],
  );

  return (
    <section
      className="ec-diff-view"
      aria-label="代码变更预览"
      data-testid="ec-diff-view"
      data-plan-id={model.planId}
    >
      <header
        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}
      >
        <strong style={{ fontSize: 13 }}>变更预览</strong>
        <Tag color="success">{`+${model.totalAdded}`}</Tag>
        <Tag color="danger">{`-${model.totalRemoved}`}</Tag>
        <Tag color="neutral">{`${model.applicableCount}/${model.files.length} 个文件将应用`}</Tag>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="切换到内联视图"
          onClick={() => setLayout('inline')}
          aria-pressed={layout === 'inline'}
        >
          内联
        </button>
        <button
          type="button"
          aria-label="切换到并排视图"
          onClick={() => setLayout('side-by-side')}
          aria-pressed={layout === 'side-by-side'}
        >
          并排
        </button>
        <button
          type="button"
          aria-label="要求 AI 重改"
          disabled={onRequestRework === undefined || selectedPaths.length === 0}
          onClick={() => onRequestRework?.(selectedPaths)}
        >
          要求 AI 重改
        </button>
      </header>

      {model.files.length === 0 && <p style={{ fontSize: 12 }}>本次没有文件变更。</p>}

      <div style={{ maxHeight: height, overflow: 'auto' }}>
        {model.files.map((file) => {
          const isExpanded = expanded[file.path] ?? true;
          return (
            <article
              key={file.path}
              className="ec-diff-file"
              data-diff-path={file.path}
              data-diff-blocked={file.blocked ? 'true' : 'false'}
              data-diff-selected={file.selected ? 'true' : 'false'}
              style={{
                border: `1px solid ${file.blocked ? '#fca5a5' : 'var(--ec-border, #e2e8f0)'}`,
                borderRadius: 8,
                padding: '8px 10px',
                marginBottom: 8,
              }}
            >
              <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <label
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={file.selected}
                    aria-label={`应用 ${file.path}`}
                    disabled={file.blocked || onToggleFile === undefined}
                    onClick={() => onToggleFile?.(file.path)}
                  >
                    {file.selected ? '☑' : '☐'}
                  </button>
                  {ACTION_LABELS[file.action]}
                </label>
                <code style={{ fontSize: 12 }}>{file.path}</code>
                <Tag color="neutral">{file.language}</Tag>
                <Tag color="success">{`+${file.addedLines}`}</Tag>
                <Tag color="danger">{`-${file.removedLines}`}</Tag>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  aria-label={`展开 ${file.path}`}
                  onClick={() => setExpanded((value) => ({ ...value, [file.path]: !isExpanded }))}
                >
                  {isExpanded ? '收起' : '展开'}
                </button>
              </header>

              {file.blocked && (
                <p role="alert" style={{ margin: '6px 0 0', fontSize: 12, color: '#b91c1c' }}>
                  {`无法应用：${file.blockReason ?? '补丁与当前文件不一致'}`}
                </p>
              )}

              {file.skippedContentDiff && (
                <p style={{ margin: '6px 0 0', fontSize: 12, color: '#b45309' }}>
                  {file.skipReason ?? '已跳过内容 diff'}
                </p>
              )}

              {isExpanded && !file.skippedContentDiff && (
                <div style={{ marginTop: 6 }}>
                  {file.hunks.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--ec-text-secondary, #64748b)' }}>
                      无内容差异（内容与磁盘一致）。
                    </p>
                  ) : (
                    file.hunks.map((hunk) => (
                      <div
                        key={hunk.index}
                        data-hunk-key={`${file.path}#${hunk.index}`}
                        style={{ marginBottom: 6 }}
                      >
                        <div
                          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}
                        >
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={hunk.selected}
                            aria-label={`应用 ${file.path} 第 ${hunk.index + 1} 块`}
                            disabled={onToggleHunk === undefined}
                            onClick={() => onToggleHunk?.(file.path, hunk.index)}
                          >
                            {hunk.selected ? '☑' : '☐'}
                          </button>
                          <code>{hunk.header}</code>
                        </div>
                        <DiffLines lines={hunk.lines} layout={layout} />
                      </div>
                    ))
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

const ACTION_LABELS: Record<FilePreview['action'], string> = {
  create: '新建',
  patch: '修改',
  delete: '删除',
};

export function diffLinePrefix(kind: PreviewDiffLine['kind']): string {
  if (kind === 'add') return '+';
  if (kind === 'remove') return '-';
  return ' ';
}

export function diffLineColor(kind: PreviewDiffLine['kind']): string {
  // 与全站配色一致：新增用绿、删除用红（这里表达代码差异，不是行情涨跌）
  if (kind === 'add') return '#166534';
  if (kind === 'remove') return '#b91c1c';
  return 'inherit';
}

function DiffLines({
  lines,
  layout,
}: {
  lines: readonly PreviewDiffLine[];
  layout: DiffLayout;
}): JSX.Element {
  if (layout === 'inline') {
    return (
      <pre
        data-testid="ec-diff-inline"
        style={{
          margin: 0,
          fontSize: 11,
          lineHeight: 1.5,
          overflowX: 'auto',
          background: 'var(--ec-surface-sunken, #f8fafc)',
          borderRadius: 6,
          padding: 6,
        }}
      >
        {lines.map((line, index) => (
          <div key={index} data-line-kind={line.kind} style={{ color: diffLineColor(line.kind) }}>
            {`${String(line.oldLine ?? '').padStart(4, ' ')} ${diffLinePrefix(line.kind)}${line.text}`}
          </div>
        ))}
      </pre>
    );
  }

  // 并排：左侧原文（add 行留空），右侧新文（remove 行留空）
  return (
    <div
      data-testid="ec-diff-side-by-side"
      style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11 }}
    >
      <pre
        style={{
          margin: 0,
          overflowX: 'auto',
          background: 'var(--ec-surface-sunken, #f8fafc)',
          borderRadius: 6,
          padding: 6,
        }}
      >
        {lines.map((line, index) => (
          <div
            key={index}
            style={{ color: line.kind === 'add' ? 'transparent' : diffLineColor(line.kind) }}
          >
            {`${String(line.oldLine ?? '').padStart(4, ' ')} ${line.kind === 'add' ? ' ' : diffLinePrefix(line.kind)}${line.kind === 'add' ? ' ' : line.text}`}
          </div>
        ))}
      </pre>
      <pre
        style={{
          margin: 0,
          overflowX: 'auto',
          background: 'var(--ec-surface-faint, #ffffff)',
          borderRadius: 6,
          padding: 6,
        }}
      >
        {lines.map((line, index) => (
          <div
            key={index}
            style={{ color: line.kind === 'remove' ? 'transparent' : diffLineColor(line.kind) }}
          >
            {`${String(line.newLine ?? '').padStart(4, ' ')} ${line.kind === 'remove' ? ' ' : diffLinePrefix(line.kind)}${line.kind === 'remove' ? ' ' : line.text}`}
          </div>
        ))}
      </pre>
    </div>
  );
}
