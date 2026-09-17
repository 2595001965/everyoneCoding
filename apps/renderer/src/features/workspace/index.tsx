/**
 * 工作台页面（T9-01 / T9-02）：首页 / 项目设置 / 项目仪表盘 三视图组合。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@ec/ui';
import type { ProjectSummary } from '@ec/core';

import { NewProjectDialog } from './NewProjectDialog';
import { ProjectDashboard } from './ProjectDashboard';
import { ProjectSettings } from './ProjectSettings';
import { WorkspaceHome } from './WorkspaceHome';
import {
  WorkspaceApiProvider,
  WorkspaceUnavailable,
  useWorkspaceOptional,
  type WorkspaceApi,
} from './workspace-api';

import './workspace.css';

type WorkspaceView = 'home' | 'settings' | 'dashboard';

export interface WorkspacePageProps {
  api: WorkspaceApi | null;
  /** 打开项目（进入设计器/流水线，由外壳路由决定） */
  onOpenProject?: ((projectId: string) => void) | undefined;
  /** 下钻跳转（记忆中心 / Git 等） */
  onOpenRef?: ((key: string, refId: string | undefined, label: string) => void) | undefined;
}

function WorkspaceWorkspace({
  onOpenProject,
  onOpenRef,
}: Pick<WorkspacePageProps, 'onOpenProject' | 'onOpenRef'>): JSX.Element {
  const api = useWorkspaceOptional();
  const [view, setView] = useState<WorkspaceView>('home');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectRevision, setProjectRevision] = useState(0);

  useEffect(() => {
    if (!api || projectId === null || view !== 'settings') return;
    let cancelled = false;
    setProjectError(null);
    setProject(null);
    void api
      .getProject(projectId)
      .then((found) => {
        if (cancelled) return;
        setProject(found);
        if (!found) setProjectError('项目不存在或已被删除，请返回项目列表。');
      })
      .catch((cause: unknown) => {
        if (!cancelled) setProjectError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, projectId, view, projectRevision]);

  const openSettings = useCallback((id: string) => {
    setProject(null);
    setProjectError(null);
    setProjectId(id);
    setView('settings');
  }, []);

  const openDashboard = useCallback((id: string) => {
    setProjectId(id);
    setView('dashboard');
  }, []);

  const openProject = useCallback(
    (id: string) => {
      void api?.markOpened(id);
      onOpenProject?.(id);
    },
    [api, onOpenProject],
  );

  return (
    <div className="ec-ws-page">
      <nav className="ec-ws-page__nav" aria-label="工作台导航">
        <button
          type="button"
          data-active={view === 'home' ? 'true' : 'false'}
          onClick={() => setView('home')}
        >
          项目
        </button>
        <button
          type="button"
          data-active={view === 'dashboard' ? 'true' : 'false'}
          disabled={projectId === null}
          onClick={() => {
            if (projectId !== null) openDashboard(projectId);
          }}
        >
          仪表盘
        </button>
        {view !== 'home' ? (
          <Button size="sm" variant="ghost" onClick={() => setView('home')}>
            返回列表
          </Button>
        ) : null}
      </nav>

      {view === 'home' ? (
        <WorkspaceHome
          onOpenProject={openProject}
          onOpenSettings={openSettings}
          onCreateProject={() => setNewOpen(true)}
        />
      ) : null}

      {view === 'settings' && project ? (
        <ProjectSettings key={project.id} project={project} onCancel={() => setView('home')} />
      ) : null}
      {view === 'settings' && !project ? (
        projectError ? (
          <div role="alert">
            <p className="ec-ws__error">{projectError}</p>
            <Button onClick={() => setProjectRevision((value) => value + 1)}>重新加载项目</Button>
          </div>
        ) : (
          <p role="status">正在加载项目设置…</p>
        )
      ) : null}

      {view === 'dashboard' && projectId ? (
        <ProjectDashboard
          projectId={projectId}
          onOpenRef={(key, refId, label) => onOpenRef?.(key, refId, label)}
        />
      ) : null}

      <NewProjectDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(created) => {
          setNewOpen(false);
          openSettings(created.id);
        }}
      />
    </div>
  );
}

/** 工作台页面：未注入端口时展示装配引导 */
export function WorkspacePage({ api, onOpenProject, onOpenRef }: WorkspacePageProps): JSX.Element {
  if (!api) return <WorkspaceUnavailable />;
  return (
    <WorkspaceApiProvider api={api}>
      <WorkspaceWorkspace
        {...(onOpenProject !== undefined ? { onOpenProject } : {})}
        {...(onOpenRef !== undefined ? { onOpenRef } : {})}
      />
    </WorkspaceApiProvider>
  );
}

export { WorkspaceHome } from './WorkspaceHome';
export { ProjectCard } from './ProjectCard';
export { NewProjectDialog } from './NewProjectDialog';
export {
  OnboardingCard,
  type OnboardingApi,
  type OnboardingProgress,
  ONBOARDING_PORT_KEY,
} from './OnboardingCard';
export { ProjectSettings, TargetPlatformPicker } from './ProjectSettings';
export { RecycleBin } from './RecycleBin';
export { ProjectDashboard } from './ProjectDashboard';
export { MetricsCard } from './MetricsCard';
export { DrilldownPanel } from './DrilldownPanel';
export {
  TARGETS_CHANGED_EVENT,
  buildCanvasPresets,
  buildTargetsPayload,
  emitTargetsChanged,
  onTargetsChanged,
  type CanvasPresetHint,
  type TargetsChangedPayload,
} from './workspace-events';
export {
  WorkspaceApiProvider,
  WorkspaceUnavailable,
  readInjectedWorkspaceApi,
  useWorkspace,
  useWorkspaceOptional,
  type DashboardMetrics,
  type DuplicateResult,
  type MetricDetail,
  type MetricKey,
  type ProjectStageInfo,
  type WorkspaceApi,
} from './workspace-api';
