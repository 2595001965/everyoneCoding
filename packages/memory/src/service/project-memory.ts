import type { MemoryRepo } from '../repo/memory-repo';
import type { MemoryItem } from '../domain/memory-item';
import { upsertMemory, type UpsertOptions, type UpsertOutcome } from './upsert';

/**
 * 项目记忆（FR-MEM-02）：项目级架构知识。
 *
 * 按 PRD §6.2 与任务 T2-01 的约定，项目记忆拆成七个固定分区，
 * 每分区一条独立条目（标题即分区名），可单独更新与覆盖，便于冲突溯源到具体字段。
 */

export const PROJECT_MEMORY_SECTIONS = [
  'stack',
  'modules',
  'routes',
  'dataModels',
  'globalState',
  'dependencies',
  'deployment',
] as const;

export type ProjectMemorySection = (typeof PROJECT_MEMORY_SECTIONS)[number];

export const PROJECT_SECTION_TITLES: Record<ProjectMemorySection, string> = {
  stack: '技术选型',
  modules: '模块划分',
  routes: '路由总表',
  dataModels: '数据模型',
  globalState: '全局状态',
  dependencies: '第三方依赖',
  deployment: '部署方式',
};

export const PROJECT_SECTION_TAGS: Record<ProjectMemorySection, string[]> = {
  stack: ['project', 'stack'],
  modules: ['project', 'modules'],
  routes: ['project', 'routes'],
  dataModels: ['project', 'data-model'],
  globalState: ['project', 'state'],
  dependencies: ['project', 'dependency'],
  deployment: ['project', 'deploy'],
};

export interface ProjectMemoryDraft {
  stack?: Record<string, unknown>;
  modules?: readonly string[] | Record<string, unknown>;
  routes?: readonly string[] | Record<string, unknown>;
  dataModels?: readonly string[] | Record<string, unknown>;
  globalState?: Record<string, unknown>;
  dependencies?: readonly string[] | Record<string, unknown>;
  deployment?: Record<string, unknown>;
}

function toStructured(section: ProjectMemorySection, payload: unknown): Record<string, unknown> {
  if (Array.isArray(payload)) {
    const key =
      section === 'routes'
        ? 'routes'
        : section === 'modules'
          ? 'modules'
          : section === 'dependencies'
            ? 'dependencies'
            : 'items';
    return { [key]: payload };
  }
  if (payload && typeof payload === 'object') return payload as Record<string, unknown>;
  return {};
}

export class ProjectMemoryService {
  constructor(
    private readonly repo: MemoryRepo,
    private readonly userId: string,
  ) {}

  /** 写入/更新单个分区 */
  upsertSection(
    projectId: string,
    section: ProjectMemorySection,
    payload: unknown,
    options: UpsertOptions & { content?: string } = {},
  ): UpsertOutcome {
    const structured = toStructured(section, payload);
    return upsertMemory(
      this.repo,
      {
        userId: this.userId,
        scope: 'project',
        projectId,
        title: PROJECT_SECTION_TITLES[section],
        content: options.content ?? this.describe(section, structured),
        structured,
        tags: PROJECT_SECTION_TAGS[section],
        sourceType: options.sourceType ?? 'manual',
        sourceRef: options.sourceRef ?? null,
        importance: options.importance ?? 4,
        confidence: options.confidence ?? 1,
      },
      options,
    );
  }

  /** 技术文档生成初稿：一次写入整份项目记忆（幂等，可重复调用） */
  upsertDraft(
    projectId: string,
    draft: ProjectMemoryDraft,
    options: UpsertOptions = {},
  ): UpsertOutcome[] {
    const outcomes: UpsertOutcome[] = [];
    for (const section of PROJECT_MEMORY_SECTIONS) {
      const payload = draft[section];
      if (payload === undefined) continue;
      outcomes.push(this.upsertSection(projectId, section, payload, options));
    }
    return outcomes;
  }

  /** 路由总表增量合并（设计器新增页面 / 路由时调用，不覆盖已有路由） */
  mergeRoutes(projectId: string, routes: readonly string[]): UpsertOutcome {
    const existing = this.get(projectId).routes;
    const current = Array.isArray(existing?.structured?.['routes'])
      ? (existing?.structured?.['routes'] as unknown[]).filter(
          (item): item is string => typeof item === 'string',
        )
      : [];
    const merged = [...new Set([...current, ...routes])];
    return this.upsertSection(projectId, 'routes', merged, {
      onExisting: 'merge',
      sourceType: 'auto_design',
    });
  }

  /** 读取各分区当前条目 */
  get(projectId: string): Record<ProjectMemorySection, MemoryItem | null> {
    const items = this.repo.list({ userId: this.userId, scopes: ['project'], projectId });
    const result = {} as Record<ProjectMemorySection, MemoryItem | null>;
    for (const section of PROJECT_MEMORY_SECTIONS) {
      result[section] =
        items.find((item) => item.title === PROJECT_SECTION_TITLES[section]) ?? null;
    }
    return result;
  }

  /** 汇总视图：把各分区结构化数据拼成一份"项目架构摘要" */
  overview(projectId: string): {
    structured: Record<string, unknown>;
    missing: ProjectMemorySection[];
  } {
    const bySection = this.get(projectId);
    const structured: Record<string, unknown> = {};
    const missing: ProjectMemorySection[] = [];
    for (const section of PROJECT_MEMORY_SECTIONS) {
      const item = bySection[section];
      if (!item) {
        missing.push(section);
        continue;
      }
      structured[section] = item.structured ?? item.content;
    }
    return { structured, missing };
  }

  private describe(section: ProjectMemorySection, structured: Record<string, unknown>): string {
    switch (section) {
      case 'stack': {
        const entries = Object.entries(structured).filter(([, value]) => typeof value === 'string');
        return entries.length > 0
          ? entries.map(([key, value]) => `${key}: ${String(value)}`).join('；')
          : '技术选型待补充';
      }
      case 'modules':
        return `模块：${toStringList(structured['modules']).join('、') || '待补充'}`;
      case 'routes':
        return `路由：${toStringList(structured['routes']).join('、') || '待补充'}`;
      case 'dataModels':
        return `数据模型：${toStringList(structured['dataModels'] ?? structured['items']).join('、') || '待补充'}`;
      case 'globalState':
        return `全局状态：${toStringList(structured['states'] ?? Object.keys(structured)).join('、') || '待补充'}`;
      case 'dependencies':
        return `依赖：${toStringList(structured['dependencies']).join('、') || '待补充'}`;
      case 'deployment':
        return `部署：${typeof structured['target'] === 'string' ? structured['target'] : '待补充'}`;
    }
  }
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
