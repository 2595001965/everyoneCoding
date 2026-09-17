import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, EmptyState, Modal, SearchInput, Table, Tabs, type Column } from '@ec/ui';
import { TARGET_PLATFORM_LABELS } from '@ec/pipeline';
import type { ProjectSortKey, ProjectSummary } from '@ec/core';
import { AppIcon } from '../../layout/AppIcon';
import { RecycleBin } from './RecycleBin';
import { ProjectCard, formatTime } from './ProjectCard';
import { OnboardingCard } from './OnboardingCard';
import { useWorkspace, type ProjectStageInfo } from './workspace-api';

export const GRID_WINDOW_SIZE = 48;
const DETAIL_CONCURRENCY = 8;

export interface WorkspaceHomeProps {
  onOpenProject: (id: string) => void;
  onOpenSettings: (id: string) => void;
  onCreateProject?: (() => void) | undefined;
}
interface ProjectDetail {
  thumbnailUrl: string | null;
  stage: ProjectStageInfo | null;
}

export function WorkspaceHome({
  onOpenProject,
  onOpenSettings,
  onCreateProject,
}: WorkspaceHomeProps): JSX.Element {
  const api = useWorkspace();
  const [tab, setTab] = useState('active');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [details, setDetails] = useState<Record<string, ProjectDetail>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState<ProjectSortKey>('updatedAt');
  const [keyword, setKeyword] = useState('');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [windowSize, setWindowSize] = useState(GRID_WINDOW_SIZE);
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const [recent, setRecent] = useState<ProjectSummary[]>([]);
  const [revision, setRevision] = useState(0);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const pendingActions = useRef(new Set<string>());
  const detailCache = useRef(new Set<string>());
  const filtered = Boolean(keyword.trim()) || pinnedOnly;
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  // Each query owns its result. Late responses cannot replace a newer search or tab.
  useEffect(() => {
    if (tab === 'recycle') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .listProjects({
        view: tab === 'archived' ? 'archived' : 'active',
        sort,
        ...(keyword.trim() ? { search: keyword.trim() } : {}),
        ...(pinnedOnly ? { pinnedOnly: true } : {}),
      })
      .then((list) => {
        if (cancelled) return;
        detailCache.current.clear();
        setDetails({});
        setProjects(list);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, keyword, pinnedOnly, sort, tab, revision]);

  // Recent items are optional and must never block the main project list.
  useEffect(() => {
    let cancelled = false;
    void api
      .listProjects({ recentLimit: 10 })
      .then((list) => {
        if (!cancelled) setRecent(list);
      })
      .catch(() => {
        if (!cancelled) setRecent([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, revision]);

  useEffect(() => {
    setWindowSize(GRID_WINDOW_SIZE);
  }, [keyword, pinnedOnly, sort, tab]);

  useEffect(() => {
    if (loading || tab === 'recycle') return;
    const visible = view === 'grid' ? projects.slice(0, windowSize) : projects;
    const need = visible.filter((project) => !detailCache.current.has(project.id));
    let cancelled = false;
    const run = async (): Promise<void> => {
      for (let index = 0; index < need.length; index += DETAIL_CONCURRENCY) {
        if (cancelled) return;
        const results = await Promise.all(
          need
            .slice(index, index + DETAIL_CONCURRENCY)
            .map(async (project): Promise<[string, ProjectDetail]> => {
              const [thumbnail, stage] = await Promise.allSettled([
                api.getThumbnailUrl(project.id),
                api.getProjectStage(project.id),
              ]);
              return [
                project.id,
                {
                  thumbnailUrl: thumbnail.status === 'fulfilled' ? thumbnail.value : null,
                  stage: stage.status === 'fulfilled' ? stage.value : null,
                },
              ];
            }),
        );
        if (cancelled) return;
        for (const [id] of results) detailCache.current.add(id);
        setDetails((previous) => ({ ...previous, ...Object.fromEntries(results) }));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [api, projects, view, windowSize, loading, tab]);

  const visibleProjects = useMemo(
    () => (view === 'grid' ? projects.slice(0, windowSize) : projects),
    [projects, view, windowSize],
  );

  const mutate = useCallback(
    async (id: string, action: () => Promise<unknown>): Promise<boolean> => {
      if (pendingActions.current.has(id)) return false;
      pendingActions.current.add(id);
      setBusyIds(new Set(pendingActions.current));
      setActionError(null);
      try {
        await action();
        reload();
        return true;
      } catch (cause: unknown) {
        setActionError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        pendingActions.current.delete(id);
        setBusyIds(new Set(pendingActions.current));
      }
    },
    [reload],
  );

  const archive = (id: string) =>
    void mutate(id, () => (tab === 'archived' ? api.unarchiveProject(id) : api.archiveProject(id)));
  const requestDelete = (project: ProjectSummary) => {
    setActionError(null);
    setPendingDelete(project);
  };
  const confirmDelete = async () => {
    if (
      pendingDelete &&
      (await mutate(pendingDelete.id, () => api.moveToRecycleBin(pendingDelete.id)))
    )
      setPendingDelete(null);
  };

  const columns: Column<ProjectSummary>[] = [
    { key: 'name', title: '项目', render: (row) => row.name },
    {
      key: 'platforms',
      title: '目标端',
      width: 170,
      render: (row) =>
        row.targetPlatforms.map((platform) => TARGET_PLATFORM_LABELS[platform]).join('、') ||
        '未选',
    },
    {
      key: 'stage',
      title: '流水线阶段',
      width: 110,
      render: (row) => details[row.id]?.stage?.stage ?? '未开始',
    },
    { key: 'updatedAt', title: '更新时间', width: 160, render: (row) => formatTime(row.updatedAt) },
    {
      key: 'actions',
      title: '操作',
      width: 170,
      render: (row) => (
        <span
          className="ec-ws__row-actions"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => onOpenSettings(row.id)}>
            设置
          </button>
          <button type="button" disabled={busyIds.has(row.id)} onClick={() => archive(row.id)}>
            {tab === 'archived' ? '取消归档' : '归档'}
          </button>
          <button
            type="button"
            disabled={busyIds.has(row.id)}
            className="ec-ws__danger"
            onClick={() => requestDelete(row)}
          >
            删除
          </button>
        </span>
      ),
    },
  ];

  return (
    <section className="ec-ws" aria-label="工作台">
      <header className="ec-ws__head">
        <div>
          <span className="ec-eyebrow">YOUR CREATIVE WORKSPACE</span>
          <h1>工作台</h1>
          <p className="ec-ws__subtitle">管理你的项目，继续每一个未完成的灵感。</p>
        </div>
        {onCreateProject && (
          <Button variant="primary" onClick={onCreateProject}>
            <AppIcon name="plus" size={16} />
            新建项目
          </Button>
        )}
      </header>
      <div className="ec-ws__subnav">
        <Tabs
          items={[
            { key: 'active', label: '项目' },
            { key: 'archived', label: '归档' },
            { key: 'recycle', label: '回收站' },
          ]}
          value={tab}
          onChange={setTab}
          // eslint-disable-next-line react/no-children-prop -- Tabs uses a render prop.
          children={() => null}
        />
        {tab !== 'recycle' && (
          <span className="ec-ws__count">
            {loading ? '正在加载…' : `${projects.length} 个项目`}
          </span>
        )}
      </div>
      {tab !== 'recycle' && (
        <div className="ec-ws__toolbar">
          <SearchInput
            value={keyword}
            onChange={setKeyword}
            placeholder="搜索项目名称…"
            aria-label="搜索项目"
          />
          <Checkbox checked={pinnedOnly} onChange={setPinnedOnly} label="仅看收藏" />
          <label className="ec-ws__sort">
            <span>排序</span>
            <select
              aria-label="排序方式"
              value={sort}
              onChange={(event) => setSort(event.target.value as ProjectSortKey)}
            >
              <option value="updatedAt">按更新时间</option>
              <option value="createdAt">按创建时间</option>
              <option value="name">按名称</option>
            </select>
          </label>
          <Button
            variant="ghost"
            onClick={() => setView((previous) => (previous === 'grid' ? 'list' : 'grid'))}
            aria-label={view === 'grid' ? '切换为列表视图' : '切换为网格视图'}
          >
            <AppIcon name={view === 'grid' ? 'docs' : 'workspace'} size={16} />
            {view === 'grid' ? '列表视图' : '网格视图'}
          </Button>
        </div>
      )}
      {actionError && !pendingDelete && (
        <p className="ec-ws__error" role="alert">
          {actionError}
        </p>
      )}
      {tab === 'recycle' ? (
        <RecycleBin onChanged={reload} />
      ) : (
        <>
          {recent.length > 0 && tab === 'active' && !filtered && (
            <section className="ec-ws__recent" aria-label="最近打开">
              <h2>最近打开</h2>
              <ul>
                {recent.map((project) => (
                  <li key={project.id}>
                    <button type="button" onClick={() => onOpenProject(project.id)}>
                      <AppIcon name="workspace" size={14} />
                      {project.name}
                      <AppIcon name="arrow" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {loading ? (
            <div className="ec-ws__skeleton" aria-label="加载中">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="ec-ws__skeleton-card" />
              ))}
            </div>
          ) : error ? (
            <div className="ec-ws__load-error" role="alert">
              <h2>项目加载失败</h2>
              <p>{error}</p>
              <Button onClick={reload}>重新加载</Button>
            </div>
          ) : visibleProjects.length === 0 ? (
            <>
              {tab === 'active' && !filtered && (
                <OnboardingCard onCreateProject={() => onCreateProject?.()} />
              )}
              <EmptyState
                icon={<AppIcon name={filtered ? 'search' : 'workspace'} size={32} />}
                title={
                  filtered ? '没有匹配的项目' : tab === 'archived' ? '没有归档项目' : '还没有项目'
                }
                description={
                  filtered
                    ? '试试其他关键词，或清除筛选条件查看全部项目。'
                    : tab === 'archived'
                      ? '归档的项目会显示在这里，可随时恢复。'
                      : '从一个想法开始，新建项目或导入已有作品。'
                }
                action={
                  filtered ? (
                    <Button
                      onClick={() => {
                        setKeyword('');
                        setPinnedOnly(false);
                      }}
                    >
                      清除筛选
                    </Button>
                  ) : undefined
                }
              />
            </>
          ) : view === 'grid' ? (
            <>
              <div className="ec-ws__grid" aria-label="项目网格">
                {visibleProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    thumbnailUrl={details[project.id]?.thumbnailUrl ?? null}
                    stage={details[project.id]?.stage ?? null}
                    selected={false}
                    busy={busyIds.has(project.id)}
                    archived={tab === 'archived'}
                    onOpen={onOpenProject}
                    onOpenSettings={onOpenSettings}
                    onTogglePinned={(id, pinned) =>
                      void mutate(id, () => api.updateProject(id, { pinned }))
                    }
                    onArchive={archive}
                    onDelete={() => requestDelete(project)}
                  />
                ))}
              </div>
              {projects.length > windowSize && (
                <div className="ec-ws__more">
                  <Button
                    variant="secondary"
                    onClick={() => setWindowSize((previous) => previous + GRID_WINDOW_SIZE)}
                  >{`加载更多（已显示 ${visibleProjects.length} / ${projects.length}）`}</Button>
                </div>
              )}
            </>
          ) : (
            <Table
              aria-label="项目列表"
              columns={columns}
              rows={visibleProjects}
              rowKey={(row) => row.id}
              rowHeight={52}
              height={420}
              onRowSelect={(_key, row) => onOpenProject(row.id)}
            />
          )}
        </>
      )}
      <Modal
        open={pendingDelete !== null}
        title="删除项目确认"
        size="sm"
        onOpenChange={(open) => {
          if (!open && !busyIds.has(pendingDelete?.id ?? '')) {
            setPendingDelete(null);
            setActionError(null);
          }
        }}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busyIds.has(pendingDelete?.id ?? '')}
              onClick={() => {
                setPendingDelete(null);
                setActionError(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              disabled={busyIds.has(pendingDelete?.id ?? '')}
              onClick={() => void confirmDelete()}
            >
              {busyIds.has(pendingDelete?.id ?? '') ? '正在删除…' : '确认删除'}
            </Button>
          </>
        }
      >
        <p>{`确认删除《${pendingDelete?.name ?? ''}》？删除后进入回收站，保留 30 天可恢复。`}</p>
        {actionError && (
          <p className="ec-ws__error" role="alert">
            {actionError}
          </p>
        )}
      </Modal>
    </section>
  );
}
