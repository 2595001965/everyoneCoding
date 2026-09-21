import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import {
  EMPTY_NAV_SOURCE,
  JumpService,
  ReverseJumpService,
  buildRelationGraph,
  resolveHoverTargets,
  type CodeAnchor,
  type CodeAnchorRow,
  type JumpOutcome,
  type JumpResolution,
  type NavElementRef,
  type NavPageRef,
  type NavSourcePort,
  type NavTarget,
  type RelationGraph,
  type ReverseJumpResult,
} from '@ec/ai';
import { fromCodeAnchorRow } from '@ec/ai';
import { ShellError } from '@ec/shell-api';

import { createProjectPaths, type ProjectPaths } from '../paths';
import type { DomainRouter } from '../runtime';

/**
 * nav 域生产路由（T12-04 导航部分）。
 *
 * 装配口径：把「设计器 DSL + `code_anchor` 表 + 真实代码文件」映射成
 * `@ec/ai` 的 `NavSourcePort`，再把三个纯逻辑服务（JumpService / ReverseJumpService /
 * buildRelationGraph）接上去。域内**只读**，不修改任何文件（nav 的硬约束）。
 *
 * 与前一轮的差别：此前这里是"直接查 `code_anchor` 表拼一个 NavTarget 数组"，
 * 绕过了领域层的评分与分层逻辑，于是「悬停目标按相关度排序」「多锚点层级下拉」
 * 「双向跳转成功率统计」三件事都拿不到真实数据（统计恒为 0/0）。现在统一走领域服务，
 * 评分、分层、统计都由 `@ec/ai` 负责，域只提供数据。
 *
 * 反向跳转的两条路（都保留，先精确后兜底）：
 * 1. `ReverseJumpService` 扫代码里的 `// @everyonecoding:anchor <elementId>` 注释标记（命中即精确行）；
 * 2. 若该行没有标记，退回 `code_anchor` 的 `start_line..end_line` 区间判定——
 *    否则"生成时没写注释标记"的工程反向跳转成功率会直接掉到 0。
 */

export interface NavRequestLogEntry {
  id: string;
  at: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  source: string;
}

export interface DataFlowStep {
  id: string;
  kind: 'element' | 'event' | 'api' | 'backend' | 'writeback' | 'render';
  label: string;
  detail: string | null;
  at: number | null;
  ok: boolean;
}

export interface NavDomainOptions {
  db: Database.Database;
  projectsDir: string;
  /** 预览请求日志（由 preview 域提供）：数据流可视化的真实来源 */
  readRequestLogs: (projectId: string) => readonly NavRequestLogEntry[];
  /** 进程内事件的动作流执行记录（预留；未装配时返回空） */
  readActionTraces?: (projectId: string) => readonly DataFlowStep[];
}

