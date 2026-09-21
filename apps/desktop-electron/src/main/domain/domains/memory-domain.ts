import type Database from 'better-sqlite3';

import {
  MemoryRepo,
  validateOwnership,
  isRelevantTo,
  layerOf,
  detectConflicts,
  readImport,
  classifyImport,
  planMerge,
  commitMergePlan,
  exportAll,
  type MemoryItem,
  type MemoryLayer,
  type MemoryPatch,
  type MemoryScope,
  type MemoryStatus,
  type MemoryViolation,
  type CoverageMark,
  type ChangeLogRecord,
  type ImportClassification,
  type ImportResolution,
  type MergeDecision,
  type ResolveContextRef,
} from '@ec/memory';
import { ShellError, type DomainRpcError } from '@ec/shell-api';

import type { DomainRouter, SyncDomainRouter } from '../runtime';

/**
 * memory 域生产路由（T12-01 / T12-02）。
 *
 * 渲染层 `MemoryApi` 的方法全部由本路由承载。三点须留意：
 *
 * 1. **同步签名 vs 异步 IPC**：`MemoryApi` 的读方法（listProjects / stats /
 *    list / detail / conflictIndex / context）在渲染层是同步签名，而域 RPC 只能异步。
 *    解法在渲染层适配器一侧——启动期预热 + 写入后失效重拉「快照缓存」，
 *    由快照回答同步读。本域因此额外提供 `listProjects` 这一轻量拉取口。
 * 2. **导入的两段式**：`importPreview` 与 `importCommit` 跨两次调用，第二次只带
 *    决策不带文件。故本域按 userId 缓存上一次预览的条目（进程内，请求定局即失效），
 *    避免让渲染层把整包内容再传一遍（大包会顶到 IPC 载荷上限）。
 * 3. **冲突标注口径**：统一走 `resolveInheritance` 的溯源记录（`conflicts`）与
 *    覆盖汇总（`coverage`），而不是自行两两比对——「同标题整体接管 / 同路径按路径覆盖」
 *    这两条规则只在继承解析里成立，自行比对会给出与 UI 文案不一致的结论。
 */

/** 一条待提交的导入：预览时缓存，提交时消费 */
interface PendingImport {
  readonly incoming: MemoryItem[];
  readonly at: number;
}

/** 待提交导入的存活上限：超过即视为放弃（大包场景下不宜长期驻留内存） */
const PENDING_IMPORT_TTL_MS = 30 * 60 * 1000;

