/**
 * 重命名历史（T7-04 要点 7，FR-UNI-12）。
 *
 * 按时间倒序渲染；已撤销行禁用撤销按钮；撤销前必须二次确认。
 */
import { useMemo } from 'react';

import type { RenameHistoryEntry } from '@ec/registry';
import { Button, EmptyState, Spinner, Tag } from '@ec/ui';

import './components.css';

export interface RenameHistoryProps {
  entries: readonly RenameHistoryEntry[];
  onUndo: (id: string) => void;
  loading?: boolean;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString();
}

export function RenameHistory(props: RenameHistoryProps): JSX.Element {
  const { entries, onUndo, loading = false } = props;

  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.at - a.at),
    [entries],
  );

  const handleUndo = (id: string): void => {
    if (window.confirm('确认撤销该次重命名？该操作会还原文件、文档、记忆与注册表，并生成一次撤销提交。')) {
      onUndo(id);
    }
  };

  return (
    <div className="ec-rename-root" data-testid="rename-history">
      {loading && (
        <div className="ec-rename-inline">
          <Spinner size={18} />
          <span>加载中…</span>
        </div>
      )}

      {!loading && sorted.length === 0 && (
        <EmptyState title="暂无重命名记录" description="执行过的重命名会出现在这里，可随时一键撤销" />
      )}

      {sorted.length > 0 && (
        <ul className="ec-rename-block" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {sorted.map((entry) => (
            <li className="ec-rename-batch-step" data-testid="history-row" key={entry.id}>
              <div className="ec-rename-inline">
                <strong>{entry.oldName}</strong>
                <span className="ec-rename-muted">→</span>
                <strong>{entry.newName}</strong>
                {entry.undone && <Tag color="neutral">已撤销</Tag>}
              </div>
              <div className="ec-rename-muted">
                <span>{formatTime(entry.at)}</span>
                <span> · 变更 {entry.changes} 处</span>
                {entry.commitSha !== null && <span> · commit {entry.commitSha}</span>}
              </div>
              <div className="ec-rename-actions">
                <Button
                  variant="ghost"
                  disabled={entry.undone}
                  data-testid="history-undo"
                  onClick={() => handleUndo(entry.id)}
                >
                  {entry.undone ? '已撤销' : '撤销'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
