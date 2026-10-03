import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, EmptyState, SearchInput, Select, SplitPane, Switch, Tag } from '@ec/ui';
import { LAYER_LABELS, type MemoryItem, type MemoryLayer, type MemoryPatch } from '@ec/memory';

import { BatchActions } from './BatchActions';
import { ChangeLogPanel } from './ChangeLogPanel';
import { ImportExportPanel } from './ImportExportPanel';
import { MemoryEditor } from './MemoryEditor';
import { MemoryList } from './MemoryList';
import {
  LAYER_NODE_PREFIX,
  MemoryTree,
  TAG_NODE_PREFIX,
  VIEW_NODE_PREFIX,
  type MemoryViewKey,
} from './MemoryTree';
import {
  useMemoryOptional,
  type ConflictAnnotation,
  type LayerMoveTarget,
  type MemoryDetail,
  type MemoryQuery,
  type MemoryStats,
} from './memory-api';
import type { ChangeLogRecord } from '@ec/memory';

/**
 * 记忆中心（FR-MEM-21）。
 *
 * 布局：左树（分层 / 标签 / 视图）+ 中列表 + 右编辑器与变更日志。
 * 所有数据经 `MemoryApi` 端口获取，组件本身不接触 SQLite —— 因此可以在 jsdom 里
 * 用内存假实现完整跑通交互（见 `__tests__/memory-center.test.tsx`）。
 */

export interface MemoryCenterProps {
  userId: string;
  height?: number;
}