export function createMemoryDomain(options: {
  db: Database.Database;
  userId: string;
}): { router: DomainRouter; syncRouter: SyncDomainRouter } {
  const repo = new MemoryRepo(options.db);
  const userId = options.userId;
  const pendingImports = new Map<string, PendingImport>();

  /* ------------------------------ 内部工具 ------------------------------ */

  const violationsOf = (item: MemoryItem): MemoryViolation[] =>
    validateOwnership(item.scope, {
      project_id: item.projectId,
      feature_id: item.featureId,
      page_id: item.pageId,
      element_id: item.elementId,
      issue_id: item.issueId,
    });

  const refOf = (item: MemoryItem): ResolveContextRef => ({
    projectId: item.projectId ?? '',
    featureId: item.featureId,
    pageId: item.pageId,
    elementId: item.elementId,
    issueId: item.issueId,
  });

  const contextRef = (input: {
    projectId: string;
    featureId?: string | null;
    pageId?: string | null;
    elementId?: string | null;
    issueId?: string | null;
  }): ResolveContextRef => ({
    projectId: input.projectId,
    featureId: input.featureId ?? null,
    pageId: input.pageId ?? null,
    elementId: input.elementId ?? null,
    issueId: input.issueId ?? null,
  });

  const staleImport = (at: number): boolean => Date.now() - at > PENDING_IMPORT_TTL_MS;

  /* ------------------------------ detail / stats ------------------------------ */

  const detailOf = (id: string) => {
    const item = repo.findById(id);
    if (item === null) return null;
    const resolved = repo.resolveContext(refOf(item), { userId });

    // 溯源记录是"胜者 vs 败者"的成对关系，本条目可能站在任一侧
    const conflicts = resolved.conflicts
      .filter((trace) => trace.winnerId === id || trace.loserId === id)
      .map((trace) => {
        const isWinner = trace.winnerId === id;
        return {
          role: isWinner ? ('winner' as const) : ('loser' as const),
          counterpartId: isWinner ? trace.loserId : trace.winnerId,
          counterpartTitle: isWinner ? trace.loserTitle : trace.winnerTitle,
          counterpartLayer: isWinner ? trace.loserLayer : trace.winnerLayer,
          field: trace.field,
          ownValue: isWinner ? trace.winnerValue : trace.loserValue,
          counterpartValue: isWinner ? trace.loserValue : trace.winnerValue,
        };
      });

    const coverage: CoverageMark | null =
      resolved.coverage.find((mark) => mark.winnerId === id) ?? null;

    return { item, conflicts, coverage, violations: violationsOf(item) };
  };

  const statsOf = (projectId: string | null) => {
    const layers = repo.countByLayer(userId, projectId);
    const activeIssues = repo.count({
      userId,
      scopes: ['issue'],
      issueStatus: 'unsolved',
      status: 'active',
      ...(projectId !== null ? { projectId } : {}),
    });
    const longtermCount = repo.count({ userId, scopes: ['longterm'], status: 'active' });
    return { layers, activeIssues, longtermCount, longtermLimit: 500 };
  };

  /* ------------------------------ 路由 ------------------------------ */

  /**
   * 记忆域分发（同步实现）。
   *
   * 本域的全部方法都是本地 SQLite 调用（无 `await`），因此同一份实现在两条通道上复用：
   * - 异步 `invoke`（导出 / 导入预览与提交等方法虽在渲染层是异步契约，返回的也是立即 resolve 的 Promise）；
   * - 同步 `invokeSync`（`MemoryApi` 的同步签名方法，白名单见 shell-api 的 `DOMAIN_SYNC_METHODS`）。
   *
   * 两条通道共用一份分发，避免同一方法出现两份会各自漂移的实现。
   */
  const dispatch = (method: string, params: Record<string, unknown>): unknown => {
    switch (method) {
      /* --------- 同步读的拉取口（渲染层快照缓存的刷新入口） --------- */
      case 'listProjects': {
        const rows = options.db
          .prepare(
            `SELECT id, name FROM project WHERE deleted_at IS NULL ORDER BY updated_at DESC`,
          )
          .all() as Array<{ id: string; name: string }>;
        return rows;
      }

      case 'stats': {
        const input = params as { userId: string; projectId: string | null };
        return statsOf(input.projectId ?? null);
      }

      case 'list': {
        const input = params as {
          userId: string;
          projectId: string | null;
          query: Record<string, unknown>;
        };
        const q = input.query ?? {};
        const activeIssuesOnly = q['activeIssuesOnly'] === true;
        const items = repo.list({
          userId,
          ...(input.projectId !== null && input.projectId !== undefined
            ? { projectId: input.projectId }
            : {}),
          ...(Array.isArray(q['layers']) ? { layers: q['layers'] as MemoryLayer[] } : {}),
          ...(activeIssuesOnly && !Array.isArray(q['scopes'])
            ? { scopes: ['issue'] as MemoryScope[] }
            : Array.isArray(q['scopes'])
              ? { scopes: q['scopes'] as MemoryScope[] }
              : {}),
          ...(activeIssuesOnly ? { issueStatus: 'unsolved' as const } : {}),
          ...(Array.isArray(q['tags']) ? { tags: q['tags'] as string[] } : {}),
          ...(q['status'] !== undefined
            ? { status: q['status'] as MemoryStatus | readonly MemoryStatus[] }
            : {}),
          ...(typeof q['text'] === 'string' && q['text'].length > 0 ? { text: q['text'] } : {}),
          ...(typeof q['orderBy'] === 'string'
            ? { orderBy: q['orderBy'] as 'importance' | 'updatedAt' | 'createdAt' | 'title' }
            : {}),
          ...(q['direction'] === 'asc' || q['direction'] === 'desc'
            ? { direction: q['direction'] }
            : {}),
          ...(typeof q['limit'] === 'number' ? { limit: q['limit'] } : {}),
        });
        return items;
      }

      case 'detail':
        return detailOf(String(params['id']));

      case 'conflictIndex': {
        const input = params as { userId: string; projectId: string | null };
        const items = repo.list({
          userId,
          ...(input.projectId !== null && input.projectId !== undefined
            ? { projectId: input.projectId }
            : {}),
        });
        // 同槽位条目批量两两比对：冲突索引是列表页的批量读，不值得逐条 resolveContext
        const index: Record<string, Array<Record<string, unknown>>> = {};
        for (const item of items) {
          const annotations: Array<Record<string, unknown>> = [];
          for (const other of items) {
            if (other.id === item.id) continue;
            const matches = detectPair(item, other);
            for (const match of matches) {
              annotations.push({
                role: 'winner',
                counterpartId: other.id,
                counterpartTitle: other.title,
                counterpartLayer: layerOf(other),
                field: match.field,
                ownValue: match.localValue,
                counterpartValue: match.incomingValue,
              });
            }
          }
          if (annotations.length > 0) index[item.id] = annotations;
        }
        return index;
      }

      case 'context': {
        const input = params as {
          userId: string;
          projectId: string;
          featureId?: string | null;
          pageId?: string | null;
          elementId?: string | null;
        };
        const ref = contextRef(input);
        const resolved = repo.resolveContext(ref, { userId });
        const chain = repo.candidatesFor(ref, { userId });
        const layers = (['longterm', 'project', 'feature', 'page', 'element', 'issue'] as const)
          .map((layer) => ({
            layer,
            items: chain.filter((item) => isRelevantTo(item, ref) && layerOf(item) === layer),
          }))
          .filter((entry) => entry.items.length > 0);
        return {
          layers,
          effectiveIds: resolved.effective.map((item) => item.id),
          overriddenIds: resolved.overridden.map((item) => item.id),
          conflictCount: resolved.conflicts.length,
        };
      }

      /* ------------------------------ 编辑与批量 ------------------------------ */
      case 'create': {
        const draft = params as {
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
          issueStatus?: MemoryItem['issueStatus'];
        };
        return repo.create({ ...draft, userId });
      }

      case 'update': {
        const id = String(params['id']);
        const patch = (params['patch'] ?? {}) as MemoryPatch;
        const expected =
          typeof params['expectedVersion'] === 'number' ? params['expectedVersion'] : undefined;
        const current = repo.findById(id);
        if (current === null) throw new ShellError('NOT_FOUND', `记忆不存在：${id}`);
        if (expected !== undefined && current.version !== expected) {
          throw new ShellError(
            'INVALID_ARGUMENT',
            `记忆已被修改（期望版本 ${expected}，当前 ${current.version}），请刷新后重试`,
          );
        }
        return repo.update(id, patch, expected);
      }

      case 'setPinned': {
        const id = String(params['id']);
        const item = repo.findById(id);
        if (item === null) throw new ShellError('NOT_FOUND', `记忆不存在：${id}`);
        return repo.update(id, { pinned: params['pinned'] === true });
      }

      case 'setIssueStatus': {
        const id = String(params['id']);
        const next = params['next'] as MemoryItem['issueStatus'];
        if (next === null || next === undefined) {
          throw new ShellError('INVALID_ARGUMENT', 'setIssueStatus 缺少目标状态');
        }
        const item = repo.findById(id);
        if (item === null) throw new ShellError('NOT_FOUND', `记忆不存在：${id}`);
        if (item.scope !== 'issue') {
          throw new ShellError('INVALID_ARGUMENT', `条目 ${id} 不是问题记忆，无法设置处置状态`);
        }
        const explicit = params['explicit'] === true;
        return repo.setIssueStatus(id, next, explicit ? { explicit: true } : {});
      }

      case 'moveLayer': {
        const ids = (params['ids'] as readonly string[] | undefined) ?? [];
        const target = (params['target'] ?? {}) as {
          scope: MemoryScope;
          projectId?: string | null;
          featureId?: string | null;
          pageId?: string | null;
          elementId?: string | null;
          issueId?: string | null;
        };
        const out: MemoryItem[] = [];
        for (const id of ids) {
          const item = repo.findById(id);
          if (item === null) continue;
          out.push(
            repo.moveLayer(id, {
              scope: target.scope,
              projectId: target.projectId ?? null,
              featureId: target.featureId ?? null,
              pageId: target.pageId ?? null,
              elementId: target.elementId ?? null,
              issueId: target.issueId ?? null,
            }),
          );
        }
        return out;
      }

      case 'remove': {
        const ids = (params['ids'] as readonly string[] | undefined) ?? [];
        const removedIds: string[] = [];
        for (const id of ids) {
          const item = repo.findById(id);
          if (item === null) continue;
          // 归档即"可恢复的删除"：记忆表无 deleted_at，物理删除无法撤销
          repo.setStatus(id, 'archived');
          removedIds.push(id);
        }
        return { removedIds };
      }

      case 'restore': {
        const ids = (params['ids'] as readonly string[] | undefined) ?? [];
        for (const id of ids) {
          const item = repo.findById(id);
          if (item === null) continue;
          // 已归档 → 生效中；若条目本就处于生效态则跳过，避免状态机抛非法流转
          if (item.status === 'archived') repo.setStatus(id, 'active');
        }
        return undefined;
      }

      case 'changeLog': {
        const input = params as { userId: string; memoryId?: string; limit?: number };
        const rows: ChangeLogRecord[] = repo.changes.list({
          userId,
          ...(typeof input.memoryId === 'string' && input.memoryId.length > 0
            ? { memoryId: input.memoryId }
            : {}),
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        });
        return rows;
      }

      /* ------------------------------ 导入导出 ------------------------------ */
      case 'exportMemories': {
        const request = params as { format: 'json' | 'markdown' };
        const outcome = exportAll(repo, { userId, projectId: null, format: request.format });
        if ('json' in outcome) {
          return { files: [{ name: 'memories.json', content: outcome.json }] };
        }
        // 渲染层契约是 `{ name, content }`，而领域层给的是相对路径 `path`
        return {
          files: outcome.files.map((file) => ({ name: file.path, content: file.content })),
        };
      }

      case 'importPreview': {
        const input = params as {
          userId: string;
          files: Array<{ name: string; content: string }>;
        };
        const incoming = parseImportFiles(input.files);
        const local = repo.list({ userId });
        const preview = classifyImport(incoming, local);
        pendingImports.set(userId, { incoming, at: Date.now() });
        return {
          rows: preview.items.map((diff) => ({
            id: diff.incoming.id,
            title: diff.incoming.title,
            classification: diff.classification,
            localTitle: diff.local?.title ?? null,
            incomingTitle: diff.incoming.title,
            localUpdatedAt: diff.local?.updatedAt ?? null,
            incomingUpdatedAt: diff.incoming.updatedAt,
          })),
          counts: preview.counts as Record<ImportClassification, number>,
        };
      }

      case 'importCommit': {
        const request = params as {
          userId: string;
          decisions: Array<{ id: string; resolution: ImportResolution }>;
        };
        const pending = pendingImports.get(userId);
        if (pending === undefined || staleImport(pending.at)) {
          pendingImports.delete(userId);
          throw new ShellError(
            'NOT_FOUND',
            '导入预览已失效（超过 30 分钟或进程已重启），请重新选择文件预览',
          );
        }
        pendingImports.delete(userId);
        const local = repo.list({ userId });
        const preview = classifyImport(pending.incoming, local);
        const decisions: MergeDecision[] = request.decisions.map((decision) => ({
          id: decision.id,
          strategy: decision.resolution,
        }));
        const plan = planMerge(preview, decisions);
        return commitMergePlan(repo, plan);
      }

      default:
        throw new ShellError('INVALID_ARGUMENT', `memory 域未知方法：${method}`);
    }
  };

  const router: DomainRouter = async (method, params) => dispatch(method, params);
  const syncRouter: SyncDomainRouter = (method, params) => dispatch(method, params);

  return { router, syncRouter };
}

