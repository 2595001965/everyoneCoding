/**
 * 项目服务（T9-01 / FR-WSP-01 ~ 05）。
 *
 * 领域职责：
 * - 项目 CRUD（校验 + 默认值 + ULID）
 * - 收藏置顶 / 最近打开（last_opened_at，退出后保留——持久化由外壳的存储保证）
 * - 归档 / 回收站（删除 = 软删除记 deleted_at，保留 30 天，可恢复；超期清理可由外壳定时调 cleanupExpiredRecycleBin）
 * - 复制项目（编排 DuplicatePort 搬运，聚合结果）
 *
 * 存储经 `ProjectStore` 端口注入；时间经 `clock` 注入（测试友好）。
 * 本模块为纯逻辑，浏览器可达。
 */

import { newUlid } from '@ec/data';
import {
  ProjectDomainError,
  RECYCLE_BIN_RETENTION_MS,
  type CreateProjectInput,
  type DuplicateOptions,
  type ProjectDuplicatePort,
  type ProjectQuery,
  type ProjectRowSnapshot,
  type ProjectSortKey,
  type ProjectStatus,
  type ProjectStore,
  type ProjectSummary,
  type TargetPlatform,
  type TechStackFingerprint,
  type UpdateProjectPatch,
  TARGET_PLATFORM_KEYS,
} from './project-types';

/** 项目服务依赖 */
export interface ProjectServiceDeps {
  store: ProjectStore;
  duplicate?: ProjectDuplicatePort | undefined;
  /** 时间源（毫秒），默认 Date.now */
  clock?: () => number;
  /** 新 id 生成（默认 ULID） */
  newId?: () => string;
}

