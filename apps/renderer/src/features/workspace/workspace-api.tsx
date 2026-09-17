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

import type {
  CreateProjectInput,
  DuplicateOptions,
  ProjectQuery,
  ProjectSummary,
  RequirementDigest,
  UpdateProjectPatch,
} from '@ec/core';

/** 复制结果（含各资源计数，供 UI 展示"复制了什么"） */
export interface DuplicateResult {
  project: ProjectSummary;
  copied: { design: number; memory: number; docs: number; codeFiles: number };
}

/** 流水线阶段（进度环用；null 表示项目尚未进入流水线） */
export interface ProjectStageInfo {
  stage: string;
  status: string;
  /** 已确认阶段数 / 总阶段数（用于进度环比例） */
  confirmed: number;
  total: number;
}

/* --------------------- 项目仪表盘（T9-02 / FR-WSP-06） --------------------- */

/** 五项指标的聚合结果 */
export interface DashboardMetrics {
  /** 记忆条目数（按五层分组） */
  memory: { total: number; byScope: Record<string, number> };
  /** 页面数（按端分组） */
  pages: { total: number; byPlatform: Record<string, number> };
  /** 功能完成度 */
  features: { done: number; total: number; completion: number };
  /** AI 调用量与成本（本期 / 累计，按模型分组） */
  usage: {
    periodLabel: string;
    periodTokens: number;
    periodCost: number;
    totalTokens: number;
    totalCost: number;
    byModel: Array<{ modelId: string; tokens: number; cost: number }>;
  };
  /** 最近 Git 提交（最多 5 条） */
  git: { recent: Array<{ sha: string; message: string; author: string; at: number }> };
  /** 聚合计算耗时（毫秒，性能口径） */
  computeMs: number;
}

/** 指标键 */
export type MetricKey = 'memory' | 'pages' | 'features' | 'usage' | 'git';

/** 下钻明细行 */
export interface MetricDetailRow {
  label: string;
  value: string;
  /** 关联对象 id（如记忆 scope 筛选、页面 id），供跳转 */
  refId?: string | undefined;
}

/** 下钻明细 */
export interface MetricDetail {
  key: MetricKey;
  title: string;
  rows: MetricDetailRow[];
}

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
    onProgress?: (ratio: number, message: string) => void;
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