/* ------------------------------ 辅助 ------------------------------ */

/**
 * 同槽位两条目的冲突比对。
 *
 * 直接复用领域层的 `detectConflicts`（标题键 + structured 叶子路径两套规则），
 * 不在此另写一套——两处口径一旦漂移，冲突徽标与详情面板会互相矛盾。
 */
function detectPair(
  local: MemoryItem,
  incoming: MemoryItem,
): Array<{ field: string; localValue: unknown; incomingValue: unknown }> {
  return detectConflicts(local, incoming).map((match) => ({
    field: match.field,
    localValue: match.localValue,
    incomingValue: match.incomingValue,
  }));
}

/** 按扩展名把渲染层递来的文件折成 `readImport` 的三种来源 */
function parseImportFiles(files: Array<{ name: string; content: string }>): MemoryItem[] {
  const items: MemoryItem[] = [];
  const markdown: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.jsonl')) {
      items.push(...readImport({ kind: 'jsonl', raw: file.content }).items);
    } else if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      markdown.push({ path: file.name, content: file.content });
    } else {
      items.push(...readImport({ kind: 'json', raw: file.content }).items);
    }
  }
  if (markdown.length > 0) {
    items.push(...readImport({ kind: 'markdown', files: markdown }).items);
  }
  return items;
}

/** 路由错误统一为 ShellError（runtime 层会再脱敏一次） */
export function memoryError(error: unknown): never {
  const wrapped: DomainRpcError = {
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
  };
  throw new ShellError(wrapped.code, wrapped.message);
}
