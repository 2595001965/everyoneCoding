/**
 * 工作台端口（T9-01）。
 *
 * 冻结契约：外壳把 `@ec/core` 的 `ProjectService`（含 SQLite 适配、模板落库、
 * Git 导入、文档解析入档、流水线阶段查询）注入到 `globalThis.__EC_WORKSPACE__`。
 *
 * 纯函数（模板清单、需求文档解析、七端矩阵）由渲染层直接 import `@ec/core` / `@ec/pipeline`，
 * 不必绕端口——它们无 IO。
 */

import { createContext, useContext, type ReactNode } from 'react';
import { WorkspaceWelcome } from './WorkspaceWelcome';

import type { WorkspaceImportProgress } from '@ec/shell-api';
import type {
  CreateProjectInput,
  DashboardMetrics,
  DuplicateOptions,
  DuplicateResult,
  MetricDetail,
  MetricKey,
  ProjectQuery,
  ProjectStageInfo,
  ProjectSummary,
  RequirementDigest,
  UpdateProjectPatch,
} from '@ec/core';

/* --------------------- 项目仪表盘（T9-02 / FR-WSP-06） --------------------- */

/**
 * 仪表盘与阶段视图的形状**由 `@ec/core` 统一定义**（`project/project-metrics.ts`）。
 *
 * 这些结构跨进程传递：主进程的 workspace 域运行时负责聚合，渲染层只做展示。
 * 两侧各写一份声明会在字段变更时静默漂移（主进程发了、渲染层解析不到），
 * 故上面从 `@ec/core` 取值、此处再导出，保持既有 import 路径继续可用。
 */
export type {
  DashboardMetrics,
  DuplicateResult,
  MetricDetail,
  MetricDetailRow,
  MetricKey,
  ProjectStageInfo,
} from '@ec/core';

/**
 * 导入进度形状同样跨进程（主进程按阶段推送、渲染层展示），
 * 声明在 `@ec/shell-api` 的域事件契约里；这里再导出让特性内沿用同一入口。
 */
export type { WorkspaceImportProgress };

export interface WorkspaceApi {
  listProjects(query?: ProjectQuery): Promise<ProjectSummary[]>;
  getProject(id: string): Promise<ProjectSummary | null>;
  createProject(input: CreateProjectInput): Promise<ProjectSummary>;
  updateProject(id: string, patch: UpdateProjectPatch): Promise<ProjectSummary | null>;
  markOpened(id: string): Promise<void>;
  archiveProject(id: string): Promise<void>;
  unarchiveProject(id: string): Promise<void>;
  moveToRecycleBin(id: string): Promise<void>;
  restoreFromRecycleBin(id: string): Promise<void>;
  purgeProject(id: string): Promise<void>;
  /** 清理超期回收站条目，返回清理数量 */
  cleanupExpiredRecycleBin(): Promise<number>;
  duplicateProject(id: string, options: DuplicateOptions): Promise<DuplicateResult>;

  /** 模板创建：落项目 + 初始页面 DSL + 项目记忆草稿 */
  createFromTemplate(input: {
    templateId: string;
    name: string;
    description?: string;
  }): Promise<ProjectSummary>;
  /** Git 导入：外壳执行 clone → inspect → 推断 → 建项目 */
  importFromGit(input: {
    url: string;
    projectName?: string;
    targetDir: string;
    /**
     * 过程反馈（三阶段：克隆 / 扫描 / 落库）。
     * 由域事件通道推送，`ratio` 仅在克隆阶段有值，其余阶段为 `null`（比例不可知）。
     */
    onProgress?: (progress: WorkspaceImportProgress) => void;
  }): Promise<ProjectSummary>;
  /** 文档导入：把解析出的功能清单落成功能/页面 + 项目记忆 */
  createFromDigest(input: { digest: RequirementDigest; name: string }): Promise<ProjectSummary>;

  /** 流水线阶段（卡片进度环） */
  getProjectStage(projectId: string): Promise<ProjectStageInfo | null>;
  /** 缩略图地址（无则返回 null，卡片显示占位） */
  getThumbnailUrl(projectId: string): Promise<string | null>;

  /**
   * 项目仪表盘五项指标（外壳负责聚合 SQL / DSL / 流水线 / usage / git log，
   * 并做缓存与增量刷新；渲染层只展示）。
   */
  getDashboardMetrics(projectId: string): Promise<DashboardMetrics>;
  /** 指标下钻明细 */
  getMetricDetail(projectId: string, key: MetricKey): Promise<MetricDetail>;
}

const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function WorkspaceApiProvider({
  api,
  children,
}: {
  api: WorkspaceApi | null;
  children: ReactNode;
}): JSX.Element {
  return <WorkspaceContext.Provider value={api}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspaceOptional(): WorkspaceApi | null {
  return useContext(WorkspaceContext);
}

export function useWorkspace(): WorkspaceApi {
  const api = useContext(WorkspaceContext);
  if (!api) throw new Error('工作台端口未注入：请先在外壳中装配 globalThis.__EC_WORKSPACE__');
  return api;
}

export function WorkspaceUnavailable(): JSX.Element {
  return <WorkspaceWelcome />;
}

export function readInjectedWorkspaceApi(): WorkspaceApi | null {
  const injected = (globalThis as { __EC_WORKSPACE__?: WorkspaceApi }).__EC_WORKSPACE__;
  return injected ?? null;
}
