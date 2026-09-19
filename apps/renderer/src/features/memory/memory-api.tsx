import { createContext, useContext, type ReactNode } from 'react';

import type {
  ChangeLogRecord,
  ConflictStrategy,
  CoverageMark,
  IssueStatus,
  MemoryItem,
  MemoryLayer,
  MemoryPatch,
  MemoryScope,
  MemoryStatus,
  MemoryViolation,
} from '@ec/memory';

/**
 * 记忆中心对存储层的依赖（端口）。
 *
 * 渲染层只认这个接口，不直接 import SQLite / DAO：
 * - 生产环境由外壳（Electron 主进程 / Tauri 命令层）注入实现
 * - 组件测试用内存假实现，既不牵扯 SQLite，也不依赖浏览器 API
 *
 * 这与设置页的 `AiSettingsApi` 是同一套做法，便于双形态外壳共用。
 */

/* ---------------------------- 查询 ---------------------------- */

export type MemoryOrderBy = 'importance' | 'updatedAt' | 'createdAt' | 'title';

export interface MemoryQuery {
  /** 解析层级过滤（element 表示页面记忆 + 元素备注） */
  layers?: readonly MemoryLayer[];
  scopes?: readonly MemoryScope[];
  tags?: readonly string[];
  status?: MemoryStatus | readonly MemoryStatus[];
  /** 仅看"进行中问题" */
  activeIssuesOnly?: boolean;
  /** 搜索关键字（接 T2-03 检索前的本地兜底） */
  text?: string;
  orderBy?: MemoryOrderBy;
  direction?: 'asc' | 'desc';
  limit?: number;
}

export interface MemoryLayerCount {
  layer: MemoryLayer;
  total: number;
}

export interface MemoryStats {
  layers: MemoryLayerCount[];
  /** 进行中的问题记忆条数（记忆中心高亮角标） */
  activeIssues: number;
  longtermCount: number;
  longtermLimit: number;
}

export interface ProjectOption {
  id: string;
  name: string;
}

/** 冲突来源标注（T2-01 的冲突溯源，供 ConflictBadge 展开显示） */
export interface ConflictAnnotation {
  role: 'winner' | 'loser';
  /** 对端条目 id */
  counterpartId: string;
  counterpartTitle: string;
  counterpartLayer: MemoryLayer;
  /** 冲突字段名（title 或 structured 叶子路径） */
  field: string;
  /** 本条目在该字段上的取值 */
  ownValue: unknown;
  /** 对端在该字段上的取值 */
  counterpartValue: unknown;
}

/** 条目详情：条目 + 冲突标注 + 覆盖汇总 */
export interface MemoryDetail {
  item: MemoryItem;
  conflicts: ConflictAnnotation[];
  coverage: CoverageMark | null;
  /** 归属不变量违规提示（正常为空） */
  violations: MemoryViolation[];
}

/** 上下文视图（继承与覆盖的完整链路，供"这条来自哪一层"展开） */
export interface ContextView {
  layers: Array<{ layer: MemoryLayer; items: MemoryItem[] }>;
  effectiveIds: string[];
  overriddenIds: string[];
  conflictCount: number;
}

/* ---------------------------- 编辑与批量 ---------------------------- */

export interface MemoryDraft {
  userId: string;
  scope: MemoryScope;
  title: string;
  projectId?: string | null;
  featureId?: string | null;
  pageId?: string | null;
  elementId?: string | null;
  issueId?: string | null;
  content?: string;
  structured?: Record<string, unknown> | null;
  tags?: string[];
  importance?: number;
  confidence?: number;
  pinned?: boolean;
  issueStatus?: IssueStatus | null;
}

/** 层级移动目标（"移动层级"批量操作的入参） */
export interface LayerMoveTarget {
  scope: MemoryScope;
  projectId?: string | null;
  featureId?: string | null;
  pageId?: string | null;
  elementId?: string | null;
  issueId?: string | null;
}

