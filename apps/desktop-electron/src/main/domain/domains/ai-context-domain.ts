import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import {
  createContextEngine,
  type ContextAssemblyRequest,
  type ContextCodeHit,
  type ContextCodePort,
  type ContextDocumentPort,
  type ContextDocumentSnippet,
  type ContextElementNode,
  type ContextElementSource,
  type ContextMemoryHit,
  type ContextMemoryPort,
  type ContextMemoryQuery,
  type ContextNoteLike,
  type ContextNoteSource,
  type ContextNoteTargetRef,
  type ContextPageSummary,
  type DependencyContract,
} from '@ec/ai';
import {
  FtsKeywordSearcher,
  MemoryRepo,
  segmentQuery,
  type MemoryListQuery,
  type MemoryItem,
} from '@ec/memory';
import { ShellError } from '@ec/shell-api';

import type { DomainRouter } from '../runtime';
import { createDesignerNoteStore, type DesignerNoteStore } from '../designer-notes';
import { createPageDslReader } from '../designer-pages';

/**
 * ai-context 域生产路由（T12-02 上下文面板）。
 *
 * 这一版把「数据直供」换成了**真正的上下文引擎组装**：主进程构造
 * `@ec/ai` 的 `ContextEngine`，五个数据端口（记忆 / 备注 / 设计器 / 文档 / 代码）
 * 全部落在真实数据源上 —— 业务 SQLite（memory_item / note / document / code_anchor）
 * 与工程目录（页面 DSL、代码文件）。渲染层拿到的是完整的 `AssembledContext`：
 * 每块的 tokens / source / skipped / items，以及裁剪报告与引用溯源。
 *
 * 三个口径必须守住（否则面板会撒谎）：
 * 1. **块为空就如实写 skipped**：由块的 builder 决定文案（例如「该层级暂无记忆」），
 *    本域只负责把端口给对，绝不返回伪造的 content；
 * 2. **降级要自述**：只装配了关键词检索时，`ContextMemoryPort.describe()` 如实回答，
 *    面板的"来源"不再是写死的「双路召回」；
 * 3. **不做二次加工**：`system` / `user` / `messages` / `truncation` 一律原样回传，
 *    渲染层与主进程看到的必须是同一份内容（否则「所见即所提交」不成立）。
 */

export interface AiContextDomainOptions {
  db: Database.Database;
  projectsDir: string;
  userId: string;
  /** 与 designer 域共用同一份备注存储（禁止两处各持一份内存副本） */
  notes?: DesignerNoteStore | undefined;
}

function toHit(item: MemoryItem): ContextMemoryHit {
  return {
    id: item.id,
    scope: item.scope as ContextMemoryHit['scope'],
    title: item.title,
    content: item.content,
    structured: item.structured,
    importance: item.importance,
    confidence: item.confidence,
    tags: item.tags,
    updatedAt: item.updatedAt,
  };
}

/** 重要度 × 置信度排序（无检索命中时的兜底列举顺序） */
function rankByWeight(items: readonly MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => {
    const wa = a.importance * a.confidence;
    const wb = b.importance * b.confidence;
    if (wb !== wa) return wb - wa;
    return b.updatedAt - a.updatedAt;
  });
}

