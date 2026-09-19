/**
 * 变更面板（T6-02 要点 1）：文件按目录分组，四态色、勾选、全选/反选、来源标签。
 *
 * 用户永不接触命令行：暂存 / 取消暂存由按钮触发，结果以结构化日志回显（这里简化为
 * 顶部状态条）。点击文件调 `onOpenFile`，点击来源标签调 `onOpenSource`。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Checkbox, EmptyState, Tag } from '@ec/ui';
import {
  FILE_STATUS_COLORS,
  FILE_STATUS_LABELS,
  type ChangeSource,
  type GitFileChange,
  type GitStatusSummary,
} from '@ec/git';

import { useGitApi } from './git-api';
import { changeSourceLabel } from './git-helpers';

export interface ChangesPanelProps {
  /** 点击文件打开（只读视图，D-04） */
  onOpenFile?: (path: string) => void;
  /** 点击来源标签跳转 */
  onOpenSource?: (source: ChangeSource) => void;
}

interface Group {
  dir: string;
  files: GitFileChange[];
}

function groupByDir(changes: readonly GitFileChange[]): Group[] {
  const map = new Map<string, GitFileChange[]>();
  for (const change of changes) {
    const dir = change.path.includes('/')
      ? change.path.slice(0, change.path.lastIndexOf('/'))
      : '（根目录）';
    const list = map.get(dir) ?? [];
    list.push(change);
    map.set(dir, list);
  }
  return [...map.entries()]
    .map(([dir, files]) => ({ dir, files }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

export function ChangesPanel({ onOpenFile, onOpenSource }: ChangesPanelProps): JSX.Element {
  const api = useGitApi();
  const [status, setStatus] = useState<GitStatusSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api.status();
    if (result.ok && result.data !== null) setStatus(result.data);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => (status === null ? [] : groupByDir(status.changes)), [status]);
  const allPaths = useMemo(
    () => (status === null ? [] : status.changes.map((c) => c.path)),
    [status],
  );

  const toggle = useCallback((path: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => setSelected(new Set(allPaths)), [allPaths]);
  const invert = useCallback(() => {
    setSelected((prev) => {
      const next = new Set<string>();
      for (const p of allPaths) if (!prev.has(p)) next.add(p);
      return next;
    });
  }, [allPaths]);

  const runStage = useCallback(
    async (paths: readonly string[], unstage: boolean) => {
      if (paths.length === 0) return;
      const result = unstage ? await api.unstage(paths) : await api.stage(paths);
      if (result.ok) {
        setNotice(unstage ? `已取消暂存 ${result.data} 个文件` : `已暂存 ${result.data} 个文件`);
        setSelected(new Set());
        await load();
      } else {
        setNotice(result.error?.message ?? '操作失败');
      }
    },
    [api, load],
  );

  if (!loading && status !== null && status.changes.length === 0) {
    return <EmptyState title="工作区干净" description="没有需要提交的变更。" />;
  }

  return (
    <div className="ec-git-changes" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        className="ec-git-changes__toolbar"
        style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Button
          size="sm"
          onClick={selectAll}
          disabled={allPaths.length === 0}
          data-testid="select-all"
        >
          全选
        </Button>
        <Button size="sm" onClick={invert} disabled={allPaths.length === 0} data-testid="invert">
          反选
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => runStage([...selected], false)}
          disabled={selected.size === 0}
          data-testid="stage-selected"
        >
          暂存所选（{selected.size}）
        </Button>
        <Button
          size="sm"
          onClick={() =>
            runStage(
              [...selected].filter((p) => isStaged(status, p)),
              true,
            )
          }
          disabled={selected.size === 0}
          data-testid="unstage-selected"
        >
          取消暂存所选
        </Button>
        {notice !== null && (
          <span
            className="ec-git-changes__notice"
            role="status"
            style={{ color: 'var(--ec-color-text-secondary)' }}
          >
            {notice}
          </span>
        )}
      </div>

      {loading && <span role="status">读取变更中…</span>}

      {groups.map((group) => (
        <div key={group.dir} className="ec-git-changes__group">
          <div
            className="ec-git-changes__dir"
            style={{ fontWeight: 600, color: 'var(--ec-color-text-secondary)' }}
          >
            {group.dir}
          </div>
          {group.files.map((change) => (
            <div
              key={change.path}
              className="ec-git-changes__file"
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <Checkbox
                checked={selected.has(change.path)}
                onChange={(checked) => toggle(change.path, checked)}
                aria-label={`选择 ${change.path}`}
                data-testid={`check-${change.path}`}
              />
              <span
                className="ec-git-changes__status-dot"
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: FILE_STATUS_COLORS[change.status],
                }}
              />
              <button
                type="button"
                className="ec-git-changes__filename"
                onClick={() => onOpenFile?.(change.path)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--ec-color-text)',
                  cursor: 'pointer',
                  padding: 0,
                }}
                data-testid={`open-${change.path}`}
              >
                {change.path}
              </button>
              <Tag color="neutral" data-testid={`status-${change.path}`}>
                {FILE_STATUS_LABELS[change.status]}
                {change.staged ? '（已暂存）' : ''}
              </Tag>
              {change.source !== null && (
                <button
                  type="button"
                  className="ec-git-changes__source"
                  onClick={() => onOpenSource?.(change.source as ChangeSource)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--ec-color-info)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                  data-testid={`source-${change.path}`}
                >
                  {changeSourceLabel(change.source)}
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function isStaged(status: GitStatusSummary | null, path: string): boolean {
  if (status === null) return false;
  return status.changes.find((c) => c.path === path)?.staged === true;
}
