import type { ChangeLogRecord, MemoryItem, MemoryPatch, MemoryScope } from '@ec/memory';
import { layerOf } from '@ec/memory';

import type {
  BatchRemoveResult,
  ConflictAnnotation,
  ImportPreviewModel,
  LayerMoveTarget,
  MemoryApi,
  MemoryDetail,
  MemoryExportRequest,
  MemoryExportResult,
  MemoryStats,
} from '../memory-api';

/**
 * 记忆中心的内存假实现。
 *
 * 组件测试只关心交互与渲染，不应牵扯 SQLite —— 这里用数组实现端口，
 * 行为与真实仓库保持一致的**最小语义**：筛选、乐观锁冲突、删除与恢复。
 */

export interface FakeMemoryOptions {
  items?: readonly MemoryItem[];
  conflicts?: Record<string, ConflictAnnotation[]>;
  changeLogs?: readonly ChangeLogRecord[];
  projects?: Array<{ id: string; name: string }>;
  longtermLimit?: number;
}

export interface FakeMemoryApi extends MemoryApi {
  /** 当前库中全部条目（测试断言用） */
  all(): MemoryItem[];
  /** 记录最近一次导出的请求（断言导出参数） */
  lastExport: MemoryExportRequest | null;
  /** 最近一次导入决策（断言合并预览的提交内容） */
  lastImportDecisions: Array<{ id: string; resolution: string }>;
}

