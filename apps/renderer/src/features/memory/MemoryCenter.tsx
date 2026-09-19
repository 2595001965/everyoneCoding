import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, EmptyState, SearchInput, Select, SplitPane, Switch, Tag } from '@ec/ui';
import { LAYER_LABELS, type MemoryLayer, type MemoryPatch } from '@ec/memory';

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

  const projects = api ? api.listProjects() : [];

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

  /**
   * 数据读取直接放在渲染期，不做 memo 缓存。
   *
   * 理由：端口上的读取是**同步的本地查询**（SQLite 内存表 / 个位毫秒级），
   * 缓存反而带来两个问题 —— 写操作后必须手动失效（否则列表不刷新），
   * 且依赖数组会被 lint 判为"多余依赖"。直接读既天然正确，也少一层状态同步。
   */
  const items = api ? api.list({ userId, projectId, query }) : [];

  // 标签池：不受关键字与标签筛选影响，否则勾掉一个标签后它就再也点不回来
  const tagPool = api ? api.list({ userId, projectId, query: { limit: 500 } }) : [];
  const allTags = [...new Set(tagPool.flatMap((item) => item.tags))].sort((a, b) =>
    a.localeCompare(b),
  );

  const stats: MemoryStats = api
    ? api.stats({ userId, projectId })
    : { layers: [], activeIssues: 0, longtermCount: 0, longtermLimit: 500 };

  const conflicts: Record<string, ConflictAnnotation[]> = api
    ? api.conflictIndex({ userId, projectId })
    : {};

  const detail: MemoryDetail | null = api && selectedId ? api.detail(selectedId) : null;

  const changeLogs: ChangeLogRecord[] = api
    ? api.changeLog({ userId, ...(selectedId ? { memoryId: selectedId } : {}), limit: 50 })
    : [];

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
      api.update(selectedId, patch, expectedVersion);
    },
    [api, selectedId],
  );

  const handleRemove = useCallback(
    async (ids: readonly string[]) => {
      if (!api) return;
      setBusy(true);
      try {
        const result = api.remove(ids);
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
    api.restore(lastRemovedIds);
    refreshNotice(`已恢复 ${lastRemovedIds.length} 条`);
    setLastRemovedIds([]);
  }, [api, lastRemovedIds, refreshNotice]);

  const handleMoveLayer = useCallback(
    async (target: LayerMoveTarget) => {
      if (!api) return;
      api.moveLayer(checkedIds, target);
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
                        api.setPinned(detail.item.id, !detail.item.pinned);
                      }}
                      onSetIssueStatus={(next) => {
                        api.setIssueStatus(detail.item.id, next);
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
          refreshNotice('导入完成');
        }}
        lastExportNames={exportNames}
      />
    </section>
  );
}