export function MemoryCenter({ userId, height = 560 }: MemoryCenterProps): JSX.Element {
  const api = useMemoryOptional();

  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedLayer, setSelectedLayer] = useState<MemoryLayer | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [view, setView] = useState<MemoryViewKey | null>(null);
  const [text, setText] = useState('');
  const [orderBy, setOrderBy] = useState<NonNullable<MemoryQuery['orderBy']>>('updatedAt');
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastRemovedIds, setLastRemovedIds] = useState<string[]>([]);
  const [exportNames, setExportNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [tagPool, setTagPool] = useState<MemoryItem[]>([]);
  const [stats, setStats] = useState<MemoryStats>({
    layers: [],
    activeIssues: 0,
    longtermCount: 0,
    longtermLimit: 500,
  });
  const [conflicts, setConflicts] = useState<Record<string, ConflictAnnotation[]>>({});
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [changeLogs, setChangeLogs] = useState<ChangeLogRecord[]>([]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.listProjects().then((result) => {
      if (!cancelled) setProjects(result);
    });
    return () => {
      cancelled = true;
    };
  }, [api, revision]);

  // 项目切换后清空选中态，避免把上一个项目的条目编辑串到新项目
  useEffect(() => {
    setCheckedIds([]);
    setSelectedId(null);
    setLastRemovedIds([]);
  }, [projectId]);

  const query = useMemo<MemoryQuery>(() => {
    const base: MemoryQuery = {
      orderBy,
      direction: 'desc',
      limit: 200,
      ...(selectedLayer ? { layers: [selectedLayer] } : {}),
      ...(selectedTags.length > 0 ? { tags: selectedTags } : {}),
      ...(text.trim().length > 0 ? { text: text.trim() } : {}),
      ...(view === 'issues' ? { activeIssuesOnly: true, scopes: ['issue'] } : {}),
    };
    return base;
  }, [selectedLayer, selectedTags, text, orderBy, view]);

  // 所有查询经真实异步域 RPC；一次 revision 表示写操作完成后重新读取权威状态。
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    setItems([]);
    setTagPool([]);
    setStats({ layers: [], activeIssues: 0, longtermCount: 0, longtermLimit: 500 });
    setConflicts({});
    setChangeLogs([]);
    void Promise.all([
      api.list({ userId, projectId, query }),
      api.list({ userId, projectId, query: { limit: 500 } }),
      api.stats({ userId, projectId }),
      api.conflictIndex({ userId, projectId }),
      api.changeLog({ userId, ...(selectedId ? { memoryId: selectedId } : {}), limit: 50 }),
    ])
      .then(([nextItems, nextTagPool, nextStats, nextConflicts, nextChangeLogs]) => {
        if (cancelled) return;
        setItems(nextItems);
        setTagPool(nextTagPool);
        setStats(nextStats);
        setConflicts(nextConflicts);
        setChangeLogs(nextChangeLogs);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setNotice(`记忆数据读取失败：${cause instanceof Error ? cause.message : String(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [api, userId, projectId, query, selectedId, revision]);

  useEffect(() => {
    if (!api || !selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail((current) => (current?.item.id === selectedId ? current : null));
    void api.detail(selectedId).then((nextDetail) => {
      if (!cancelled) setDetail(nextDetail);
    });
    return () => {
      cancelled = true;
    };
  }, [api, selectedId, revision]);

  const allTags = [...new Set(tagPool.flatMap((item) => item.tags))].sort((a, b) =>
    a.localeCompare(b),
  );

  const selectedNodeId = useMemo(() => {
    if (view) return `${VIEW_NODE_PREFIX}${view}`;
    if (selectedLayer) return `${LAYER_NODE_PREFIX}${selectedLayer}`;
    return undefined;
  }, [view, selectedLayer]);

  const refreshNotice = useCallback((message: string) => {
    setNotice(message);
  }, []);

  const handleNodeSelect = useCallback((nodeId: string) => {
    if (nodeId.startsWith(LAYER_NODE_PREFIX)) {
      setSelectedLayer(nodeId.slice(LAYER_NODE_PREFIX.length) as MemoryLayer);
      setView(null);
      return;
    }
    if (nodeId.startsWith(TAG_NODE_PREFIX)) {
      const tag = nodeId.slice(TAG_NODE_PREFIX.length);
      setSelectedTags((prev) =>
        prev.includes(tag) ? prev.filter((entry) => entry !== tag) : [...prev, tag],
      );
      return;
    }
    if (nodeId.startsWith(VIEW_NODE_PREFIX)) {
      const next = nodeId.slice(VIEW_NODE_PREFIX.length) as MemoryViewKey;
      setView((prev) => (prev === next ? null : next));
      setSelectedLayer(null);
    }
  }, []);

  const handleSave = useCallback(
    async (patch: MemoryPatch, expectedVersion: number) => {
      if (!api || !selectedId) return;
      // 成功/冲突提示由编辑器自己给出（含版本冲突文案），这里不重复播报
      await api.update(selectedId, patch, expectedVersion);
      setRevision((value) => value + 1);
    },
    [api, selectedId],
  );

  const handleRemove = useCallback(
    async (ids: readonly string[]) => {
      if (!api) return;
      setBusy(true);
      try {
        const result = await api.remove(ids);
        setRevision((value) => value + 1);
        setLastRemovedIds(result.removedIds);
        setCheckedIds([]);
        setSelectedId(null);
        refreshNotice(`已删除 ${result.removedIds.length} 条，可撤销`);
      } finally {
        setBusy(false);
      }
    },
    [api, refreshNotice],
  );

  const handleUndoRemove = useCallback(async () => {
    if (!api) return;
    await api.restore(lastRemovedIds);
    setRevision((value) => value + 1);
    refreshNotice(`已恢复 ${lastRemovedIds.length} 条`);
    setLastRemovedIds([]);
  }, [api, lastRemovedIds, refreshNotice]);

  const handleMoveLayer = useCallback(
    async (target: LayerMoveTarget) => {
      if (!api) return;
      await api.moveLayer(checkedIds, target);
      setRevision((value) => value + 1);
      setCheckedIds([]);
      refreshNotice(
        `已移动 ${checkedIds.length} 条到「${LAYER_LABELS[target.scope === 'page' && target.elementId ? 'element' : target.scope]}」`,
      );
    },
    [api, checkedIds, refreshNotice],
  );

  const handleExport = useCallback(
    async (format: 'json' | 'markdown', includeArchived: boolean) => {
      if (!api) return;
      setBusy(true);
      try {
        const result = await api.exportMemories({ userId, projectId, format, includeArchived });
        setExportNames(result.files.map((file) => file.name));
      } finally {
        setBusy(false);
      }
    },
    [api, userId, projectId],
  );

  if (!api) {
    return (
      <EmptyState
        title="记忆中心尚未初始化"
        description="记忆数据保存在本机 SQLite 中，需等待外壳完成初始化后可用。"
      />
    );
  }

  return (
    <section className="ec-memory-center" aria-label="记忆中心">
      <header className="ec-memory-center__head">
        <Select
          options={[
            { value: '', label: '全部项目' },
            ...projects.map((project) => ({ value: project.id, label: project.name })),
          ]}
          value={projectId ?? ''}
          onChange={(value) => setProjectId(value === '' ? null : value)}
          aria-label="选择项目"
          className="ec-memory-center__project"
        />
        <SearchInput
          value={text}
          onChange={setText}
          placeholder="搜索标题、正文或标签"
          aria-label="搜索记忆"
        />
        <label className="ec-memory-center__order">
          <span>排序</span>
          <Select
            options={[
              { value: 'updatedAt', label: '最近更新' },
              { value: 'importance', label: '重要度' },
              { value: 'createdAt', label: '创建时间' },
              { value: 'title', label: '标题' },
            ]}
            value={orderBy}
            onChange={(value) => setOrderBy(value as NonNullable<MemoryQuery['orderBy']>)}
            aria-label="排序方式"
          />
        </label>
        <Switch
          checked={view === 'issues'}
          onChange={() => setView(view === 'issues' ? null : 'issues')}
          label="仅进行中问题"
        />
        {notice && (
          <span className="ec-memory-center__notice" role="status">
            {notice}
          </span>
        )}
      </header>

      <SplitPane
        direction="horizontal"
        initial={240}
        min={180}
        max={420}
        first={
          <MemoryTree
            stats={stats}
            tags={allTags}
            selectedTags={selectedTags}
            selectedNodeId={selectedNodeId}
            onSelect={handleNodeSelect}
            height={height - 40}
          />
        }
        second={
          <div className="ec-memory-center__main">
            <div className="ec-memory-center__filters">
              <span className="ec-memory-center__count">共 {items.length} 条</span>
              {selectedLayer && (
                <Tag color="primary">
                  {LAYER_LABELS[selectedLayer]}
                  <button
                    type="button"
                    aria-label="清除层级筛选"
                    onClick={() => setSelectedLayer(null)}
                  >
                    ×
                  </button>
                </Tag>
              )}
              {selectedTags.map((tag) => (
                <Tag key={tag} color="info">
                  {tag}
                  <button
                    type="button"
                    aria-label={`清除标签 ${tag}`}
                    onClick={() => setSelectedTags((prev) => prev.filter((entry) => entry !== tag))}
                  >
                    ×
                  </button>
                </Tag>
              ))}
              {(selectedLayer || selectedTags.length > 0 || text || view) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelectedLayer(null);
                    setSelectedTags([]);
                    setText('');
                    setView(null);
                  }}
                >
                  清除筛选
                </Button>
              )}
            </div>

            <BatchActions
              checkedIds={checkedIds}
              lastRemovedIds={lastRemovedIds}
              busy={busy}
              onExport={(format) => void handleExport(format, true)}
              onRemove={handleRemove}
              onUndoRemove={handleUndoRemove}
              onMoveLayer={handleMoveLayer}
              moveContext={projectId ? { projectId } : {}}
            />

            <SplitPane
              direction="horizontal"
              initial={300}
              min={220}
              max={560}
              first={
                <MemoryList
                  items={items}
                  height={height - 140}
                  selectedId={selectedId}
                  checkedIds={checkedIds}
                  conflicts={conflicts}
                  onSelect={setSelectedId}
                  onCheck={(id, checked) =>
                    setCheckedIds((prev) =>
                      checked ? [...prev, id] : prev.filter((entry) => entry !== id),
                    )
                  }
                />
              }
              second={
                detail ? (
                  <div className="ec-memory-center__detail">
                    <MemoryEditor
                      detail={detail}
                      onSave={handleSave}
                      onTogglePin={() => {
                        void api.setPinned(detail.item.id, !detail.item.pinned).then(() => {
                          setRevision((value) => value + 1);
                        });
                      }}
                      onSetIssueStatus={(next) => {
                        void api.setIssueStatus(detail.item.id, next).then(() => {
                          setRevision((value) => value + 1);
                        });
                      }}
                    />
                    <section className="ec-memory-center__changelog" aria-label="变更日志">
                      <h2>变更日志</h2>
                      <ChangeLogPanel records={changeLogs} height={180} />
                    </section>
                  </div>
                ) : (
                  <EmptyState title="未选择条目" description="从左侧选择一条记忆查看与编辑。" />
                )
              }
            />
          </div>
        }
      />

      <ImportExportPanel
        onExport={handleExport}
        onPreviewImport={(files) => api.importPreview({ userId, files })}
        onCommitImport={async (decisions) => {
          await api.importCommit({ userId, decisions });
          setRevision((value) => value + 1);
          refreshNotice('导入完成');
        }}
        lastExportNames={exportNames}
      />
    </section>
  );
}
