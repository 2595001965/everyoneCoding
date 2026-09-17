/**
 * 历史时间线（T6-03 要点 3）：用 `@ec/ui` 的 `List` 虚拟滚动渲染提交，
 * 点击某条拉 `commitDetail` 展示文件变更清单。
 *
 * 性能口径（jsdom 测不了真实帧率）：用「毫秒 + DOM 行数」量化，并在控制台打印实测值。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EmptyState, List, Tag } from '@ec/ui';
import { FILE_STATUS_LABELS, formatBytes, type GitCommit, type GitDiffFile } from '@ec/git';

import { useGitApi } from './git-api';
import { type HistoryFilterValue, toLogOptions } from './HistoryFilter';

export interface HistoryDetail {
  commit: GitCommit;
  files: GitDiffFile[];
  additions: number;
  deletions: number;
}

export interface HistoryTimelineProps {
  filter?: HistoryFilterValue | undefined;
  /** 列表高度（px） */
  height?: number;
  /** 行高（px） */
  itemHeight?: number;
  onSelect?: ((sha: string) => void) | undefined;
}

const DEFAULT_HEIGHT = 420;
const DEFAULT_ITEM_HEIGHT = 48;

export function HistoryTimeline({
  filter,
  height = DEFAULT_HEIGHT,
  itemHeight = DEFAULT_ITEM_HEIGHT,
  onSelect,
}: HistoryTimelineProps): JSX.Element {
  const api = useGitApi();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // 过滤条件的稳定指纹：避免依赖每帧新建的对象
  const options = useMemo(() => (filter === undefined ? {} : toLogOptions(filter)), [filter]);
  const optionsKey = JSON.stringify(options);

  const measureFrom = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    measureFrom.current = performance.now();
    const result = await api.log(options);
    if (result.ok && result.data !== null) setCommits(result.data);
    else setCommits([]);
    setLoading(false);
  }, [api, options]);

  useEffect(() => {
    void load();
  }, [load, optionsKey]);

  // 首屏渲染完成后打印实测耗时与真实 DOM 行数（虚拟滚动效果自证）
  useEffect(() => {
    if (measureFrom.current === null || loading || commits.length === 0) return;
    const elapsed = performance.now() - measureFrom.current;
    measureFrom.current = null;
    const rows = document.querySelectorAll('[data-testid="history-row"]').length;
    console.info(
      `[T6-03] 历史列表 ${commits.length} 条提交：构建 + 首屏渲染 ${elapsed.toFixed(1)}ms，DOM 行数 ${rows}`,
    );
  }, [commits, loading]);

  const openDetail = useCallback(
    async (sha: string) => {
      setSelected(sha);
      onSelect?.(sha);
      setDetailLoading(true);
      const result = await api.commitDetail(sha);
      setDetail(result.ok && result.data !== null ? result.data : null);
      setDetailLoading(false);
    },
    [api, onSelect],
  );

  if (!loading && commits.length === 0) {
    return <EmptyState title="没有匹配的提交" description="调整筛选条件或换一个分支再看。" />;
  }

  return (
    <div className="ec-history-timeline" data-testid="history-timeline">
      {loading && <span role="status">读取历史中…</span>}

      {!loading && (
        <List
          items={commits}
          itemHeight={itemHeight}
          height={height}
          aria-label="提交历史"
          getItemKey={(commit, index) => `${commit.sha}-${index}`}
          renderItem={(commit) => (
            <CommitRow commit={commit} selected={selected === commit.sha} onOpen={openDetail} />
          )}
        />
      )}

      {selected !== null && (
        <div className="ec-history-timeline__detail" data-testid="commit-detail" style={{ marginTop: 8 }}>
          {detailLoading && <span role="status">读取提交详情中…</span>}
          {!detailLoading && detail === null && <span role="status">未找到该提交的详情。</span>}
          {!detailLoading && detail !== null && (
            <>
              <div className="ec-history-timeline__detail-head">
                <strong>{detail.commit.shortSha}</strong> {detail.commit.subject}
              </div>
              <div style={{ color: 'var(--ec-color-text-secondary)' }}>
                {detail.files.length} 个文件，+{detail.additions} / -{detail.deletions}
              </div>
              <ul className="ec-history-timeline__files">
                {detail.files.map((file) => (
                  <li key={file.path} data-testid="detail-file">
                    <span style={{ fontFamily: 'monospace' }}>{file.path}</span>{' '}
                    <Tag color="neutral">{FILE_STATUS_LABELS[file.status]}</Tag>{' '}
                    {file.size !== null && <span>{formatBytes(file.size)}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CommitRow({
  commit,
  selected,
  onOpen,
}: {
  commit: GitCommit;
  selected: boolean;
  onOpen: (sha: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="ec-history-timeline__row"
      data-testid="history-row"
      data-sha={commit.sha}
      aria-pressed={selected}
      onClick={() => onOpen(commit.sha)}
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        width: '100%',
        textAlign: 'left',
        padding: '6px 8px',
        border: 'none',
        background: selected ? 'var(--ec-color-bg-subtle)' : 'transparent',
        color: 'var(--ec-color-text)',
        cursor: 'pointer',
      }}
    >
      <span style={{ fontFamily: 'monospace', color: 'var(--ec-color-text-secondary)' }}>{commit.shortSha}</span>
      <span style={{ flex: 1 }}>{commit.subject}</span>
      {commit.parents.length > 1 && <Tag color="warning">合并</Tag>}
      <span style={{ color: 'var(--ec-color-text-secondary)' }}>{commit.authorName}</span>
      <span style={{ color: 'var(--ec-color-text-secondary)' }}>{formatTime(commit.authoredAt)}</span>
    </button>
  );
}

/** 提交时间格式化（固定格式，避免依赖运行环境的 locale） */
export function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
