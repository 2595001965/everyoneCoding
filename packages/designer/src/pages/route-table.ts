/**
 * route-table：由 PageDsl[] 生成路由总表，并做冲突 / 合法性检测（T3-07）。
 *
 * 涉及：
 * - `parseRouteParams` / `normalizePath`：路径解析与归一化；
 * - `generateRouteTable`：每个页面 => 一条 RouteEntry；
 * - `detectRouteIssues`：同平台路径重复 / 非法路径 / 含参数未声明；
 * - `buildRouteEdges`：从事件流里提取 navigate 动作，得到路由图边；
 * - `patchPageEventAction`：路由编辑器写回某条 navigate 动作；
 * - `useRouteMemorySync`：路由总表变更时写入注入的项目记忆端口（缺省跳过，不报错）。
 *
 * 注意：**不 import @ec/memory**（会引入 better-sqlite3），一律走 ports.projectMemory。
 */
import * as React from 'react';

import type { ActionNode, EventDef, PageDsl, Platform, RouteEntry, RouteIssue, RouteParam } from '../dsl/types';
import { useDesignerPorts } from '../store/designer-context';

/** 提取路径中的 `:param` 参数名 */
export function parseRouteParams(path: string): string[] {
  const out: string[] = [];
  const regex = /:([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null = regex.exec(path);
  while (match !== null) {
    out.push(match[1] as string);
    match = regex.exec(path);
  }
  return out;
}

/** 归一化路径：去查询/哈希、补前导斜杠、合并重复斜杠、去尾斜杠（根除外） */
export function normalizePath(path: string): string {
  let p = (path ?? '').trim();
  const hashIndex = p.indexOf('#');
  if (hashIndex >= 0) p = p.slice(0, hashIndex);
  const queryIndex = p.indexOf('?');
  if (queryIndex >= 0) p = p.slice(0, queryIndex);
  if (p.length === 0) return '/';
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function isValidRoute(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (/\s/.test(path)) return false;
  return /^\/[A-Za-z0-9_\-/:]*$/.test(path);
}

/** 由页面集合生成路由总表 */
export function generateRouteTable(pages: readonly PageDsl[]): RouteEntry[] {
  return pages.map((page) => {
    const path = normalizePath(page.route);
    const params: RouteParam[] = parseRouteParams(path).map((name) => ({
      name,
      type: 'string',
      required: true,
    }));
    return {
      path,
      pageId: page.id,
      pageName: page.name,
      platform: page.platform,
      params,
    };
  });
}

/** 检测路由表问题：重复路径 / 非法路径 / 含参数未声明 */
export function detectRouteIssues(entries: readonly RouteEntry[]): RouteIssue[] {
  const issues: RouteIssue[] = [];

  // 非法路径
  for (const entry of entries) {
    if (!isValidRoute(entry.path)) {
      const suggestion = isValidRoute(normalizePath(entry.path)) ? normalizePath(entry.path) : '/';
      issues.push({
        code: 'INVALID_PATH',
        path: entry.path,
        pageIds: [entry.pageId],
        message: `路径 "${entry.path}" 不是合法路由（需以 / 开头且不含空格）`,
        suggestion,
      });
    }
  }

  // 同一平台下路径重复
  const byKey = new Map<string, RouteEntry[]>();
  for (const entry of entries) {
    const key = `${entry.platform}::${entry.path}`;
    const group = byKey.get(key);
    if (group) group.push(entry);
    else byKey.set(key, [entry]);
  }
  for (const group of byKey.values()) {
    if (group.length <= 1) continue;
    const path = group[0]?.path ?? '';
    const platform = group[0]?.platform as Platform;
    const pageIds = group.map((e) => e.pageId);
    issues.push({
      code: 'DUPLICATE_PATH',
      path,
      pageIds,
      message: `平台 ${platform} 上路径 "${path}" 被 ${pageIds.length} 个页面重复占用`,
      suggestion: `${path}-${pageIds[1] ?? pageIds[0] ?? ''}`,
    });
  }

  // 含参数未声明
  for (const entry of entries) {
    const declared = parseRouteParams(entry.path);
    if (declared.length > 0 && entry.params.length === 0) {
      issues.push({
        code: 'MISSING_PARAM',
        path: entry.path,
        pageIds: [entry.pageId],
        message: `路径 "${entry.path}" 含参数 ${declared.join(', ')} 但未在路由总表中声明`,
        suggestion: `为路径 "${entry.path}" 声明参数 ${declared.join(', ')}`,
      });
    }
  }

  return issues;
}

/** 路由图边：页面 -> 目标页面（navigate 动作） */
export interface RouteEdge {
  fromPageId: string;
  fromPageName: string;
  toPageId: string | null;
  toPageName: string | null;
  /** 目标路由（原始 action.target） */
  route: string;
  eventId: string;
  actionId: string;
  /** 该跳转携带的路由参数（来自 action.params.routeParams） */
  params: RouteParam[];
  label: string;
}

function actionParams(action: ActionNode): RouteParam[] {
  const raw = action.params?.routeParams;
  if (Array.isArray(raw)) {
    return raw as RouteParam[];
  }
  return [];
}

/** 从事件流提取 navigate 动作，得到路由图边 */
export function buildRouteEdges(pages: readonly PageDsl[]): RouteEdge[] {
  const byRoute = new Map<string, PageDsl>();
  for (const page of pages) byRoute.set(normalizePath(page.route), page);

  const edges: RouteEdge[] = [];
  for (const page of pages) {
    for (const event of page.events as EventDef[]) {
      for (const action of event.actions) {
        if (action.kind !== 'navigate' || !action.target) continue;
        const targetPage = byRoute.get(normalizePath(action.target)) ?? null;
        edges.push({
          fromPageId: page.id,
          fromPageName: page.name,
          toPageId: targetPage?.id ?? null,
          toPageName: targetPage?.name ?? null,
          route: action.target,
          eventId: event.id,
          actionId: action.id,
          params: actionParams(action),
          label: `${page.name} → ${action.target}`,
        });
      }
    }
  }
  return edges;
}

/** 不可变更新某页面某事件里的某条 navigate 动作（写回目标路由 + 参数） */
export function patchPageEventAction(
  page: PageDsl,
  eventId: string,
  actionId: string,
  patch: { target?: string; params?: RouteParam[] },
): PageDsl {
  return {
    ...page,
    events: page.events.map((event) => {
      if (event.id !== eventId) return event;
      return {
        ...event,
        actions: event.actions.map((action) => {
          if (action.id !== actionId) return action;
          const next: ActionNode = { ...action };
          if (patch.target !== undefined) next.target = patch.target;
          if (patch.params !== undefined) {
            next.params = { ...(next.params ?? {}), routeParams: patch.params };
          }
          return next;
        }),
      };
    }),
  };
}

/**
 * 路由总表变更时写入项目记忆端口（写前读 / 合并 / 写回由端口实现负责）。
 * 端口缺省（EMPTY_PORTS）时跳过，不报错。
 */
export function useRouteMemorySync(projectId: string, pages: readonly PageDsl[]): void {
  const ports = useDesignerPorts();
  const routes = React.useMemo(() => generateRouteTable(pages), [pages]);
  React.useEffect(() => {
    const memory = ports.projectMemory;
    if (!memory) return;
    void memory.upsertRoutes({ projectId, routes });
  }, [projectId, routes, ports]);
}
