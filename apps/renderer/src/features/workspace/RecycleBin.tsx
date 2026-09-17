/**
 * RecycleBin（T9-01 / FR-WSP-05）：回收站。
 *
 * 语义：删除的项目保留 30 天，可恢复或彻底删除（彻底删除需再次确认）；
 * 支持一键清理超期条目（外壳也可在启动时自动清理）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState } from '@ec/ui';
import { RECYCLE_BIN_RETENTION_MS, type ProjectSummary } from '@ec/core';

import { formatTime, remainingDays } from './ProjectCard';
import { useWorkspace } from './workspace-api';

export interface RecycleBinProps {
  /** 恢复/彻底删除后通知外层刷新（最近打开、项目数等） */
  onChanged?: () => void;
  /** 时间源（测试注入，避免断言依赖真实时间） */
  now?: number;
}

export function RecycleBin({ onChanged, now }: RecycleBinProps): JSX.Element {
  const api = useWorkspace();
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [purging, setPurging] = useState<ProjectSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.listProjects({ view: 'recycleBin' }));
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = useCallback(
    async (id: string) => {
      await api.restoreFromRecycleBin(id);
      setNotice('已恢复该项目。');
      await load();
      onChanged?.();
    },
    [api, load, onChanged],
  );

  const purge = useCallback(async () => {
    if (!purging) return;
    await api.purgeProject(purging.id);
    setPurging(null);
    await load();
    onChanged?.();
  }, [api, load, onChanged, purging]);

  const cleanup = useCallback(async () => {
    const count = await api.cleanupExpiredRecycleBin();
    setNotice(count > 0 ? `已清理 ${count} 个超期项目。` : '没有超期项目需要清理。');
    await load();
    onChanged?.();
  }, [api, load, onChanged]);

  const current = now ?? Date.now();

  if (loading) return <p className="ec-ws__hint">正在加载回收站…</p>;
  if (error) return <p className="ec-ws__error">{error}</p>;
  if (items.length === 0) {
    return (
      <EmptyState title="回收站为空" description="删除的项目会在这里保留 30 天，期间可随时恢复。" />
    );
  }

  return (
    <section className="ec-ws__recycle" aria-label="回收站">
      <header className="ec-ws__recycle-head">
        <h2>{`回收站（${items.length}）`}</h2>
        <Button variant="ghost" size="sm" onClick={() => void cleanup()}>
          清理超期项目
        </Button>
      </header>

      {notice ? (
        <p className="ec-ws__notice" role="status">
          {notice}
        </p>
      ) : null}

      <ul className="ec-ws__recycle-list">
        {items.map((project) => {
          const days = remainingDays(project, current, RECYCLE_BIN_RETENTION_MS);
          return (
            <li key={project.id}>
              <span className="ec-ws__recycle-name">{project.name}</span>
              <span className="ec-ws__hint">
                {`删除于 ${project.deletedAt ? formatTime(project.deletedAt) : '未知'} · 剩余 ${days} 天`}
              </span>
              <Button size="sm" variant="secondary" onClick={() => void restore(project.id)}>
                恢复
              </Button>
              <Button size="sm" variant="danger" onClick={() => setPurging(project)}>
                彻底删除
              </Button>
            </li>
          );
        })}
      </ul>

      {purging ? (
        <div className="ec-ws__confirm" role="dialog" aria-label="彻底删除确认">
          <p>{`彻底删除《${purging.name}》后无法恢复，其设计、记忆、文档与代码将一并移除。`}</p>
          <div className="ec-ws__confirm-actions">
            <Button variant="ghost" onClick={() => setPurging(null)}>
              取消
            </Button>
            <Button variant="danger" onClick={() => void purge()}>
              彻底删除
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
