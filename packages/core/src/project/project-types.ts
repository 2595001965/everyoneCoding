/**
 * 项目域类型与端口（T9-01）。
 *
 * 约束：
 * - 本域是 core 的浏览器可达模块：禁止运行时依赖 `@ec/data` / `@ec/git` / `@ec/memory`
 *   （better-sqlite3 / node:fs 会污染渲染层浏览器构建）。
 * - 存储经 `ProjectStore` 端口注入，由外壳（Wave 9/10 装配）适配到 SQLite Repository。
 * - 行结构与 `@ec/data` 的 ProjectRow 对齐（target_platforms 等以序列化 JSON 文本传输），
 *   领域对象统一使用 camelCase 的解析后形状（`ProjectSummary`）。
 */

/**
 * 目标端七端（FR-AI-13）。
 *
 * 注意：core 不依赖 @ec/pipeline（pipeline 依赖 core，反向会循环），
 * 此处为本地镜像类型；渲染层测试断言其与 `TARGET_PLATFORMS`（@ec/pipeline
 * tech-choice-questionnaire）逐字面量对齐，防漂移。
 */
export const TARGET_PLATFORM_KEYS = ['web', 'android', 'ios', 'harmonyos', 'windows', 'linux', 'macos'] as const;
export type TargetPlatform = (typeof TARGET_PLATFORM_KEYS)[number];

/** 项目来源（四类新建来源） */
export type ProjectSourceKind = 'blank' | 'template' | 'git_import' | 'doc_import';

/** 项目业务状态：active 正常 / archived 归档（归档 ≠ 删除，删除走回收站） */
export type ProjectStatus = 'active' | 'archived';

/** 项目列表排序键 */
export type ProjectSortKey = 'updatedAt' | 'createdAt' | 'name';

/** 项目列表视图 */
export type ProjectView = 'active' | 'archived' | 'recycleBin';

/** 技术栈指纹：各端方案 + 前后端 + 数据库（FR-WSP-03） */
export type TechStackFingerprint = Record<string, string>;

/** 项目领域对象（解析后的行 + 展示辅助字段） */
export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  /** 七端多选（FR-AI-13） */
  targetPlatforms: TargetPlatform[];
  techStackFingerprint: TechStackFingerprint | null;
  gitRemote: string | null;
  pinned: boolean;
  lastOpenedAt: number | null;
  deletedAt: number | null;
  sourceKind: ProjectSourceKind;
  sourceRef: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 新建项目输入（domain 层负责校验与默认值） */
export interface CreateProjectInput {
  name: string;
  description?: string | undefined;
  targetPlatforms?: TargetPlatform[] | undefined;
  techStackFingerprint?: TechStackFingerprint | undefined;
  gitRemote?: string | undefined;
  sourceKind?: ProjectSourceKind | undefined;
  sourceRef?: string | undefined;
}

/** 项目可变字段 */
export interface UpdateProjectPatch {
  name?: string | undefined;
  description?: string | null | undefined;
  status?: ProjectStatus | undefined;
  targetPlatforms?: TargetPlatform[] | undefined;
  techStackFingerprint?: TechStackFingerprint | null | undefined;
  gitRemote?: string | null | undefined;
  pinned?: boolean | undefined;
}

/** 复制选项（FR-WSP-05：复制项目含设计、记忆、文档与代码，可勾选） */
export interface DuplicateOptions {
  includeDesign: boolean;
  includeMemory: boolean;
  includeDocs: boolean;
  includeCode: boolean;
}

/** 列表查询条件 */
export interface ProjectQuery {
  view?: ProjectView;
  search?: string | undefined;
  sort?: ProjectSortKey | undefined;
  /** 只看置顶 */
  pinnedOnly?: boolean | undefined;
  /** 最近打开 N 条（0 = 不过滤） */
  recentLimit?: number | undefined;
}

/** 存储端口：由外壳适配到 SQLite（行结构见 @ec/data ProjectRow） */
export interface ProjectStore {
  /** 全量读取（不含查询语义，列表逻辑由领域层负责；外壳可一次读入内存） */
  loadAll(): Promise<ProjectRowSnapshot[]>;
  /** 读取单个项目；不存在返回 null */
  loadById(id: string): Promise<ProjectRowSnapshot | null>;
  /** 写入新项目（id 已由领域层生成） */
  insert(row: ProjectRowSnapshot): Promise<void>;
  /** 局部更新（updatedAt 由领域层维护） */
  update(id: string, patch: Partial<ProjectRowSnapshot>): Promise<void>;
  /** 物理删除单条项目行（仅彻底删除时调用；级联清理由外壳负责） */
  deleteRow(id: string): Promise<void>;
}

/** 存储行快照：与 @ec/data ProjectRow 字段一一对应（snake_case 序列化文本） */
export interface ProjectRowSnapshot {
  id: string;
  user_id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  tech_stack_json: string | null;
  status: string;
  target_platforms: string;
  tech_stack_fingerprint: string | null;
  git_remote: string | null;
  pinned: 0 | 1;
  last_opened_at: number | null;
  deleted_at: number | null;
  source_kind: string;
  source_ref: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 复制端口：外壳实现跨表搬运（页面/元素 → 设计，记忆条目，文档，代码目录）。
 * 领域层只负责编排顺序与错误聚合，不感知表结构。
 */
export interface ProjectDuplicatePort {
  /**
   * 把 sourceId 的指定资源复制到 targetId 名下。
   * 返回各资源的复制计数，供 UI 展示"复制了什么"。
   */
  copyResources(
    sourceId: string,
    targetId: string,
    options: DuplicateOptions,
  ): Promise<{ design: number; memory: number; docs: number; codeFiles: number }>;
}

/** 回收站保留期（FR-WSP-05：30 天） */
export const RECYCLE_BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 领域错误：UI 可直接展示 message */
export class ProjectDomainError extends Error {
  readonly code: 'not_found' | 'invalid_name' | 'duplicate_name' | 'in_recycle_bin';

  constructor(code: ProjectDomainError['code'], message: string) {
    super(message);
    this.name = 'ProjectDomainError';
    this.code = code;
  }
}
