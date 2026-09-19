/**
 * 暂存面板（T6-04 要点 4）：列表 + 新建 + apply / pop / drop。
 * `drop` 会永久丢弃暂存内容，必须二次确认（FR-GIT-07）。
 */
import { useCallback, useEffect, useState } from 'react';

import { Button, EmptyState, Input, Modal, Tag } from '@ec/ui';
import type { GitStashEntry } from '@ec/git';

import { useGitApi } from './git-api';
import { formatTime } from './HistoryTimeline';

export interface StashPanelProps {
  /** 暂存变化后回调 */
  onChanged?: () => void;
}

export function StashPanel({ onChanged }: StashPanelProps): JSX.Element {
  const api = useGitApi();
  const [entries, setEntries] = useState<GitStashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [pendingDrop, setPendingDrop] = useState<GitStashEntry | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const result = await api.stashList();
    if (result.ok && result.data !== null) setEntries(result.data);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const push = useCallback(async () => {
    const result = await api.stashPush(message.trim().length > 0 ? message.trim() : undefined);
    if (result.ok) {
      setMessage('');
      setNotice('已暂存当前改动');
      await reload();
      onChanged?.();
    } else {
      setNotice(result.error?.message ?? '暂存失败');
    }
  }, [api, message, reload, onChanged]);

  const applyEntry = useCallback(
    async (entry: GitStashEntry, drop: boolean) => {
      const result = drop
        ? await api.stashApply(entry.index, true)
        : await api.stashApply(entry.index, false);
      if (result.ok) {
        setNotice(
          drop
            ? `已恢复并删除 stash@{${entry.index}}`
            : `已恢复 stash@{${entry.index}}（保留记录）`,
        );
        await reload();
        onChanged?.();
      } else {
        setNotice(result.error?.message ?? '恢复暂存失败');
      }
    },
    [api, reload, onChanged],
  );

  const confirmDrop = useCallback(async () => {
    if (pendingDrop === null) return;
    const result = await api.stashDrop(pendingDrop.index);
    if (result.ok) {
      setNotice(`已删除 stash@{${pendingDrop.index}}`);
      setPendingDrop(null);
      await reload();
      onChanged?.();
    }
  }, [api, pendingDrop, reload, onChanged]);

  return (
    <div
      className="ec-stash-panel"
      data-testid="stash-panel"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div
        className="ec-stash-panel__new"
        style={{ display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <Input
          aria-label="暂存说明"
          placeholder="暂存说明（可选）"
          value={message}
          onChange={setMessage}
          data-testid="stash-message"
        />
        <Button size="sm" variant="primary" onClick={push} data-testid="stash-push">
          暂存当前改动
        </Button>
        {notice !== null && (
          <span
            role="status"
            style={{ color: 'var(--ec-color-text-secondary)' }}
            data-testid="stash-notice"
          >
            {notice}
          </span>
        )}
      </div>

      {loading && <span role="status">读取暂存中…</span>}

      {!loading && entries.length === 0 && (
        <EmptyState
          title="暂无暂存记录"
          description="「暂存当前改动」可以临时收起未完成的工作，之后再恢复。"
        />
      )}

      {!loading && entries.length > 0 && (
        <ul className="ec-stash-panel__list" data-testid="stash-list">
          {entries.map((entry) => (
            <li
              key={entry.index}
              className="ec-stash-panel__item"
              data-testid={`stash-item-${entry.index}`}
              style={{ display: 'flex', gap: 8, alignItems: 'center' }}
            >
              <Tag color="neutral">
                stash@{'{'}
                {entry.index}
                {'}'}
              </Tag>
              <span style={{ flex: 1 }}>{entry.message}</span>
              <span style={{ color: 'var(--ec-color-text-secondary)' }}>{entry.branch}</span>
              <span style={{ color: 'var(--ec-color-text-secondary)' }}>{entry.files} 个文件</span>
              <span
                style={{ color: 'var(--ec-color-text-secondary)' }}
                data-testid={`stash-time-${entry.index}`}
              >
                {formatTime(entry.createdAt)}
              </span>
              <button
                type="button"
                onClick={() => void applyEntry(entry, true)}
                data-testid={`stash-pop-${entry.index}`}
                style={linkBtn}
              >
                恢复并删除
              </button>
              <button
                type="button"
                onClick={() => void applyEntry(entry, false)}
                data-testid={`stash-apply-${entry.index}`}
                style={linkBtn}
              >
                仅恢复
              </button>
              <button
                type="button"
                onClick={() => setPendingDrop(entry)}
                data-testid={`stash-drop-${entry.index}`}
                style={{ ...linkBtn, color: 'var(--ec-color-danger)' }}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={pendingDrop !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDrop(null);
        }}
        title="删除暂存确认"
        footer={
          <>
            <Button size="sm" onClick={() => setPendingDrop(null)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={confirmDrop}
              data-testid="stash-drop-confirm"
            >
              删除
            </Button>
          </>
        }
      >
        <p>
          即将删除{' '}
          <code>
            stash@{'{'}
            {pendingDrop?.index ?? 0}
            {'}'}
          </code>
          {pendingDrop !== null && pendingDrop.message.length > 0
            ? `（${pendingDrop.message}）`
            : ''}
          。删除后这些改动不可恢复，确认继续？
        </p>
      </Modal>
    </div>
  );
}

const linkBtn = {
  background: 'none',
  border: 'none',
  color: 'var(--ec-color-info)',
  cursor: 'pointer',
  padding: '0 4px',
} as const;