export function createNavDomain(options: NavDomainOptions): DomainRouter {
  const paths: ProjectPaths = createProjectPaths({ projectsDir: options.projectsDir });
  const db = options.db;

  /* ------------------------------ 数据源 ------------------------------ */

  const anchorsOf = (projectId: string): CodeAnchor[] =>
    (
      db.prepare(`SELECT * FROM code_anchor WHERE project_id = ?`).all(projectId) as CodeAnchorRow[]
    ).map(fromCodeAnchorRow);

  const pagesOf = (projectId: string): NavPageRef[] => {
    const dir = paths.pagesDir(projectId);
    if (!existsSync(dir)) return [];
    const pages: NavPageRef[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return pages;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.dsl.json')) continue;
      const text = readTextSafe(join(dir, entry));
      if (text === null) continue;
      let parsed: Record<string, unknown> | null;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue; // 坏 DSL 跳过，不炸图
      }
      const page = (parsed['page'] ?? parsed) as Record<string, unknown>;
      const pageId = String(page['id'] ?? entry.replace('.dsl.json', ''));
      const pageName = String(page['name'] ?? pageId);
      const elements: NavElementRef[] = [];
      const push = (node: unknown): void => {
        if (node === null || typeof node !== 'object') return;
        const record = node as Record<string, unknown>;
        const id = typeof record['id'] === 'string' ? record['id'] : '';
        if (id.length > 0) {
          elements.push({
            elementId: id,
            name: typeof record['name'] === 'string' ? record['name'] : id,
            type: typeof record['type'] === 'string' ? record['type'] : 'Unknown',
            pageId,
            pageName,
          });
        }
        const children = record['children'];
        if (Array.isArray(children)) for (const child of children) push(child);
      };
      push(page['tree']);
      pages.push({
        pageId,
        name: pageName,
        route: String(page['route'] ?? `/${pageId}`),
        featureId: typeof page['featureId'] === 'string' ? page['featureId'] : null,
        elements,
        apiDeps: Array.isArray(page['apiDeps']) ? (page['apiDeps'] as string[]).map(String) : [],
      });
    }
    return pages;
  };

  const codeFilesOf = (projectId: string, limit = 600): string[] => {
    const root = paths.codeRoot(projectId);
    const out: string[] = [];
    if (!existsSync(root)) return out;
    const walk = (dir: string, depth: number): void => {
      if (depth > 10 || out.length >= limit) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= limit) return;
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist')
          continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|java)$/.test(entry.name)) continue;
        out.push(paths.relative(root, full));
      }
    };
    walk(root, 0);
    return out;
  };

  const moduleRoleOf = (filePath: string): 'controller' | 'service' | 'repo' | 'other' => {
    if (/controller|Controller/.test(filePath)) return 'controller';
    if (/service|Service/.test(filePath)) return 'service';
    if (/repo|repository|dao|Dao/.test(filePath)) return 'repo';
    return 'other';
  };

  const docSectionsOf = (
    projectId: string,
  ): Array<{
    id: string;
    title: string;
    documentId: string;
    documentTitle: string;
    anchor: string;
  }> => {
    const rows = db
      .prepare(`SELECT id, title, content_text FROM document WHERE project_id = ? LIMIT 40`)
      .all(projectId) as Array<{ id: string; title: string; content_text: string | null }>;
    const sections = [];
    for (const row of rows) {
      const lines = (row.content_text ?? '').split('\n');
      let index = 0;
      for (const line of lines) {
        const matched = /^(#{1,4})\s+(.+)$/.exec(line.trim());
        if (matched === null) continue;
        index += 1;
        const title = (matched[2] ?? '').trim();
        sections.push({
          id: `doc:${row.id}:${index}`,
          title,
          documentId: row.id,
          documentTitle: row.title,
          anchor: `${row.id}#h${index}`,
        });
      }
    }
    return sections;
  };

  const sourceOf = (projectId: string): NavSourcePort => {
    const files = codeFilesOf(projectId);
    const pages = pagesOf(projectId);
    return {
      listAnchors: () => anchorsOf(projectId),
      listPages: () => pages,
      // 接口清单没有独立台账：从 DSL 的 apiDeps 里解析 `METHOD /path` 形态的依赖，
      // 解析不出来的（只有接口 id）如实跳过，不编造路由
      listApis: () => {
        const apis = [];
        const seen = new Set<string>();
        for (const page of pages) {
          for (const dep of page.apiDeps) {
            const matched = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/i.exec(dep.trim());
            if (matched === null) continue;
            const key = `${matched[1]}:${matched[2]}`;
            if (seen.has(key)) continue;
            seen.add(key);
            apis.push({
              id: `api:${key}`,
              name: dep.trim(),
              method: (matched[1] ?? 'GET').toUpperCase(),
              path: matched[2] ?? '/',
              module: page.featureId,
            });
          }
        }
        return apis;
      },
      // 无数据库 schema 台账：返回空数组而不是伪造表名
      listTables: () => [],
      listTests: () =>
        files
          .filter((file) => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file) || /_test\.py$/.test(file))
          .slice(0, 50)
          .map((file) => ({
            id: `test:${file}`,
            name: file,
            filePath: file,
            coversApi: null,
          })),
      listDocSections: () => docSectionsOf(projectId),
      listModules: () =>
        files.slice(0, 200).map((file) => ({
          id: `module:${file}`,
          name: file,
          filePath: file,
          role: moduleRoleOf(file),
        })),
      readFile: (path) => {
        try {
          return readTextSafe(paths.inside(paths.codeRoot(projectId), path));
        } catch {
          return null;
        }
      },
      listCodeFiles: () => files,
    };
  };

  /* ------------------------------ 服务缓存 ------------------------------ */

  interface NavServices {
    jump: JumpService;
    reverse: ReverseJumpService;
    source: NavSourcePort;
  }
  const cache = new Map<string, NavServices>();

  const servicesOf = (projectId: string): NavServices => {
    const cached = cache.get(projectId);
    if (cached !== undefined) return cached;
    const source = sourceOf(projectId);
    const built: NavServices = {
      source,
      jump: new JumpService({ source }),
      reverse: new ReverseJumpService({ source }),
    };
    cache.set(projectId, built);
    return built;
  };

  const requireProject = (params: Record<string, unknown>): string => {
    const projectId = String(params['projectId'] ?? '');
    if (projectId.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 projectId');
    // 即便本域只做只读查询，projectId 仍要过同一套工程根校验（T12-04 要点 1）：
    // 放任 `../..` 进来，后面 `paths.codeRoot` 一拼就会去读别人的目录。
    paths.projectRoot(projectId);
    return projectId;
  };

  /**
   * 解析渲染层给的请求（`{pageId, elementId, elementName, currentFile}`）为领域输入。
   *
   * 页面缺省时按元素所在页面反查——渲染层在"从代码视图反向跳回"的场景里
   * 只知道 elementId，硬要求它同时给出 pageId 会让调用方到处补数据。
   */
  const resolveRequest = (
    services: NavServices,
    request: Record<string, unknown>,
  ): { page: NavPageRef; element: NavElementRef; currentFile: string | null } => {
    const elementId = String(request['elementId'] ?? '');
    const pages = services.source.listPages();
    let page = pages.find((item) => item.pageId === String(request['pageId'] ?? '')) ?? null;
    let element: NavElementRef | null = null;
    for (const candidate of pages) {
      const found = candidate.elements.find((item) => item.elementId === elementId);
      if (found !== undefined) {
        element = found;
        page = candidate;
        break;
      }
    }
    if (page === null) {
      throw new ShellError('NOT_FOUND', '未找到该元素所属页面，请先在设计器中打开该页面');
    }
    if (element === null) {
      // 元素可能尚未写入 DSL（草稿态）：用请求里的名字兜一个只读投影，
      // 让"按名字 + 锚点"仍能定位到 Controller（E2E-06 的关键路径）
      element = {
        elementId: elementId.length > 0 ? elementId : 'unknown',
        name: String(request['elementName'] ?? elementId),
        type: 'Unknown',
        pageId: page.pageId,
        pageName: page.name,
      };
    }
    return {
      page,
      element,
      currentFile: typeof request['currentFile'] === 'string' ? request['currentFile'] : null,
    };
  };

  /* ------------------------------ 数据流 ------------------------------ */

  const dataFlowOf = (projectId: string, elementId: string): DataFlowStep[] => {
    const services = servicesOf(projectId);
    const steps: DataFlowStep[] = [];
    const pages = services.source.listPages();
    let element: NavElementRef | null = null;
    let page: NavPageRef | null = null;
    for (const candidate of pages) {
      const found = candidate.elements.find((item) => item.elementId === elementId);
      if (found !== undefined) {
        element = found;
        page = candidate;
        break;
      }
    }
    if (element === null || page === null) return steps;

    steps.push({
      id: 'step-element',
      kind: 'element',
      label: `${element.type} · ${element.name}`,
      detail: `页面 ${page.name}（${page.route}）`,
      at: null,
      ok: true,
    });

    const anchors = services.source.listAnchors().filter((item) => item.elementId === elementId);
    steps.push({
      id: 'step-event',
      kind: 'event',
      label: anchors.length > 0 ? '已登记事件与锚点' : '未登记事件锚点',
      detail:
        anchors.length > 0
          ? anchors.map((item) => `${item.kind}:${item.symbol ?? item.filePath}`).join('、')
          : '该元素尚未生成带锚点的代码，事件链路无从观测',
      at: null,
      ok: anchors.length > 0,
    });

    // 预览请求日志是"接口是否真的被打到"的唯一证据来源
    const logs = options.readRequestLogs(projectId);
    const apiDep = page.apiDeps.find((dep) => dep.length > 0) ?? null;
    const matched = apiDep === null ? undefined : logs.find((log) => apiDep.includes(log.url));
    steps.push({
      id: 'step-api',
      kind: 'api',
      label: matched === undefined ? '未观测到接口请求' : `${matched.method} ${matched.url}`,
      detail:
        matched === undefined
          ? '预览未运行或尚未触发该接口；数据流只在真实请求发生后才可展示'
          : `数据来源 ${matched.source}，状态 ${matched.status}，耗时 ${matched.durationMs}ms`,
      at: matched?.at ?? null,
      ok: matched !== undefined,
    });

    const backendAnchor = anchors.find((item) => item.kind === 'controller') ?? anchors[0] ?? null;
    steps.push({
      id: 'step-backend',
      kind: 'backend',
      label: backendAnchor?.symbol ?? '未定位后端处理点',
      detail:
        backendAnchor === null
          ? '该元素没有后端锚点，说明它当前是纯前端交互'
          : `${backendAnchor.filePath}:${backendAnchor.startLine ?? '?'}`,
      at: null,
      ok: backendAnchor !== null,
    });

    steps.push({
      id: 'step-writeback',
      kind: 'writeback',
      label: matched === undefined ? '无回写记录' : `响应 ${matched.status}`,
      detail:
        matched === undefined
          ? '未观测到响应，无法判定回写'
          : matched.status >= 200 && matched.status < 400
            ? '后端已返回成功响应，数据可回写至页面状态'
            : '后端返回了错误状态，回写链路中断',
      at: matched?.at ?? null,
      ok: matched !== undefined && matched.status >= 200 && matched.status < 400,
    });

    steps.push({
      id: 'step-render',
      kind: 'render',
      label: '元素重新渲染',
      detail:
        matched !== undefined && matched.status >= 200 && matched.status < 400
          ? '预览已根据响应重新渲染（由预览面板的刷新机制完成）'
          : '等待成功响应后才会重新渲染',
      at: matched?.at ?? null,
      ok: matched !== undefined && matched.status >= 200 && matched.status < 400,
    });
    return steps;
  };

  /* ------------------------------ 路由 ------------------------------ */

  const router: DomainRouter = async (method, params) => {
    const projectId = requireProject(params);

    switch (method) {
      case 'openProject': {
        const counts = db
          .prepare(`SELECT COUNT(*) AS n FROM code_anchor WHERE project_id = ?`)
          .get(projectId) as { n: number };
        return { projectId, anchors: counts.n };
      }

      case 'hoverTargets': {
        const services = servicesOf(projectId);
        const request = (params['request'] ?? params) as Record<string, unknown>;
        const { page, element } = resolveRequest(services, request);
        return resolveHoverTargets({
          element,
          page,
          anchors: services.source.listAnchors(),
          source: services.source,
        }) satisfies NavTarget[];
      }

      case 'resolveJump': {
        const services = servicesOf(projectId);
        const request = (params['request'] ?? params) as Record<string, unknown>;
        const { page, element, currentFile } = resolveRequest(services, request);
        return services.jump.resolve({
          projectId,
          page,
          element,
          ...(currentFile !== null ? { currentFile } : {}),
        }) satisfies JumpResolution;
      }

      case 'commitJump': {
        const services = servicesOf(projectId);
        const target = params['target'] as NavTarget | undefined;
        if (target === undefined || target === null) {
          throw new ShellError('INVALID_ARGUMENT', 'commitJump 需要跳转目标（target）');
        }
        return services.jump.commit(target) satisfies JumpOutcome;
      }

      case 'jumpStats': {
        const services = servicesOf(projectId);
        return {
          forward: services.jump.stats(),
          reverse: services.reverse.stats(),
        };
      }

      case 'relationGraph': {
        const services = servicesOf(projectId);
        return buildRelationGraph(services.source) satisfies RelationGraph;
      }

      case 'reverseJump': {
        const services = servicesOf(projectId);
        const input = (params['input'] ?? {}) as { filePath?: unknown; line?: unknown };
        const filePath = String(input.filePath ?? '');
        const line = Number(input.line ?? 0);
        // ① 注释标记（精确行）
        const byMarker = services.reverse.jumpFromCode({ filePath, line });
        if (byMarker.success) return byMarker satisfies ReverseJumpResult;

        // ② 兜底：`code_anchor` 的行区间（生成时没写注释标记的工程全靠这条）
        const row = db
          .prepare(
            `SELECT * FROM code_anchor
             WHERE project_id = ? AND file_path = ? AND start_line IS NOT NULL AND end_line IS NOT NULL
               AND ? >= start_line AND ? <= end_line
             ORDER BY start_line ASC LIMIT 1`,
          )
          .get(projectId, filePath, line, line) as CodeAnchorRow | undefined;
        if (row === undefined) {
          return {
            success: false,
            hits: [],
            message: `第 ${line} 行不在任何锚点范围内（标记与行区间均未命中）`,
          } satisfies ReverseJumpResult;
        }
        const anchor = fromCodeAnchorRow(row);
        const page = services.source
          .listPages()
          .find((item) => item.elements.some((el) => el.elementId === anchor.elementId));
        const element = page?.elements.find((el) => el.elementId === anchor.elementId) ?? null;
        return {
          success: true,
          hits: [
            {
              elementId: anchor.elementId ?? '',
              filePath,
              line,
              anchorId: anchor.id,
              element,
              page: page ?? null,
            },
          ],
          message:
            anchor.elementId === null
              ? '命中锚点，但该锚点未关联设计器元素'
              : `跳回设计器元素 ${anchor.elementId}`,
        } satisfies ReverseJumpResult;
      }

      case 'dataFlow':
        return dataFlowOf(projectId, String(params['elementId'] ?? ''));

      default:
        throw new ShellError('INVALID_ARGUMENT', `nav 域未知方法：${method}`);
    }
  };

  return router;
}

/** 空数据源（测试与降级用；导出便于主进程集成测试断言"未装配时的形状"） */
export const NAV_EMPTY_SOURCE: NavSourcePort = EMPTY_NAV_SOURCE;

function readTextSafe(file: string): string | null {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
