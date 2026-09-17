import type { MemoryRepo } from '../repo/memory-repo';
import type { MemoryItem } from '../domain/memory-item';
import { upsertMemory, type UpsertOptions, type UpsertOutcome } from './upsert';

/**
 * 页面记忆（FR-MEM-04）：布局骨架 / 区块构成 / 页面状态机 / 事件流 / 接口依赖。
 *
 * 每个页面一条记忆（标题为"页面名 路由"），由设计器 DSL 精简后自动生成，
 * 设计稿变更时走 upsert 深合并实现"增量更新而非全量覆盖"（FR-MEM-18 的数据侧）。
 * 同一页面下的元素备注是 scope=page + element_id 的另一类条目，由 upsertElementNote 维护。
 */

export const PAGE_MEMORY_SECTIONS = ['skeleton', 'blocks', 'state', 'events', 'dataFlow', 'apiDeps'] as const;
export type PageMemorySection = (typeof PAGE_MEMORY_SECTIONS)[number];

export const PAGE_SECTION_LABELS: Record<PageMemorySection, string> = {
  skeleton: '布局骨架',
  blocks: '区块构成',
  state: '页面状态机',
  events: '事件流',
  dataFlow: '数据流',
  apiDeps: '接口依赖',
};

export interface PageMemoryInput {
  projectId: string;
  pageId: string;
  featureId?: string | null;
  pageName: string;
  route?: string | null;
  structured: Partial<Record<PageMemorySection, unknown>>;
  content?: string;
  options?: UpsertOptions;
}

export interface ElementNoteInput {
  projectId: string;
  pageId: string;
  elementId: string;
  elementName: string;
  featureId?: string | null;
  noteType: string;
  text: string;
  priority?: 'low' | 'medium' | 'high';
  options?: UpsertOptions;
}

export class PageMemoryService {
  constructor(
    private readonly repo: MemoryRepo,
    private readonly userId: string,
  ) {}

  /** 页面标题约定：「登录页 /login」，与 PRD §13.1 示例一致 */
  static titleOf(pageName: string, route?: string | null): string {
    return route ? `${pageName} ${route}` : pageName;
  }

  /** 新建或增量更新页面记忆 */
  upsert(input: PageMemoryInput): UpsertOutcome {
    const structured = pickSections(input.structured);
    return upsertMemory(
      this.repo,
      {
        userId: this.userId,
        scope: 'page',
        projectId: input.projectId,
        featureId: input.featureId ?? null,
        pageId: input.pageId,
        title: PageMemoryService.titleOf(input.pageName, input.route ?? null),
        content: input.content ?? describePage(structured),
        structured,
        tags: ['page'],
        sourceType: input.options?.sourceType ?? 'auto_design',
        sourceRef: input.options?.sourceRef ?? `page:${input.pageId}`,
        importance: input.options?.importance ?? 3,
        confidence: input.options?.confidence ?? 0.9,
      },
      input.options ?? {},
    );
  }

  /** 仅更新某一分区（设计器改状态/事件时避免整条重写） */
  updateSection(
    pageId: string,
    section: PageMemorySection,
    value: unknown,
    options: UpsertOptions = {},
  ): UpsertOutcome | null {
    const current = this.findByPage(pageId);
    if (!current) return null;
    const structured = { ...(current.structured ?? {}), [section]: value };
    return upsertMemory(
      this.repo,
      {
        userId: this.userId,
        scope: 'page',
        projectId: current.projectId ?? '',
        featureId: current.featureId,
        pageId,
        title: current.title,
        content: current.content,
        structured,
        tags: current.tags,
        sourceType: options.sourceType ?? 'auto_design',
        sourceRef: options.sourceRef ?? current.sourceRef,
        importance: current.importance,
        confidence: current.confidence,
      },
      { ...options, onExisting: 'replace' },
    );
  }

  /** 页面级记忆（不含元素备注） */
  findByPage(pageId: string): MemoryItem | null {
    const items = this.repo.list({ userId: this.userId, scopes: ['page'], pageId });
    return items.find((item) => !item.elementId) ?? null;
  }

  /** 元素备注（scope=page + element_id，即 PRD §2.1 继承链最下层） */
  upsertElementNote(input: ElementNoteInput): UpsertOutcome {
    const structured = {
      noteType: input.noteType,
      text: input.text,
      priority: input.priority ?? 'medium',
    };
    return upsertMemory(
      this.repo,
      {
        userId: this.userId,
        scope: 'page',
        projectId: input.projectId,
        featureId: input.featureId ?? null,
        pageId: input.pageId,
        elementId: input.elementId,
        title: input.elementName,
        content: input.text,
        structured,
        tags: ['element-note', input.noteType],
        sourceType: input.options?.sourceType ?? 'manual',
        sourceRef: input.options?.sourceRef ?? `element:${input.elementId}`,
        importance: input.options?.importance ?? 3,
        confidence: input.options?.confidence ?? 1,
      },
      input.options ?? {},
    );
  }

  /** 某页面下全部元素备注 */
  listElementNotes(pageId: string): MemoryItem[] {
    return this.repo.list({ userId: this.userId, scopes: ['page'], pageId }).filter((item) => Boolean(item.elementId));
  }
}

function pickSections(source: Partial<Record<PageMemorySection, unknown>>): Record<string, unknown> {
  const structured: Record<string, unknown> = {};
  for (const section of PAGE_MEMORY_SECTIONS) {
    const value = source[section];
    if (value !== undefined) structured[section] = value;
  }
  return structured;
}

function describePage(structured: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof structured['skeleton'] === 'string') parts.push(`骨架：${structured['skeleton']}`);
  const state = structured['state'];
  if (Array.isArray(state)) parts.push(`状态：${state.length} 项`);
  const apiDeps = structured['apiDeps'];
  if (Array.isArray(apiDeps)) parts.push(`接口依赖：${apiDeps.length} 个`);
  return parts.join('；') || '页面逻辑结构待精简';
}
