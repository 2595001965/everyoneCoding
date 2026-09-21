import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ancestorChain, findById, type ElementNode, type PageDsl } from '@ec/designer/dsl';
import { ShellError } from '@ec/shell-api';

/**
 * 页面 DSL 的**只读**装载器（T12-02：上下文引擎与设计器端口的共用底座）。
 *
 * 为什么单独成文件：上下文组装需要「选中元素 → 所属页面 → 祖先链 + 页面摘要」，
 * 而设计器端口需要「页面清单 → 路由总表 → 页面记忆」。两边都从
 * `<projectsDir>/<projectId>/design/pages/<pageId>.dsl.json` 读同一份信封，
 * 若各写一份解析逻辑，两处对「坏文件」「旧版本信封」的容忍度必然漂移。
 *
 * 两条刻意的选择：
 * 1. **容忍坏文件**：单页 JSON 损坏时跳过该页而不是抛错 —— 上下文组装不该因为
 *    一个写了一半的 DSL 文件整体失败（页面上仍会有 `skipped` 提示）。
 * 2. **不缓存**：页面文件是本地小文件（每页几 KB），一次组装最多读几十个文件。
 *    加缓存就得处理失效（设计器写入时通知谁、外部编辑怎么办），
 *    在没有实测性能问题前不值得引入这份复杂度。
 */

export interface LoadedPage {
  pageId: string;
  page: PageDsl;
  /** 所属文件名（相对 pages 目录） */
  fileName: string;
}

export interface ElementLookup {
  page: PageDsl;
  /** 根 → 选中元素（含自身）；元素不存在时为空数组 */
  chain: ElementNode[];
}

export function createPageDslReader(options: { projectsDir: string }): {
  pagesDirOf(projectId: string): string;
  listPages(projectId: string): LoadedPage[];
  readPage(projectId: string, pageId: string): LoadedPage | null;
  findElement(projectId: string, elementId: string): ElementLookup | null;
} {
  const pagesDirOf = (projectId: string): string => {
    const base = join(options.projectsDir, projectId, 'design', 'pages');
    return base;
  };

  const parseFile = (fileName: string): LoadedPage | null => {
    const full = fileName;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(full, 'utf8')) as unknown;
    } catch {
      return null;
    }
    if (raw === null || typeof raw !== 'object') return null;
    // 仅接受「信封 + 页面」结构：`{ dslVersion, page }`
    const envelope = raw as { dslVersion?: unknown; page?: unknown };
    const page = envelope.page;
    if (page === null || typeof page !== 'object') return null;
    const dsl = page as PageDsl;
    if (typeof dsl.id !== 'string' || dsl.tree === null || typeof dsl.tree !== 'object') return null;
    return { pageId: dsl.id, page: dsl, fileName };
  };

  const listPages = (projectId: string): LoadedPage[] => {
    const dir = pagesDirOf(projectId);
    if (!existsSync(dir)) return [];
    const loaded: LoadedPage[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.dsl.json')) continue;
      const page = parseFile(join(dir, entry));
      if (page !== null) loaded.push(page);
    }
    return loaded;
  };

  const readPage = (projectId: string, pageId: string): LoadedPage | null => {
    const file = join(pagesDirOf(projectId), `${pageId}.dsl.json`);
    if (!existsSync(file)) return null;
    return parseFile(file);
  };

  const findElement = (projectId: string, elementId: string): ElementLookup | null => {
    for (const loaded of listPages(projectId)) {
      const node = findById(loaded.page.tree, elementId);
      if (node === null) continue;
      return { page: loaded.page, chain: [...ancestorChain(loaded.page.tree, elementId), node] };
    }
    return null;
  };

  return { pagesDirOf, listPages, readPage, findElement };
}

/** 页面文件路径守卫（越界或项目不存在时报结构化错误） */
export function requireProjectDir(projectsDir: string, projectId: string): string {
  if (projectId.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 projectId');
  const dir = join(projectsDir, projectId);
  if (!existsSync(dir)) throw new ShellError('NOT_FOUND', `项目不存在：${projectId}`);
  return dir;
}