export interface BatchRemoveResult {
  /** 可撤销令牌：调用 restore(removed) 即恢复 */
  removedIds: string[];
}

/* ---------------------------- 导入导出 ---------------------------- */

export type MemoryExportFormat = 'json' | 'markdown';

export interface MemoryExportRequest {
  userId: string;
  projectId: string | null;
  format: MemoryExportFormat;
  includeArchived: boolean;
}

export interface MemoryExportResult {
  /** 文件基名（外壳负责落盘位置），Markdown 时为相对路径 */
  files: Array<{ name: string; content: string }>;
}

export type ImportClassification = 'added' | 'conflicted' | 'unchanged' | 'missing';
export type ImportResolution = ConflictStrategy | 'keepBoth';

export interface ImportPreviewRow {
  id: string;
  title: string;
  classification: ImportClassification;
  localTitle: string | null;
  incomingTitle: string | null;
  localUpdatedAt: number | null;
  incomingUpdatedAt: number | null;
}

export interface ImportPreviewModel {
  rows: ImportPreviewRow[];
  counts: Record<ImportClassification, number>;
}

export interface ImportCommitRequest {
  userId: string;
  decisions: Array<{ id: string; resolution: ImportResolution }>;
}

export interface ImportCommitResult {
  created: number;
  updated: number;
  superseded: number;
}

/* ---------------------------- 取消/撤销 ---------------------------- */

export interface MemoryApi {
  listProjects(): ProjectOption[];
  stats(input: { userId: string; projectId: string | null }): MemoryStats;

  list(input: { userId: string; projectId: string | null; query: MemoryQuery }): MemoryItem[];
  detail(id: string): MemoryDetail | null;
  /**
   * 冲突索引（memoryId → 该条目的冲突标注）。
   * 一次调用拿到整批条目的覆盖关系，避免列表逐条查询。
   */
  conflictIndex(input: {
    userId: string;
    projectId: string | null;
  }): Record<string, ConflictAnnotation[]>;
  context(input: {
    userId: string;
    projectId: string;
    featureId?: string | null;
    pageId?: string | null;
    elementId?: string | null;
  }): ContextView;

  create(draft: MemoryDraft): MemoryItem;
  update(id: string, patch: MemoryPatch, expectedVersion?: number): MemoryItem;
  setPinned(id: string, pinned: boolean): MemoryItem;
  setIssueStatus(id: string, next: IssueStatus, options?: { explicit?: boolean }): MemoryItem;
  moveLayer(ids: readonly string[], target: LayerMoveTarget): MemoryItem[];

  /** 批量删除（调用方应先经二次确认）；返回可撤销令牌 */
  remove(ids: readonly string[]): BatchRemoveResult;
  /** 撤销一次批量删除 */
  restore(ids: readonly string[]): void;

  changeLog(input: { userId: string; memoryId?: string; limit?: number }): ChangeLogRecord[];

  exportMemories(request: MemoryExportRequest): Promise<MemoryExportResult>;
  importPreview(input: {
    userId: string;
    files: Array<{ name: string; content: string }>;
  }): Promise<ImportPreviewModel>;
  importCommit(request: ImportCommitRequest): Promise<ImportCommitResult>;
}

const MemoryContext = createContext<MemoryApi | null>(null);

export interface MemoryProviderProps {
  api: MemoryApi | null;
  children: ReactNode;
}

export function MemoryProvider({ api, children }: MemoryProviderProps): JSX.Element {
  return <MemoryContext.Provider value={api}>{children}</MemoryContext.Provider>;
}

/** 取实现；未注入返回 null（页面据此展示初始化引导而不是崩溃） */
export function useMemoryOptional(): MemoryApi | null {
  return useContext(MemoryContext);
}

export function useMemory(): MemoryApi {
  const api = useMemoryOptional();
  if (!api) throw new Error('记忆中心未初始化：请先注入 MemoryApi');
  return api;
}