export function createAiContextDomain(options: AiContextDomainOptions): DomainRouter {
  const repo = new MemoryRepo(options.db);
  const notes = options.notes ?? createDesignerNoteStore({ db: options.db, userId: options.userId });
  const pages = createPageDslReader({ projectsDir: options.projectsDir });
  const keyword = new FtsKeywordSearcher(options.db);

  const codeRootOf = (projectId: string): string =>
    join(options.projectsDir, projectId, 'code');

  /* ------------------------------ 记忆端口 ------------------------------ */

  /**
   * 把上下文层的 `scope` 收敛成记忆表的候选集查询。
   *
   * 关键取舍：
   * - `longterm` 是**用户级**记忆（`project_id` 必须为空），不能按项目过滤，
   *   否则用户说过的"以后都用 TypeScript"永远进不了上下文；
   * - `page` 层同时装着「页面结构摘要」（element_id 为空）与「元素备注」
   *   （element_id 非空）。元素备注由备注块单独注入，这里只取页面结构；
   *   选中了元素时额外带上该元素的条目，让最具体的偏好能参与本次生成；
   * - `issue` 只要未解决的。
   */
  const candidatesOf = (input: ContextMemoryQuery): MemoryItem[] => {
    const base: MemoryListQuery = { userId: options.userId, status: 'active' };
    switch (input.scope) {
      case 'longterm':
        return repo.list({ ...base, scopes: ['longterm'] });
      case 'project':
        return repo.list({ ...base, scopes: ['project'], projectId: input.projectId });
      case 'feature':
        return repo.list({
          ...base,
          scopes: ['feature'],
          projectId: input.projectId,
          ...(typeof input.featureId === 'string' && input.featureId.length > 0
            ? { featureId: input.featureId }
            : {}),
        });
      case 'page': {
        const scoped = repo.list({
          ...base,
          scopes: ['page'],
          projectId: input.projectId,
          ...(typeof input.pageId === 'string' && input.pageId.length > 0
            ? { pageId: input.pageId }
            : {}),
        });
        return scoped.filter(
          (item) =>
            item.elementId === null ||
            (typeof input.elementId === 'string' && item.elementId === input.elementId),
        );
      }
      case 'issue':
        return repo.list({
          ...base,
          scopes: ['issue'],
          projectId: input.projectId,
          issueStatus: 'unsolved',
        });
      default:
        return [];
    }
  };

  const memoryPort: ContextMemoryPort = {
    describe: () =>
      keyword.mode === 'fts5'
        ? `关键词检索（FTS5 trigram）${keyword.degradedReason === null ? '' : `；${keyword.degradedReason}`}`
        : `关键词检索（bigram LIKE 降级；${keyword.degradedReason ?? 'FTS5 不可用'}）`,
    search(input) {
      const candidates = candidatesOf(input);
      if (candidates.length === 0) return [];
      // 候选集收敛到当前层级/归属后再做检索：避免 FTS 把别的页面、别的功能的记忆捞进来
      const hits = keyword.search(input.query, {
        limit: input.limit,
        filterIds: candidates.map((item) => item.id),
      });
      if (hits.length === 0) return rankByWeight(candidates).slice(0, input.limit).map(toHit);
      const byId = new Map(candidates.map((item) => [item.id, item]));
      const out: MemoryItem[] = [];
      for (const hit of hits) {
        const item = byId.get(hit.id);
        if (item !== undefined) out.push(item);
      }
      return out.map(toHit);
    },
    listByScope(input) {
      return rankByWeight(candidatesOf({ ...input, query: '' }))
        .slice(0, input.limit)
        .map(toHit);
    },
  };

  /* ------------------------------ 备注端口 ------------------------------ */

  const notePort: ContextNoteSource = {
    getNotesForContext(target: ContextNoteTargetRef): readonly ContextNoteLike[] {
      return notes.getNotesForContext({
        projectId: target.projectId,
        elementId: target.elementId ?? null,
        pageId: target.pageId ?? null,
        featureId: target.featureId ?? null,
      });
    },
    noteIdsUpdatedSince(target: ContextNoteTargetRef, since: number): readonly string[] {
      return notes.noteIdsUpdatedSince(
        {
          projectId: target.projectId,
          elementId: target.elementId ?? null,
          pageId: target.pageId ?? null,
          featureId: target.featureId ?? null,
        },
        since,
      );
    },
  };

  /* ------------------------------ 设计器端口 ------------------------------ */

  const toContextNode = (node: {
    id: string;
    type: string;
    name?: string | undefined;
    props?: Record<string, unknown> | undefined;
    bindings?: Record<string, string> | undefined;
    condition?: unknown;
    permission?: unknown;
  }): ContextElementNode => ({
    id: node.id,
    type: node.type,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.props !== undefined ? { props: node.props } : {}),
    ...(node.bindings !== undefined ? { bindings: node.bindings } : {}),
    ...(node.condition !== undefined && node.condition !== null
      ? { conditionSummary: JSON.stringify(node.condition) }
      : {}),
    ...(node.permission !== undefined && node.permission !== null
      ? { permissionSummary: JSON.stringify(node.permission) }
      : {}),
  });

  const elementPort: ContextElementSource = {
    getElementChain({ projectId, elementId }) {
      const found = pages.findElement(projectId, elementId);
      if (found === null) return [];
      return found.chain.map((node) => toContextNode(node));
    },
    getPageSummary({ projectId, pageId }): ContextPageSummary | null {
      const loaded = pages.readPage(projectId, pageId);
      if (loaded === null) return null;
      const page = loaded.page;
      return {
        pageId: page.id,
        name: page.name,
        route: page.route,
        platform: page.platform,
        state: (page.state ?? []).map((entry) => ({
          name: entry.name,
          type: entry.type,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
        })),
        apiDeps: page.apiDeps ?? [],
      };
    },
  };

  /* ------------------------------ 文档端口 ------------------------------ */

  interface DocSection {
    heading?: string;
    text: string;
  }

  const sectionsOf = (row: {
    title: string;
    content_text: string | null;
    sections_json: string | null;
  }): DocSection[] => {
    if (row.sections_json !== null && row.sections_json.trim().length > 0) {
      try {
        const parsed = JSON.parse(row.sections_json) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) {
          const sections: DocSection[] = [];
          for (const entry of parsed) {
            if (entry === null || typeof entry !== 'object') continue;
            const record = entry as { heading?: unknown; title?: unknown; text?: unknown };
            const heading =
              typeof record.heading === 'string'
                ? record.heading
                : typeof record.title === 'string'
                  ? record.title
                  : undefined;
            const text = typeof record.text === 'string' ? record.text : '';
            if (text.trim().length === 0 && heading === undefined) continue;
            sections.push({ ...(heading !== undefined ? { heading } : {}), text });
          }
          if (sections.length > 0) return sections;
        }
      } catch {
        // 章节索引损坏则退化为整篇一节
      }
    }
    const text = row.content_text ?? '';
    return text.trim().length === 0 ? [] : [{ heading: row.title, text }];
  };

  const mapDocKind = (kind: string): ContextDocumentSnippet['kind'] => {
    if (kind === 'requirement') return 'requirement';
    if (kind === 'tech') return 'techdoc';
    return 'other';
  };

  const documentPort: ContextDocumentPort = {
    searchRelevant(input) {
      const rows = options.db
        .prepare(
          `SELECT id, kind, title, content_text, sections_json FROM document
           WHERE project_id = ? AND deleted_at IS NULL
           ORDER BY updated_at DESC LIMIT 40`,
        )
        .all(input.projectId) as Array<{
        id: string;
        kind: string;
        title: string;
        content_text: string | null;
        sections_json: string | null;
      }>;
      if (rows.length === 0) return [];

      const needles = segmentQuery(input.query).filter((token) => token.length > 0);
      const results: ContextDocumentSnippet[] = [];
      for (const row of rows) {
        const kind = mapDocKind(row.kind);
        if (input.kinds !== undefined && input.kinds.length > 0 && !input.kinds.includes(kind)) {
          continue;
        }
        for (const [index, section] of sectionsOf(row).entries()) {
          const heading = section.heading ?? row.title;
          let score = 0;
          for (const needle of needles) {
            if (heading.includes(needle)) score += 0.6;
            if (section.text.includes(needle)) score += 0.4;
          }
          // 未命中任何关键词时给出基点分：需求/技术文档本身就是生成依据，
          // 全量丢弃会让"文档章节"块在有文档时反而为空
          if (score === 0) score = 0.1;
          results.push({
            id: `${row.id}#${index}`,
            documentId: row.id,
            title: row.title,
            kind,
            heading,
            content: section.text.slice(0, 2_000),
            score: Math.min(1, score),
          });
        }
      }
      return results
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, input.limit);
    },
  };

  /* ------------------------------ 代码端口 ------------------------------ */

  interface AnchorRow {
    id: string;
    element_id: string | null;
    page_id: string | null;
    file_path: string;
    symbol: string | null;
    start_line: number | null;
    end_line: number | null;
    kind: string;
  }

  const languageOf = (filePath: string): string => {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    switch (ext) {
      case '.ts':
      case '.tsx':
        return 'typescript';
      case '.js':
      case '.jsx':
        return 'javascript';
      case '.py':
        return 'python';
      case '.java':
        return 'java';
      case '.sql':
        return 'sql';
      case '.json':
        return 'json';
      default:
        return 'plaintext';
    }
  };

  /** 读取锚点声明的代码片段；文件被移动/删除或行号失效时返回空串（锚点仍如实上报） */
  const snippetOf = (
    root: string,
    row: AnchorRow,
  ): { snippet: string; startLine: number; endLine: number } => {
    const start = row.start_line ?? 1;
    const end = row.end_line ?? start;
    const full = join(root, row.file_path);
    if (!existsSync(full)) return { snippet: '', startLine: start, endLine: end };
    try {
      const lines = readFileSync(full, 'utf8').split('\n');
      const from = Math.max(0, start - 1);
      const to = Math.min(lines.length, end);
      return { snippet: lines.slice(from, to).join('\n').slice(0, 2_000), startLine: start, endLine: end };
    } catch {
      return { snippet: '', startLine: start, endLine: end };
    }
  };

  /**
   * 无锚点命中时的兜底：按符号名 / 文件名在工程目录里找文件，截取首次出现处的片段。
   *
   * 有界扫描（文件数 / 单文件大小 / 深度都设上限）：上下文组装有 300ms 的预算，
   * 不能让"顺便全仓 grep"把预算吃光；扫不到就如实少给几段代码。
   */
  const scanFiles = (root: string, needles: readonly string[], limit: number): ContextCodeHit[] => {
    if (!existsSync(root) || needles.length === 0) return [];
    const hits: ContextCodeHit[] = [];
    const walk = (dir: string, prefix: string, depth: number): void => {
      if (hits.length >= limit || depth > 6) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
      } catch {
        return;
      }
      for (const entry of entries) {
        if (hits.length >= limit) return;
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, rel, depth + 1);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|py|java|sql)$/.test(entry.name)) continue;
        let text: string;
        try {
          if (statSync(full).size > 200_000) continue;
          text = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split('\n');
        for (const needle of needles) {
          const index = lines.findIndex((line) => line.includes(needle));
          if (index < 0) continue;
          hits.push({
            filePath: rel,
            symbol: needle,
            kind: 'service',
            startLine: index + 1,
            endLine: Math.min(lines.length, index + 30),
            language: languageOf(rel),
            snippet: lines.slice(index, index + 30).join('\n').slice(0, 2_000),
            score: 0.4,
          });
          break;
        }
      }
    };
    walk(root, '', 0);
    return hits;
  };

  const codePort: ContextCodePort = {
    findRelated(input) {
      const root = codeRootOf(input.projectId);
      const rows = options.db
        .prepare(
          `SELECT id, element_id, page_id, file_path, symbol, start_line, end_line, kind
           FROM code_anchor WHERE project_id = ? ORDER BY updated_at DESC LIMIT 80`,
        )
        .all(input.projectId) as AnchorRow[];

      const anchored: ContextCodeHit[] = rows.map((row) => {
        const { snippet, startLine, endLine } = snippetOf(root, row);
        // 命中度：元素精确匹配最高，其次页面，最后是项目内其余锚点
        const score =
          input.elementId !== null && input.elementId !== undefined && row.element_id === input.elementId
            ? 1
            : row.element_id === null
              ? 0.6
              : 0.8;
        return {
          anchorId: row.id,
          filePath: row.file_path,
          symbol: row.symbol ?? '',
          kind: row.kind,
          startLine,
          endLine,
          language: languageOf(row.file_path),
          snippet,
          score,
        };
      });

      anchored.sort((a, b) => b.score - a.score);
      if (anchored.length > 0) return anchored.slice(0, input.limit);

      const needles = [
        ...(input.symbols ?? []),
        ...segmentQuery(input.query).filter((token) => token.length >= 3),
      ];
      return scanFiles(root, needles.slice(0, 4), input.limit);
    },
  };

  /* ------------------------------ 引擎与路由 ------------------------------ */

  const engine = createContextEngine({
    sources: {
      memory: memoryPort,
      notes: notePort,
      elements: elementPort,
      documents: documentPort,
      code: codePort,
    },
  });

  const router: DomainRouter = async (method, params) => {
    if (method !== 'assemble') {
      throw new ShellError('INVALID_ARGUMENT', `ai-context 域未知方法：${method}`);
    }
    const request = (params['request'] ?? {}) as Partial<ContextAssemblyRequest>;
    if (typeof request.projectId !== 'string' || request.projectId.length === 0) {
      throw new ShellError('INVALID_ARGUMENT', '缺少 projectId');
    }
    const contracts = (params['contracts'] ?? []) as DependencyContract[];
    if (contracts.length > 0) engine.setDependencyContracts(contracts);

    const full: ContextAssemblyRequest = {
      userId: options.userId,
      projectId: request.projectId,
      purpose: request.purpose ?? 'code',
      ...(request.target !== undefined ? { target: request.target } : {}),
      ...(request.elementId !== undefined ? { elementId: request.elementId } : {}),
      ...(request.pageId !== undefined ? { pageId: request.pageId } : {}),
      ...(request.featureId !== undefined ? { featureId: request.featureId } : {}),
      ...(request.instruction !== undefined ? { instruction: request.instruction } : {}),
      ...(request.history !== undefined ? { history: request.history } : {}),
      ...(request.disabledBlocks !== undefined ? { disabledBlocks: request.disabledBlocks } : {}),
      ...(request.overrides !== undefined ? { overrides: request.overrides } : {}),
      ...(request.budget !== undefined ? { budget: request.budget } : {}),
      ...(request.since !== undefined ? { since: request.since } : {}),
    };
    return engine.assemble(full);
  };

  return router;
}

/** 已接入的数据源（渲染层据此说明"哪些块会有内容"） */
export const AI_CONTEXT_SOURCES = ['memory', 'notes', 'elements', 'documents', 'code'] as const;