export function createFakeMemoryApi(options: FakeMemoryOptions = {}): FakeMemoryApi {
  let store: MemoryItem[] = [...(options.items ?? [])];
  let trash: MemoryItem[] = [];
  let sequences = 0;

  const api: FakeMemoryApi = {
    lastExport: null,
    lastImportDecisions: [],
    all: () => [...store],

    listProjects: () => options.projects ?? [{ id: 'P1', name: '商城' }],

    stats({ projectId }): MemoryStats {
      const visible = store.filter((item) => matchesProject(item, projectId));
      const byLayer = new Map<string, number>();
      for (const item of visible) {
        const layer = layerOf(item);
        byLayer.set(layer, (byLayer.get(layer) ?? 0) + 1);
      }
      const longterm = visible.filter((item) => item.scope === 'longterm');
      return {
        layers: [...byLayer.entries()].map(([layer, total]) => ({ layer: layer as never, total })),
        activeIssues: visible.filter(
          (item) => item.scope === 'issue' && item.issueStatus === 'unsolved',
        ).length,
        longtermCount: longterm.length,
        longtermLimit: options.longtermLimit ?? 500,
      };
    },

    list({ projectId, query }): MemoryItem[] {
      let rows = store.filter((item) => matchesProject(item, projectId));
      if (query.layers && query.layers.length > 0) {
        rows = rows.filter((item) => query.layers?.includes(layerOf(item)));
      }
      if (query.scopes && query.scopes.length > 0)
        rows = rows.filter((item) => query.scopes?.includes(item.scope));
      if (query.activeIssuesOnly) rows = rows.filter((item) => item.issueStatus === 'unsolved');
      if (query.tags && query.tags.length > 0) {
        rows = rows.filter((item) => query.tags?.every((tag) => item.tags.includes(tag)));
      }
      if (query.text && query.text.trim().length > 0) {
        const needle = query.text.trim().toLowerCase();
        rows = rows.filter(
          (item) =>
            item.title.toLowerCase().includes(needle) ||
            item.content.toLowerCase().includes(needle) ||
            item.tags.some((tag) => tag.toLowerCase().includes(needle)),
        );
      }
      const orderBy = query.orderBy ?? 'updatedAt';
      const direction = query.direction === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        if (orderBy === 'title') return a.title.localeCompare(b.title) * direction;
        if (orderBy === 'importance') return (a.importance - b.importance) * direction;
        if (orderBy === 'createdAt') return (a.createdAt - b.createdAt) * direction;
        return (a.updatedAt - b.updatedAt) * direction;
      });
      return query.limit !== undefined ? rows.slice(0, query.limit) : rows;
    },

    detail(id): MemoryDetail | null {
      const item = store.find((entry) => entry.id === id);
      if (!item) return null;
      return { item, conflicts: options.conflicts?.[id] ?? [], coverage: null, violations: [] };
    },

    conflictIndex: () => options.conflicts ?? {},

    context({ projectId }) {
      const rows = store.filter((item) => matchesProject(item, projectId));
      const byLayer = new Map<string, MemoryItem[]>();
      for (const item of rows) {
        const layer = layerOf(item);
        byLayer.set(layer, [...(byLayer.get(layer) ?? []), item]);
      }
      return {
        layers: [...byLayer.entries()].map(([layer, items]) => ({ layer: layer as never, items })),
        effectiveIds: rows.map((item) => item.id),
        overriddenIds: [],
        conflictCount: 0,
      };
    },

    create(draft): MemoryItem {
      sequences += 1;
      const now = Date.now();
      const item: MemoryItem = {
        id: `NEW${sequences}`,
        userId: draft.userId,
        scope: draft.scope,
        projectId: draft.projectId ?? null,
        featureId: draft.featureId ?? null,
        pageId: draft.pageId ?? null,
        elementId: draft.elementId ?? null,
        issueId: draft.issueId ?? null,
        title: draft.title,
        content: draft.content ?? '',
        structured: draft.structured ?? null,
        tags: [...(draft.tags ?? [])],
        sourceType: 'manual',
        sourceRef: null,
        confidence: draft.confidence ?? 1,
        importance: draft.importance ?? 3,
        status: 'active',
        issueStatus: draft.scope === 'issue' ? 'unsolved' : null,
        pinned: draft.pinned ?? false,
        version: 1,
        createdAt: now,
        updatedAt: now,
        embedding: null,
      };
      store = [...store, item];
      return item;
    },

    update(id, patch: MemoryPatch, expectedVersion?: number): MemoryItem {
      const index = store.findIndex((entry) => entry.id === id);
      const current = store[index];
      if (!current) throw new Error(`条目不存在：${id}`);
      if (expectedVersion !== undefined && expectedVersion !== current.version) {
        const error = new Error('并发修改');
        error.name = 'ConflictError';
        throw error;
      }
      const next: MemoryItem = {
        ...current,
        ...patch,
        tags: patch.tags ? [...patch.tags] : current.tags,
        // patch.embedding 允许 readonly 数组，落库类型要求可变数组
        embedding: patch.embedding
          ? [...patch.embedding]
          : patch.embedding === null
            ? null
            : current.embedding,
        version: current.version + 1,
        updatedAt: Date.now(),
      };
      store = store.map((entry, position) => (position === index ? next : entry));
      return next;
    },

    setPinned(id, pinned): MemoryItem {
      return api.update(id, { pinned });
    },

    setIssueStatus(id, next): MemoryItem {
      // issueStatus 不在 MemoryPatch 内（真实实现走 MemoryRepo.setIssueStatus），这里直接改行
      const index = store.findIndex((entry) => entry.id === id);
      const current = store[index];
      if (!current) throw new Error(`条目不存在：${id}`);
      const updated: MemoryItem = { ...current, issueStatus: next, version: current.version + 1 };
      store = store.map((entry, position) => (position === index ? updated : entry));
      return updated;
    },

    moveLayer(ids, target: LayerMoveTarget): MemoryItem[] {
      return ids.map((id) => {
        const index = store.findIndex((entry) => entry.id === id);
        const current = store[index];
        if (!current) throw new Error(`条目不存在：${id}`);
        const moved: MemoryItem = {
          ...current,
          scope: target.scope,
          projectId: target.projectId ?? null,
          featureId: target.featureId ?? null,
          pageId: target.pageId ?? null,
          elementId: target.elementId ?? null,
          issueId: target.scope === 'issue' ? (current.issueId ?? 'ISSUE-NEW') : null,
          issueStatus: target.scope === 'issue' ? (current.issueStatus ?? 'unsolved') : null,
          version: current.version + 1,
        };
        store = store.map((entry, position) => (position === index ? moved : entry));
        return moved;
      });
    },

    remove(ids: readonly string[]): BatchRemoveResult {
      const removed = store.filter((item) => ids.includes(item.id));
      trash = [...trash, ...removed];
      store = store.filter((item) => !ids.includes(item.id));
      return { removedIds: removed.map((item) => item.id) };
    },

    restore(ids: readonly string[]): void {
      const back = trash.filter((item) => ids.includes(item.id));
      trash = trash.filter((item) => !ids.includes(item.id));
      store = [...store, ...back];
    },

    changeLog: ({ limit }) => (options.changeLogs ?? []).slice(0, limit ?? 50),

    async exportMemories(request: MemoryExportRequest): Promise<MemoryExportResult> {
      api.lastExport = request;
      const rows = store.filter((item) => matchesProject(item, request.projectId));
      if (request.format === 'json') {
        return {
          files: [{ name: 'memories.json', content: JSON.stringify({ count: rows.length }) }],
        };
      }
      return {
        files: rows.map((item) => ({ name: `longterm/${item.title}.md`, content: item.content })),
      };
    },

    async importPreview(): Promise<ImportPreviewModel> {
      return {
        rows: [
          {
            id: 'I-ADD',
            title: '新增条目',
            classification: 'added',
            localTitle: null,
            incomingTitle: '新增条目',
            localUpdatedAt: null,
            incomingUpdatedAt: 1,
          },
          {
            id: 'I-CONFLICT',
            title: '冲突条目',
            classification: 'conflicted',
            localTitle: '冲突条目',
            incomingTitle: '冲突条目（导入版）',
            localUpdatedAt: 1,
            incomingUpdatedAt: 2,
          },
        ],
        counts: { added: 1, conflicted: 1, unchanged: 0, missing: 0 },
      };
    },

    async importCommit(request): Promise<{ created: number; updated: number; superseded: number }> {
      api.lastImportDecisions = request.decisions.map((entry) => ({
        id: entry.id,
        resolution: entry.resolution,
      }));
      return { created: request.decisions.length, updated: 0, superseded: 0 };
    },
  };

  return api;
}

function matchesProject(item: MemoryItem, projectId: string | null): boolean {
  if (item.scope === 'longterm') return true;
  if (projectId === null) return true;
  return item.projectId === projectId;
}

/** 造一条测试用记忆 */
export function makeMemory(patch: Partial<MemoryItem> & { id: string; title: string }): MemoryItem {
  const scope: MemoryScope = patch.scope ?? 'longterm';
  return {
    userId: 'U1',
    scope,
    projectId: scope === 'longterm' ? null : 'P1',
    featureId: scope === 'feature' || scope === 'page' ? 'F1' : null,
    pageId: scope === 'page' ? 'PG1' : null,
    elementId: null,
    issueId: scope === 'issue' ? 'ISSUE-1' : null,
    content: `${patch.title} 的正文`,
    structured: null,
    tags: [],
    sourceType: 'manual',
    sourceRef: null,
    confidence: 1,
    importance: 3,
    status: 'active',
    issueStatus: scope === 'issue' ? 'unsolved' : null,
    pinned: false,
    version: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    embedding: null,
    ...patch,
  };
}