/** 行快照 → 领域对象（宽容解析：坏 JSON 按空值处理，不让脏数据炸 UI） */
export function rowToSummary(row: ProjectRowSnapshot): ProjectSummary {
  let platforms: TargetPlatform[] = [];
  try {
    const parsed: unknown = JSON.parse(row.target_platforms);
    if (Array.isArray(parsed)) {
      platforms = parsed.filter((p): p is TargetPlatform =>
        typeof p === 'string' && (TARGET_PLATFORM_KEYS as readonly string[]).includes(p),
      );
    }
  } catch {
    platforms = [];
  }

  let fingerprint: TechStackFingerprint | null = null;
  if (row.tech_stack_fingerprint) {
    try {
      const parsed: unknown = JSON.parse(row.tech_stack_fingerprint);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fingerprint = parsed as TechStackFingerprint;
      }
    } catch {
      fingerprint = null;
    }
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: (row.status === 'archived' ? 'archived' : 'active') satisfies ProjectStatus,
    targetPlatforms: platforms,
    techStackFingerprint: fingerprint,
    gitRemote: row.git_remote,
    pinned: row.pinned === 1,
    lastOpenedAt: row.last_opened_at,
    deletedAt: row.deleted_at,
    sourceKind: (['blank', 'template', 'git_import', 'doc_import'] as const).includes(
      row.source_kind as ProjectSummary['sourceKind'],
    )
      ? (row.source_kind as ProjectSummary['sourceKind'])
      : 'blank',
    sourceRef: row.source_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 领域对象 → 行快照（写入用） */
export function summaryToRow(summary: ProjectSummary, userId: string): ProjectRowSnapshot {
  return {
    id: summary.id,
    user_id: userId,
    workspace_id: null,
    name: summary.name,
    description: summary.description,
    tech_stack_json: null,
    status: summary.status,
    target_platforms: JSON.stringify(summary.targetPlatforms),
    tech_stack_fingerprint: summary.techStackFingerprint
      ? JSON.stringify(summary.techStackFingerprint)
      : null,
    git_remote: summary.gitRemote,
    pinned: summary.pinned ? 1 : 0,
    last_opened_at: summary.lastOpenedAt,
    deleted_at: summary.deletedAt,
    source_kind: summary.sourceKind,
    source_ref: summary.sourceRef,
    created_at: summary.createdAt,
    updated_at: summary.updatedAt,
  };
}

export class ProjectService {
  private readonly deps: Required<Pick<ProjectServiceDeps, 'store' | 'clock' | 'newId'>> &
    Pick<ProjectServiceDeps, 'duplicate'>;
  /** 已加载的内存视图（loadAll 一次，后续写操作同步维护） */
  private cache: ProjectRowSnapshot[] | null = null;

  constructor(deps: ProjectServiceDeps) {
    this.deps = {
      store: deps.store,
      clock: deps.clock ?? Date.now,
      newId: deps.newId ?? newUlid,
      duplicate: deps.duplicate,
    };
  }

  private async rows(): Promise<ProjectRowSnapshot[]> {
    if (!this.cache) this.cache = await this.deps.store.loadAll();
    return this.cache;
  }

  private async persistCache(): Promise<void> {
    if (this.cache) this.cache = await this.deps.store.loadAll();
  }

  /** 列表：视图过滤 + 搜索 + 排序 + 置顶优先 + 最近 N 条 */
  async listProjects(query: ProjectQuery = {}): Promise<ProjectSummary[]> {
    const view = query.view ?? 'active';
    const search = (query.search ?? '').trim().toLowerCase();

    let rows = (await this.rows()).filter((row) => {
      if (view === 'recycleBin') return row.deleted_at !== null;
      if (row.deleted_at !== null) return false;
      if (view === 'archived') return row.status === 'archived';
      return row.status === 'active';
    });

    if (search) rows = rows.filter((row) => row.name.toLowerCase().includes(search));

    if (query.pinnedOnly) rows = rows.filter((row) => row.pinned === 1);

    const sort: ProjectSortKey = query.sort ?? (view === 'recycleBin' ? 'updatedAt' : 'updatedAt');
    const sorted = [...rows].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned === 1 ? -1 : 1;
      switch (sort) {
        case 'name':
          return a.name.localeCompare(b.name, 'zh-CN');
        case 'createdAt':
          return b.created_at - a.created_at;
        default:
          return b.updated_at - a.updated_at;
      }
    });

    const summaries = sorted.map((row) => rowToSummary(row));

    const limit = query.recentLimit ?? 0;
    if (limit > 0) {
      const withOpened = summaries.filter((s) => s.lastOpenedAt !== null);
      withOpened.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
      return withOpened.slice(0, limit);
    }
    return summaries;
  }

  async getProject(id: string): Promise<ProjectSummary | null> {
    const row = await this.deps.store.loadById(id);
    return row ? rowToSummary(row) : null;
  }

  /** 打开项目：刷新 last_opened_at（FR-WSP-04 最近 10 条由 UI 层用 recentLimit 取） */
  async markOpened(id: string): Promise<void> {
    const now = this.deps.clock();
    await this.deps.store.update(id, { last_opened_at: now });
    await this.persistCache();
  }

  async createProject(input: CreateProjectInput, userId = 'local-user'): Promise<ProjectSummary> {
    const name = input.name.trim();
    if (!name) throw new ProjectDomainError('invalid_name', '项目名称不能为空');

    const rows = await this.rows();
    if (rows.some((row) => row.deleted_at === null && row.name === name)) {
      throw new ProjectDomainError('duplicate_name', `已存在同名项目：${name}`);
    }

    const now = this.deps.clock();
    const summary: ProjectSummary = {
      id: this.deps.newId(),
      name,
      description: input.description ?? null,
      status: 'active',
      targetPlatforms: input.targetPlatforms ?? [],
      techStackFingerprint: input.techStackFingerprint ?? null,
      gitRemote: input.gitRemote ?? null,
      pinned: false,
      lastOpenedAt: now,
      deletedAt: null,
      sourceKind: input.sourceKind ?? 'blank',
      sourceRef: input.sourceRef ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.insert(summaryToRow(summary, userId));
    await this.persistCache();
    return summary;
  }

  async updateProject(id: string, patch: UpdateProjectPatch): Promise<ProjectSummary | null> {
    const row = await this.deps.store.loadById(id);
    if (!row) throw new ProjectDomainError('not_found', `项目不存在：${id}`);

    const storePatch: Partial<ProjectRowSnapshot> = { updated_at: this.deps.clock() };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ProjectDomainError('invalid_name', '项目名称不能为空');
      const rows = await this.rows();
      if (rows.some((r) => r.id !== id && r.deleted_at === null && r.name === name)) {
        throw new ProjectDomainError('duplicate_name', `已存在同名项目：${name}`);
      }
      storePatch.name = name;
    }
    if (patch.description !== undefined) storePatch.description = patch.description;
    if (patch.status !== undefined) storePatch.status = patch.status;
    if (patch.targetPlatforms !== undefined) storePatch.target_platforms = JSON.stringify(patch.targetPlatforms);
    if (patch.techStackFingerprint !== undefined) {
      storePatch.tech_stack_fingerprint =
        patch.techStackFingerprint === null ? null : JSON.stringify(patch.techStackFingerprint);
    }
    if (patch.gitRemote !== undefined) storePatch.git_remote = patch.gitRemote;
    if (patch.pinned !== undefined) storePatch.pinned = patch.pinned ? 1 : 0;

    await this.deps.store.update(id, storePatch);
    await this.persistCache();
    const updated = await this.deps.store.loadById(id);
    return updated ? rowToSummary(updated) : null;
  }

  /** 归档（可逆：归档 ≠ 删除） */
  async archiveProject(id: string): Promise<void> {
    await this.updateProject(id, { status: 'archived' });
  }

  async unarchiveProject(id: string): Promise<void> {
    await this.updateProject(id, { status: 'active' });
  }

  /** 删除 → 进回收站（软删除）。二次确认由 UI 负责，领域层不拦截。 */
  async moveToRecycleBin(id: string): Promise<void> {
    const row = await this.deps.store.loadById(id);
    if (!row) throw new ProjectDomainError('not_found', `项目不存在：${id}`);
    await this.deps.store.update(id, { deleted_at: this.deps.clock() });
    await this.persistCache();
  }

  /** 从回收站恢复 */
  async restoreFromRecycleBin(id: string): Promise<void> {
    const row = await this.deps.store.loadById(id);
    if (!row) throw new ProjectDomainError('not_found', `项目不存在：${id}`);
    if (row.deleted_at === null) return;
    await this.deps.store.update(id, { deleted_at: null });
    await this.persistCache();
  }

  /** 彻底删除（物理删行 + 级联清理由外壳的 DuplicatePort/store 实现负责）。 */
  async purgeProject(id: string): Promise<void> {
    await this.deps.store.deleteRow(id);
    await this.persistCache();
  }

  /** 清理回收站中超过保留期的项目，返回被清理的 id 列表。 */
  async cleanupExpiredRecycleBin(): Promise<string[]> {
    const now = this.deps.clock();
    const rows = (await this.rows()).filter(
      (row) => row.deleted_at !== null && row.deleted_at + RECYCLE_BIN_RETENTION_MS <= now,
    );
    for (const row of rows) await this.deps.store.deleteRow(row.id);
    if (rows.length > 0) await this.persistCache();
    return rows.map((row) => row.id);
  }

  /**
   * 复制项目（FR-WSP-05）：复制基本信息 + 按选项搬运设计/记忆/文档/代码。
   * 新项目名默认 `<原名>-副本`，重名时追加序号。
   */
  async duplicateProject(
    id: string,
    options: DuplicateOptions,
  ): Promise<{ project: ProjectSummary; copied: { design: number; memory: number; docs: number; codeFiles: number } }> {
    if (!this.deps.duplicate) {
      throw new ProjectDomainError('not_found', '复制端口未装配（DuplicatePort 缺失）');
    }
    const source = await this.deps.store.loadById(id);
    if (!source) throw new ProjectDomainError('not_found', `项目不存在：${id}`);

    const rows = await this.rows();
    const existingNames = new Set(rows.filter((r) => r.deleted_at === null).map((r) => r.name));
    let name = `${source.name}-副本`;
    for (let i = 2; existingNames.has(name); i += 1) name = `${source.name}-副本(${i})`;

    const created = await this.createProject({
      name,
      description: source.description ?? undefined,
      sourceKind: source.source_kind as ProjectSummary['sourceKind'],
      sourceRef: source.source_ref ?? undefined,
      gitRemote: source.git_remote ?? undefined,
      targetPlatforms: rowToSummary(source).targetPlatforms,
      techStackFingerprint: rowToSummary(source).techStackFingerprint ?? undefined,
    });
    const copied = await this.deps.duplicate.copyResources(id, created.id, options);
    await this.persistCache();
    return { project: created, copied };
  }
}
