import type { MemoryRepo } from '../repo/memory-repo';
import type { MemoryItem } from '../domain/memory-item';
import { upsertMemory, type UpsertOptions, type UpsertOutcome } from './upsert';

/**
 * 功能记忆（FR-MEM-03）：业务流程 / 输入输出 / 边界条件 / 接口清单 / 错误码表 / 验收标准。
 *
 * 一个功能可关联多个页面；功能记忆挂在 feature 上，其下再挂页面记忆与问题记忆。
 */

export const FEATURE_MEMORY_SECTIONS = [
  'flow',
  'io',
  'edgeCases',
  'apis',
  'errors',
  'acceptance',
] as const;
export type FeatureMemorySection = (typeof FEATURE_MEMORY_SECTIONS)[number];

export const FEATURE_SECTION_LABELS: Record<FeatureMemorySection, string> = {
  flow: '业务流程',
  io: '输入输出',
  edgeCases: '边界条件',
  apis: '接口清单',
  errors: '错误码表',
  acceptance: '验收标准',
};

export interface ApiEntry {
  method: string;
  path: string;
  auth?: boolean;
  desc?: string;
}

export interface ErrorCodeEntry {
  code: string;
  msg: string;
  httpStatus?: number;
}

export class FeatureMemoryService {
  constructor(
    private readonly repo: MemoryRepo,
    private readonly userId: string,
  ) {}

  upsert(input: {
    projectId: string;
    featureId: string;
    featureName: string;
    content?: string;
    structured: Partial<Record<FeatureMemorySection, unknown>>;
    options?: UpsertOptions;
  }): UpsertOutcome {
    const structured: Record<string, unknown> = {};
    for (const section of FEATURE_MEMORY_SECTIONS) {
      const value = input.structured[section];
      if (value !== undefined) structured[section] = value;
    }
    return upsertMemory(
      this.repo,
      {
        userId: this.userId,
        scope: 'feature',
        projectId: input.projectId,
        featureId: input.featureId,
        title: input.featureName,
        content: input.content ?? describeFeature(structured),
        structured,
        tags: ['feature'],
        sourceType: input.options?.sourceType ?? 'ai_summary',
        sourceRef: input.options?.sourceRef ?? `feature:${input.featureId}`,
        importance: input.options?.importance ?? 4,
        confidence: input.options?.confidence ?? 0.85,
      },
      input.options ?? {},
    );
  }

  /** 追加错误码（去重，按 code 覆盖旧定义） */
  upsertErrorCode(
    projectId: string,
    featureId: string,
    entry: ErrorCodeEntry,
    options: UpsertOptions = {},
  ): UpsertOutcome | null {
    const current = this.findByFeature(featureId);
    if (!current) return null;
    const existing = Array.isArray(current.structured?.['errors'])
      ? (current.structured?.['errors'] as ErrorCodeEntry[]).filter(
          (item) => item && typeof item.code === 'string',
        )
      : [];
    const next = [...existing.filter((item) => item.code !== entry.code), entry];
    return this.patchSection(current, 'errors', next, projectId, options);
  }

  /** 追加接口清单项（按 method + path 去重） */
  upsertApi(
    projectId: string,
    featureId: string,
    entry: ApiEntry,
    options: UpsertOptions = {},
  ): UpsertOutcome | null {
    const current = this.findByFeature(featureId);
    if (!current) return null;
    const existing = Array.isArray(current.structured?.['apis'])
      ? (current.structured?.['apis'] as ApiEntry[]).filter(
          (item) => item && typeof item.path === 'string',
        )
      : [];
    const next = [
      ...existing.filter((item) => !(item.method === entry.method && item.path === entry.path)),
      entry,
    ];
    return this.patchSection(current, 'apis', next, projectId, options);
  }

  /** 追加边界条件 */
  appendEdgeCase(
    projectId: string,
    featureId: string,
    text: string,
    options: UpsertOptions = {},
  ): UpsertOutcome | null {
    const current = this.findByFeature(featureId);
    if (!current) return null;
    const existing = Array.isArray(current.structured?.['edgeCases'])
      ? (current.structured?.['edgeCases'] as unknown[]).filter(
          (item): item is string => typeof item === 'string',
        )
      : [];
    if (existing.includes(text)) return null;
    return this.patchSection(current, 'edgeCases', [...existing, text], projectId, options);
  }

  findByFeature(featureId: string): MemoryItem | null {
    return this.repo.list({ userId: this.userId, scopes: ['feature'], featureId })[0] ?? null;
  }

  /** 功能树视图：功能 → 关联页面（页面记忆） */
  tree(projectId: string): Array<{ item: MemoryItem; pages: MemoryItem[] }> {
    const features = this.repo.list({ userId: this.userId, scopes: ['feature'], projectId });
    const pages = this.repo.list({ userId: this.userId, scopes: ['page'], projectId });
    return features.map((item) => ({
      item,
      pages: pages.filter((page) => page.featureId === item.featureId && !page.elementId),
    }));
  }

  private patchSection(
    current: MemoryItem,
    section: FeatureMemorySection,
    value: unknown,
    projectId: string,
    options: UpsertOptions,
  ): UpsertOutcome {
    return upsertMemory(
      this.repo,
      {
        userId: this.userId,
        scope: 'feature',
        projectId,
        featureId: current.featureId,
        title: current.title,
        content: current.content,
        structured: { ...(current.structured ?? {}), [section]: value },
        tags: current.tags,
        sourceType: options.sourceType ?? current.sourceType,
        sourceRef: options.sourceRef ?? current.sourceRef,
        importance: current.importance,
        confidence: current.confidence,
      },
      { ...options, onExisting: 'replace' },
    );
  }
}

function describeFeature(structured: Record<string, unknown>): string {
  const parts: string[] = [];
  const flow = structured['flow'];
  if (Array.isArray(flow)) parts.push(`流程 ${flow.length} 步`);
  const apis = structured['apis'];
  if (Array.isArray(apis)) parts.push(`接口 ${apis.length} 个`);
  const errors = structured['errors'];
  if (Array.isArray(errors)) parts.push(`错误码 ${errors.length} 条`);
  return parts.join('；') || '功能要点待补充';
}
