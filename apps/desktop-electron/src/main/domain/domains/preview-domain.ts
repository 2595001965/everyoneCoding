import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  watch,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { connect } from 'node:net';
import { extname, join, relative } from 'node:path';
import type Database from 'better-sqlite3';

import { newUlid } from '@ec/data';
import { runPlanSchema, type RunPlan } from '@ec/core';

import {
  BackendRunner,
  BindingResolver,
  DEFAULT_MOCK_SETTINGS,
  DEFAULT_PREVIEW_PORT,
  DependencyInstaller,
  LogStream,
  MockResponseGenerator,
  OpenApiParseError,
  RuntimeOrchestrator,
  allocatePort,
  createFallbackOpenApi,
  detectProjectType,
  injectDomSelector,
  matchRoute,
  parseOpenApiDocument,
  suggestRunPlan,
  type DomAttachment,
  type HttpMethodName,
  type LoadedOpenApi,
  type ManagedProcess,
  type MockSettings,
  type ParsedPackage,
  type PreviewResult,
  type ProjectProfile,
  type ResolvedResponse,
  type RuntimeSnapshot,
  type RuntimeServiceSpec,
  type RuntimeSpec,
  type StreamedLogLine,
} from '@ec/preview';
import { ShellError } from '@ec/shell-api';

import type { ControlledProcessHost } from '../process-host';
import { createProjectPaths, PROJECT_SUBDIRS, type ProjectPaths } from '../paths';
import type { DomainRouter } from '../runtime';
import { createSettingStore, type SettingStore } from '../setting-store';
import { DomInspection } from '../dom-inspection';
import { DOM_COMPILE_PATH, DomViteBridge } from '../dom-vite-bridge';

/**
 * preview 域生产路由（T12-04 预览部分；V2-D02 补真实前端与多服务运行实例）。
 *
 * 交付的五件事：
 * 1. **静态预览**：Node http 服务托管构建产物（优先 `dist` / `build` / `public`，回退代码根），
 *    SPA 兜底到 `index.html`，端口从 4173 起顺延；
 * 2. **联动预览 + 真实后端托管**：后端子进程走**受控进程端口**（`../process-host.ts`），
 *    启动日志实时结构化回流（`preview:log` 域事件）+ 缓冲供 `logs()` 轮询；
 * 3. **Mock**：按项目 OpenAPI 草案（技术文档里的 yaml/json 围栏）生成响应，
 *    字段规则 / 延迟 / 错误率可配并持久化；
 * 4. **API 调试**：预览服务本身就是 API 的入口——每次请求都被记录（方法 / 路径 / 入参 /
 *    响应 / 耗时 / 状态码 / 数据来源），支持重放与复制 cURL；
 * 5. **多端**：探测 adb / hdc，给局域网地址与二维码；**局域网开关默认关闭**，
 *    开启时明确提示风险（D-09：不生成任何云端链接）。
 *
 * V2-D02 在同一预览服务上补三类增量（不重写既有静态/进程系统）：
 * - **运行实例（runtimeId）**：确认后的运行计划由 `RuntimeOrchestrator` 编排
 *   （安装 → Vite 前端 / Node 后端多服务），端口真实探测分配、就绪看"端口可连+页面可加载"，
 *   停止按 runtimeId 精准执行；预览服务反向代理前端 dev server（含 HMR 的 WebSocket 升级）。
 * - **显式 Mock**：默认 `real` 模式——真实后端不可用时如实报 502 诊断，不再自动回退
 *   Mock（V2 FR-PRV-02 修改）；用户显式切换到 `mock` 才用模拟数据，响应始终带
 *   `X-EC-Data-Source: mock` 标记。
 * - **项目缩略图**：从真实预览页截图并持久化到 `meta/thumbnail.png`（无渲染页面时保持
 *   null，由工作台卡片显示明确占位），workspace 域 `getThumbnailUrl` 据此返回可读地址。
 *
 * 数据来源优先级由 `BindingResolver` 保证；显式 Mock 开关在 resolver 之前由本域门控。
 */

const PREVIEW_MODE_KEYS = ['static', 'linked', 'device'] as const;
type PreviewMode = (typeof PREVIEW_MODE_KEYS)[number];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** 静态产物目录候选（按顺序探测第一个存在的） */
const STATIC_ROOT_CANDIDATES = ['dist', 'build', 'public', 'out', 'www', '.output/public'];

/** 请求体读取上限（1MB）：预览面板是开发工具，不是文件上传通道 */
const MAX_BODY_BYTES = 1_048_576;

/** API 请求日志保留条数 */
const MAX_REQUEST_LOGS = 500;

/** 局域网开关（默认关闭，D-09） */
const lanSharingKey = (scope: string): string => `preview_lan_sharing:${scope}`;
/** Mock 设置按项目存 */
const mockSettingsKey = (scope: string): string => `preview_mock_settings:${scope}`;

export interface ApiRequestLog {
  id: string;
  at: number;
  method: HttpMethodName;
  url: string;
  status: number;
  durationMs: number;
  source: 'backend' | 'mock' | 'static';
  requestBody: string | null;
  responseBody: string;
  errorMessage: string | null;
  requestHeaders?: Record<string, string>;
}

export interface PreviewDomainOptions {
  projectsDir: string;
  db: Database.Database;
  userId: string;
  /**
   * 受控进程端口（真实后端托管）。null = 外壳未提供进程能力，
   * 后托管的七个方法如实报 NOT_SUPPORTED，静态/Mock 预览仍可用。
   */
  process: ControlledProcessHost | null;
  /**
   * 页面截图端口（V2-D02 缩略图，Electron 离屏窗口实现）。缺省 = 不生成缩略图，
   * getThumbnailUrl 保持 null（工作台卡片显示明确占位）。
   */
  capturePage?: ((url: string) => Promise<Buffer | null>) | undefined;
  /** D07 任务预览解析器：只返回由 TaskWriteService 管理且仍存在的任务副本。 */
  resolveTaskPreview?:
    | ((projectId: string, taskId: string) => { codeRoot: string; dataDir: string } | null)
    | undefined;
  /**
   * 非请求来源事件（后端进程的后续日志行）。日志在 `startBackend` 返回之后仍会持续产生，
   * 那时没有"在飞的请求"可以附着，必须走这条常驻事件口。
   */
  emit: (domain: 'preview', payload: unknown) => void;
}

/** 显式数据模式：real = 只用真实后端（不可用如实报错）；mock = 用户显式选择的模拟数据 */
type DataMode = 'real' | 'mock';

const DATA_MODES: readonly DataMode[] = ['real', 'mock'];

/** 运行计划按项目持久化（用户确认过的 RunPlan 清单，每个子工程一份） */
interface ConfirmedRunPlan {
  plannerVersion: string;
  confirmedAt: number;
  plans: RunPlan[];
}

const dataModeKey = (scope: string): string => `preview_data_mode:${scope}`;
const runPlanKey = (scope: string): string => `preview_run_plan:${scope}`;
const THUMBNAIL_FILE = 'thumbnail.png';

interface PreviewInstance {
  readonly inspection: DomInspection;
  readonly domCompiler: DomViteBridge;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly scope: string;
  readonly dataDir: string | null;
  readonly paths: ProjectPaths;
  readonly codeRoot: string;
  staticRoot: string;
  server: Server | null;
  port: number | null;
  url: string | null;
  mode: PreviewMode;
  readonly logs: LogStream;
  requests: ApiRequestLog[];
  requestSeq: number;
  runner: BackendRunner | null;
  installer: DependencyInstaller | null;
  profile: ProjectProfile | null;
  mock: MockResponseGenerator;
  openapi: LoadedOpenApi;
  openapiSource: string | null;
  resolver: BindingResolver;
  backendUrl: string | null;
  /** 显式数据模式（持久化；real 为默认——不再自动回退 Mock） */
  dataMode: DataMode;
  /** V2-D02 运行实例编排器（受控进程存在时才创建） */
  orchestrator: RuntimeOrchestrator | null;
  /** 当前反代目标：最近一次就绪的前端 dev 服务（null = 页面走静态托管） */
  proxyTarget: { runtimeId: string; serviceId: string; baseUrl: string } | null;
  /**
   * 预分配的后端端口。
   *
   * 必须在 spawn **之前**确定：托管的应用（如 `app.py` / `npm run dev`）从 `PORT`
   * 环境变量读监听端口，而环境变量只能在 spawn 那一刻给。这里先分配、再让
   * `BackendRunner` 从同一个端口起算，两边就必然一致。
   */
  readonly pendingPort: { value: number | null };
  /** 登记后端地址（由 `startBackend` / runner 事件回填） */
  setBackend(url: string | null): void;
  watcher: { close: () => void } | null;
  watchTimer: NodeJS.Timeout | null;
  lastChangeAt: number | null;
  notice: string | null;
  dispose: () => void;
}

export function createPreviewDomain(options: PreviewDomainOptions): {
  router: DomainRouter;
  dispose: () => Promise<void>;
  /**
   * 读取某项目的 API 请求日志（只读快照）。
   *
   * 给 nav 域的数据流可视化用：`FR-PRV-07` 要求高亮
   * 「元素 → 事件 → 接口 → 后端处理 → 数据回写 → 元素渲染」，
   * 其中"接口真的被打了没、打了几次、返回什么"只有预览域知道，
   * 所以由预览域暴露一份只读投影，而不是让 nav 去猜。
   */
  readRequestLogs: (projectId: string, taskId?: string) => readonly ApiRequestLog[];
  readDomAttachments: (projectId: string, taskId?: string) => readonly DomAttachment[];
} {
  const paths: ProjectPaths = createProjectPaths({ projectsDir: options.projectsDir });
  const settings: SettingStore = createSettingStore({ db: options.db, userId: options.userId });
  const instances = new Map<string, PreviewInstance>();

  const taskIdOf = (params: Record<string, unknown>): string | null => {
    const value = params['taskId'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const scopeOf = (projectId: string, taskId: string | null): string =>
    taskId === null ? projectId : projectId + ':task:' + taskId;

  const taskPathsFor = (projectId: string, codeRoot: string): ProjectPaths => ({
    projectsDir: codeRoot,
    projectRoot: (id) => {
      if (id !== projectId) throw new ShellError('INVALID_ARGUMENT', '任务预览项目标识不一致');
      return codeRoot;
    },
    projectDir: (id, ...segments) => {
      if (id !== projectId) throw new ShellError('INVALID_ARGUMENT', '任务预览项目标识不一致');
      if (segments.length === 0) return codeRoot;
      const relativePath =
        segments[0] === PROJECT_SUBDIRS.code ? segments.slice(1).join('/') : segments.join('/');
      return relativePath.length === 0 ? codeRoot : paths.inside(codeRoot, relativePath);
    },
    codeRoot: (id) => {
      if (id !== projectId) throw new ShellError('INVALID_ARGUMENT', '任务预览项目标识不一致');
      return codeRoot;
    },
    pagesDir: (id) => {
      if (id !== projectId) throw new ShellError('INVALID_ARGUMENT', '任务预览项目标识不一致');
      return paths.inside(codeRoot, PROJECT_SUBDIRS.pages);
    },
    docsDir: (id) => {
      if (id !== projectId) throw new ShellError('INVALID_ARGUMENT', '任务预览项目标识不一致');
      return paths.inside(codeRoot, PROJECT_SUBDIRS.docs);
    },
    inside: paths.inside,
    relative: paths.relative,
    contains: paths.contains,
  });

  const requireProject = (params: Record<string, unknown>): string => {
    const projectId = String(params['projectId'] ?? '');
    if (projectId.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 projectId');
    const taskId = taskIdOf(params);
    if (taskId === null) {
      paths.codeRoot(projectId);
    } else if (
      options.resolveTaskPreview?.(projectId, taskId) === null ||
      options.resolveTaskPreview === undefined
    ) {
      throw new ShellError('NOT_FOUND', '任务预览副本不存在或已清理：' + taskId);
    }
    return projectId;
  };

  /* ------------------------------ OpenAPI 加载 ------------------------------ */

  /**
   * 从项目产物里找 OpenAPI 草案。
   *
   * 来源两处（按可信度排序）：`docs/` 下的独立 spec 文件 → S2 技术文档里的 yaml/json 围栏。
   * 都找不到时用内置兜底 spec（能演示 Mock，但要在日志里说清"不是项目的真实契约"）。
   */
  const loadOpenApiFor = (
    projectId: string,
    logs: LogStream,
    localPaths: ProjectPaths = paths,
  ): { spec: LoadedOpenApi; source: string | null } => {
    const docsDir = localPaths.projectDir(projectId, PROJECT_SUBDIRS.docs);
    const pipelineDir = localPaths.projectDir(projectId, PROJECT_SUBDIRS.pipeline);
    const candidates: string[] = [];

    const collect = (dir: string, depth = 0): void => {
      if (depth > 3 || !existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = localPaths.inside(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          collect(full, depth + 1);
          continue;
        }
        if (!/\.(json|ya?ml|md)$/i.test(entry.name)) continue;
        candidates.push(full);
      }
    };
    collect(docsDir);
    collect(pipelineDir);

    // 1) 独立 spec 文件优先
    for (const file of candidates) {
      if (!/openapi|swagger/i.test(file)) continue;
      const text = readSafely(file);
      if (text === null) continue;
      try {
        return {
          spec: parseOpenApiDocument(text),
          source: relative(localPaths.projectRoot(projectId), file),
        };
      } catch (error) {
        logs.warn(
          `OpenAPI 文件解析失败（已跳过）：${relative(localPaths.projectRoot(projectId), file)} ${
            error instanceof OpenApiParseError ? error.message : ''
          }`,
        );
      }
    }

    // 2) 文档里的围栏
    for (const file of candidates) {
      const text = readSafely(file);
      if (text === null || !/openapi\s*:|"openapi"\s*:/.test(text)) continue;
      const fenced = /```(?:ya?ml|json)\s*([\s\S]*?)```/.exec(text);
      if (fenced?.[1] === undefined) continue;
      try {
        return {
          spec: parseOpenApiDocument(fenced[1]),
          source: relative(localPaths.projectRoot(projectId), file),
        };
      } catch {
        // 围栏内容不是合法 spec：继续找下一个候选
      }
    }

    logs.warn('未找到项目 OpenAPI 草案，Mock 将使用内置兜底契约（仅用于演示，不代表真实接口）');
    return { spec: createFallbackOpenApi(), source: null };
  };

  /* ------------------------------ 实例构造 ------------------------------ */

  const resolveStaticRoot = (
    projectId: string,
    localPaths: ProjectPaths = paths,
  ): { root: string; fallback: boolean } => {
    const codeRoot = localPaths.codeRoot(projectId);
    for (const candidate of STATIC_ROOT_CANDIDATES) {
      const dir = localPaths.inside(codeRoot, candidate);
      if (existsSync(dir) && statSync(dir).isDirectory()) return { root: dir, fallback: false };
    }
    return { root: codeRoot, fallback: true };
  };

  const getInstance = (projectId: string, taskId: string | null = null): PreviewInstance => {
    const key = scopeOf(projectId, taskId);
    const cached = instances.get(key);
    if (cached !== undefined) return cached;

    let codeRoot: string;
    let dataDir: string | null = null;
    let instancePaths = paths;
    if (taskId === null) {
      codeRoot = paths.codeRoot(projectId);
    } else {
      const task = options.resolveTaskPreview?.(projectId, taskId) ?? null;
      if (task === null) throw new ShellError('NOT_FOUND', '任务预览副本不存在或已清理：' + taskId);
      codeRoot = task.codeRoot;
      dataDir = task.dataDir;
      instancePaths = taskPathsFor(projectId, codeRoot);
    }
    if (!existsSync(codeRoot)) {
      throw new ShellError('NOT_FOUND', `项目代码目录不存在：${projectId}`);
    }

    const logs = new LogStream({ max: 2000 });
    /**
     * 日志实时回流。
     *
     * 走**常驻事件口**（`options.emit`）而不是 `ctx.emit`：后端的输出在
     * `startBackend` 返回之后仍然持续产生，那时没有任何"在飞的请求"可以附着，
     * 请求内事件通道投不出去。载荷同时带 `line`（守卫要求的字段）与
     * `StreamedLogLine` 的完整形状，渲染层无需二次拼装。
     */
    logs.subscribe((line) => {
      options.emit('preview', {
        type: 'preview:log',
        line: line.text,
        at: line.at,
        level: line.level,
        id: line.id,
        source: line.source,
        stream: line.stream,
        projectId,
        ...(taskId === null ? {} : { taskId }),
      });
    });
    const scope = scopeOf(projectId, taskId);
    const { root: staticRoot, fallback } = resolveStaticRoot(projectId, instancePaths);
    const mockSettings = settings.read<MockSettings>(mockSettingsKey(scope)) ?? {
      ...DEFAULT_MOCK_SETTINGS,
    };
    const mock = new MockResponseGenerator({ settings: mockSettings });
    const { spec, source } = loadOpenApiFor(projectId, logs, instancePaths);
    if (fallback) {
      logs.info('未发现构建产物目录（dist/build/public），静态预览直接托管代码根目录');
    }

    let backendUrl: string | null = null;
    const backendPort: { available: boolean } = { available: false };
    const pendingPort: { value: number | null } = { value: null };

    // 后端请求能力：只有"受控进程托管的真实后端"才算可用（FR-PRV-02 的第一优先级）。
    // 显式 Mock 模式下对 resolver 隐去后端：数据来源固定走 Mock（V2 FR-PRV-02 修改点）。
    const backendRequester = {
      get available(): boolean {
        return (
          instance.mode !== 'static' &&
          backendPort.available &&
          backendUrl !== null &&
          instance.dataMode !== 'mock'
        );
      },
      async request(input: {
        url: string;
        method: HttpMethodName;
        headers?: Record<string, string>;
        body?: unknown;
      }): Promise<{ status: number; data: unknown }> {
        if (backendUrl === null) return { status: 0, data: null };
        return forwardToBackend(backendUrl, input);
      },
    };

    const fixture = { get: () => null };

    const resolver = new BindingResolver({
      openapi: spec,
      mock,
      backend: backendRequester,
      fixture,
    });

    const inspection = new DomInspection(projectId, instancePaths, settings, scope);
    const instance: PreviewInstance = {
      inspection,
      domCompiler: new DomViteBridge(projectId, instancePaths, inspection),
      projectId,
      taskId,
      scope,
      dataDir,
      paths: instancePaths,
      codeRoot,
      staticRoot,
      server: null,
      port: null,
      url: null,
      mode: 'static',
      logs,
      requests: [],
      requestSeq: 0,
      runner: null,
      installer:
        options.process === null
          ? null
          : new DependencyInstaller({
              process: options.process,
              logs,
            }),
      profile: null,
      mock,
      openapi: spec,
      openapiSource: source,
      resolver,
      backendUrl: null,
      dataMode: settings.read<DataMode>(dataModeKey(scope)) === 'mock' ? 'mock' : 'real',
      orchestrator:
        options.process === null
          ? null
          : new RuntimeOrchestrator({
              process: options.process,
              logs,
              probe: probePort,
              tcpProbe: probeTcpPort,
              pageReady: probePageReady,
              newId: () => newUlid(),
              readyTimeoutMs: 30_000,
            }),
      proxyTarget: null,
      pendingPort,
      setBackend(url: string | null): void {
        backendUrl = url;
        backendPort.available = url !== null;
        instance.backendUrl = url;
      },
      watcher: null,
      watchTimer: null,
      lastChangeAt: null,
      notice: null,
      dispose: () => {
        if (instance.watchTimer !== null) clearTimeout(instance.watchTimer);
        instance.watcher?.close();
        instance.watcher = null;
      },
    };

    startStaticWatcher(instance);
    instances.set(key, instance);
    return instance;
  };

  /* ------------------------------ 静态服务 ------------------------------ */

  const serveStatic = (
    instance: PreviewInstance,
    urlPath: string,
  ): { status: number; body: Buffer; type: string } | null => {
    const root = instance.staticRoot;
    let target: string;
    try {
      const relativePath = decodeURIComponent(urlPath.split('?')[0] ?? '/').replace(/^\//, '');
      if (relativePath.split(/[\\/]/).some((part) => part.startsWith('.'))) return null;
      target = instance.paths.inside(root, relativePath === '' ? 'index.html' : relativePath);
    } catch {
      return null;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      // SPA 兜底：未命中文件回 index.html（前端路由刷新不该 404）
      try {
        target = instance.paths.inside(root, 'index.html');
      } catch {
        return null;
      }
      if (!existsSync(target)) return null;
    }
    const type = MIME[extname(target)] ?? 'application/octet-stream';
    let body = readFileSync(target);
    if (type.startsWith('text/html') && instance.inspection.session !== null) {
      const mapped = instance.inspection.registry.instrument(
        body.toString('utf8'),
        instance.paths.relative(instance.codeRoot, target),
        'static_html',
      );
      body = Buffer.from(injectDomSelector(mapped, instance.inspection.session));
    }
    return { status: 200, body, type };
  };

  const isApiRequest = (instance: PreviewInstance, method: string, urlPath: string): boolean => {
    if (urlPath.startsWith('/api/') || urlPath === '/api') return true;
    if (method !== 'GET' && method !== 'HEAD') return true;
    return matchRoute(instance.openapi.routes, method, urlPath.split('?')[0] ?? urlPath) !== null;
  };

  /**
   * 按显式数据模式解析（V2 FR-PRV-02 修改点）：
   * - `mock`：用户显式切换的模拟数据。resolver 看到的后端已被隐去（见 backendRequester），
   *   来源固定标记 mock；
   * - `real` 且后端不可用：**如实报 502 诊断，不再自动回退 Mock**——Mock 回答会掩盖
   *   "真实后端挂了/没启动"的事实，被误读成联调通过；
   * - `real` 且后端可用：resolver 正常走后端。
   */
  const resolveWithMode = async (
    instance: PreviewInstance,
    input: {
      url: string;
      method: HttpMethodName;
      headers?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<ResolvedResponse> => {
    const backendReachable = instance.mode !== 'static' && instance.backendUrl !== null;
    if (instance.dataMode === 'real' && !backendReachable) {
      return {
        status: 502,
        data: {
          error: '真实后端不可用',
          detail: instance.backendUrl === null ? '后端未运行（或已退出）' : '后端地址未就绪',
          hint: '已按 V2 规则不再自动回退 Mock；如需演示数据，请在预览工具栏显式切换到模拟数据。',
        },
        source: 'backend',
        latencyMs: 0,
        url: input.url,
        method: input.method,
        errorMessage: '真实后端不可用（未运行或已退出），已拒绝自动回退 Mock',
      };
    }
    if (instance.dataMode === 'mock') {
      instance.logs.info(`模拟数据（显式 Mock 模式）：${input.method} ${input.url}`);
    }
    return instance.resolver.resolve(input);
  };

  const recordRequest = (
    instance: PreviewInstance,
    input: {
      method: HttpMethodName;
      url: string;
      requestBody: string | null;
      response: ResolvedResponse;
      headers?: Record<string, string>;
    },
  ): ApiRequestLog => {
    instance.requestSeq += 1;
    const entry: ApiRequestLog = {
      id: `req-${instance.requestSeq}`,
      at: Date.now(),
      method: input.method,
      url: input.url,
      status: input.response.status,
      durationMs: input.response.latencyMs,
      source: input.response.source,
      requestBody: input.requestBody,
      responseBody: safeStringify(input.response.data),
      errorMessage: input.response.errorMessage,
      requestHeaders: input.headers ?? {},
    };
    instance.requests.push(entry);
    if (instance.requests.length > MAX_REQUEST_LOGS) {
      instance.requests = instance.requests.slice(instance.requests.length - MAX_REQUEST_LOGS);
    }
    return entry;
  };

  const handleApi = async (
    instance: PreviewInstance,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase() as HttpMethodName;
    const urlPath = req.url ?? '/';
    const body = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (
        typeof value === 'string' &&
        !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)
      )
        headers[key] = value;
    }
    let response: ResolvedResponse;
    try {
      response = await resolveWithMode(instance, {
        url: urlPath,
        method,
        headers,
        ...(body.length > 0 ? { body: parseMaybeJson(body) } : {}),
      });
    } catch (error) {
      response = {
        status: 502,
        data: null,
        source: 'static',
        latencyMs: 0,
        url: urlPath,
        method,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    const entry = recordRequest(instance, {
      method,
      url: urlPath,
      requestBody: body.length > 0 ? body : null,
      response,
      headers,
    });
    res.writeHead(response.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'X-EC-Data-Source': response.source,
      'X-EC-Request-Id': entry.id,
    });
    res.end(entry.responseBody);
  };

  const startServer = async (instance: PreviewInstance, mode: PreviewMode): Promise<void> => {
    if (instance.server !== null) await stopServer(instance);
    instance.domCompiler.clear();
    instance.inspection.reset();
    const lanSharing = readLanSharing(instance.scope);
    const allocation = await allocatePort({
      start: DEFAULT_PREVIEW_PORT,
      probe: probePort,
    });
    if (allocation.log !== null) instance.logs.info(allocation.log);
    instance.notice = allocation.shifted
      ? `默认端口 ${DEFAULT_PREVIEW_PORT} 被占用，已顺延到 ${allocation.port}`
      : null;

    const host = lanSharing ? '0.0.0.0' : '127.0.0.1';
    const server = createServer((req, res) => {
      // Private compiler RPC is handled before public preflight/API/static/proxy routing.
      if (req.url?.split('?')[0] === DOM_COMPILE_PATH) {
        void instance.domCompiler.handle(req, res);
        return;
      }
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        });
        res.end();
        return;
      }
      const urlPath = req.url ?? '/';
      if (isApiRequest(instance, method, urlPath)) {
        // 异步处理，但**必须兜住异常**：未处理的 rejection 会让请求悬空、连接被重置
        void handleApi(instance, req, res).catch((error: unknown) => {
          instance.logs.error(
            `接口请求处理失败（${method} ${urlPath}）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          }
          if (!res.writableEnded) res.end(JSON.stringify({ error: '预览服务处理请求失败' }));
        });
        return;
      }
      // V2-D02：运行实例的前端 dev server（React/Vue Vite 等）就绪后，页面请求反代到
      // dev server（HMR 资源由它出），/api 仍由本域数据源门控处理
      if (instance.proxyTarget !== null) {
        proxyPage(instance, req, res);
        return;
      }
      const file = serveStatic(instance, urlPath);
      if (file === null) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('预览资源不存在');
        return;
      }
      res.writeHead(200, {
        'Content-Type': file.type,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(file.body);
    });
    // HMR / dev server 的 WebSocket 升级请求：原样转发到当前反代目标
    server.on('upgrade', (req, socket, head) => {
      const target = instance.proxyTarget;
      if (target === null) {
        socket.destroy();
        return;
      }
      proxyUpgrade(instance, req, socket, head, target.baseUrl);
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(allocation.port, host, () => resolveListen());
    });
    // 连接层异常（畸形请求、客户端提前断开）必须被看见：否则表现为"请求莫名其妙失败"，
    // 而预览侧一条线索都没有
    server.on('clientError', (error: Error & { code?: string }, socket) => {
      instance.logs.error(`预览连接异常（${error.code ?? 'unknown'}）：${error.message}`);
      socket.destroy();
    });

    instance.server = server;
    instance.port = allocation.port;
    instance.url = `http://${lanSharing ? (localLanAddress() ?? '127.0.0.1') : '127.0.0.1'}:${allocation.port}`;
    instance.mode = mode;
    instance.logs.info(
      `预览已启动：${instance.url}（模式 ${mode}，${
        lanSharing ? '已开启局域网访问' : '仅本机可访问'
      }）`,
    );
    // 静态页面就绪即尝试更新项目缩略图（异步，不阻塞启动返回；无截图端口时静默跳过）
    void captureThumbnailFor(instance);
  };

  const stopServer = async (instance: PreviewInstance): Promise<void> => {
    if (instance.server === null) return;
    await new Promise<void>((resolveClose) => {
      instance.server?.close(() => resolveClose());
      instance.server?.closeAllConnections();
    });
    instance.server = null;
    instance.port = null;
    instance.url = null;
    instance.proxyTarget = null;
    instance.domCompiler.clear();
    instance.inspection.reset();
    instance.logs.info('预览已停止');
  };

  /* ------------------------------ 热更新 ------------------------------ */

  /**
   * 静态目录变更监视（验收：变更后预览刷新 ≤3s）。
   *
   * 与 code 域同一套纪律：**事件只当触发器**，真相来自"路径 → size/mtime"索引比对。
   * Windows 上 `fs.watch` 的 filename 经常只报目录名，直接采信会得到无意义的行。
   */
  const startStaticWatcher = (instance: PreviewInstance): void => {
    const root = instance.staticRoot;
    if (!existsSync(root)) return;
    const indexOf = (): Map<string, string> => {
      const out = new Map<string, string>();
      const walk = (dir: string, depth: number): void => {
        if (depth > 8) return;
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          if (entry.isSymbolicLink()) continue;
          const full = instance.paths.inside(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full, depth + 1);
            continue;
          }
          try {
            const stat = statSync(full);
            out.set(full, `${stat.size}:${stat.mtimeMs}`);
          } catch {
            // 扫描期间被删除：忽略，下一次比对会当成"移除"
          }
        }
      };
      walk(root, 0);
      return out;
    };

    let index = indexOf();
    try {
      const handle = watch(root, { recursive: true }, () => {
        if (instance.watchTimer !== null) return;
        instance.watchTimer = setTimeout(() => {
          instance.watchTimer = null;
          const next = indexOf();
          let changed = false;
          for (const [file, stamp] of next) {
            if (index.get(file) !== stamp) {
              changed = true;
              break;
            }
          }
          if (!changed && next.size !== index.size) changed = true;
          index = next;
          if (changed) instance.lastChangeAt = Date.now();
        }, 250);
      });
      instance.watcher = { close: () => handle.close() };
    } catch {
      // 目录不可监听：静默降级（无自动刷新），不炸装配
    }
  };

  /* ------------------------------ 设备探测 ------------------------------ */

  const deviceChannels = (): Array<{
    id: string;
    kind: 'mobile' | 'harmony' | 'desktop';
    label: string;
    available: boolean;
    toolchain: string | null;
    guide: string | null;
    selected: boolean;
  }> => {
    const adb = findInPath(['adb', 'adb.exe']);
    const hdc = findInPath(['hdc', 'hdc.exe']);
    return [
      {
        id: 'mobile',
        kind: 'mobile',
        label: 'Android / iOS 真机',
        available: adb !== null,
        toolchain: adb,
        guide:
          adb === null
            ? '未探测到 adb：请安装 Android Platform Tools 并把 platform-tools 加入 PATH 后重试（iOS 需在 macOS 上使用 simctl）。'
            : null,
        selected: false,
      },
      {
        id: 'harmony',
        kind: 'harmony',
        label: 'HarmonyOS 模拟器 / 真机',
        available: hdc !== null,
        toolchain: hdc,
        guide:
          hdc === null
            ? '未探测到 hdc：请安装 DevEco Studio 并把 `sdk/default/openharmony/toolchains` 加入 PATH 后重试。'
            : null,
        selected: false,
      },
      {
        id: 'desktop',
        kind: 'desktop',
        label: '桌面窗口预览',
        available: true,
        toolchain: 'electron',
        guide: null,
        selected: true,
      },
    ];
  };

  /* ------------------------------ 设置读取 ------------------------------ */

  const readLanSharing = (scope: string): boolean =>
    settings.read<boolean>(lanSharingKey(scope)) === true;

  /* ------------------------------ 路由 ------------------------------ */

  const router: DomainRouter = async (method, params) => {
    const projectId = requireProject(params);
    const taskId = taskIdOf(params);
    const instanceOf = (id: string): PreviewInstance => getInstance(id, taskId);

    switch (method) {
      case 'state': {
        const instance = instanceOf(projectId);
        const lastSource = instance.requests.at(-1)?.source ?? null;
        return {
          mode: instance.mode,
          running: instance.server !== null,
          url: instance.url,
          port: instance.port,
          dataSource: instance.server === null ? null : (lastSource ?? 'static'),
          backendAvailable: instance.runner?.status().running ?? false,
          notice: instance.notice,
          revision: instance.lastChangeAt,
          runtimeId: instance.server === null ? null : instance.inspection.runtimeId,
          dataMode: instance.dataMode,
          runtime: instance.orchestrator?.status(null) ?? null,
        };
      }

      case 'setMode': {
        const mode = String(params['mode'] ?? 'static') as PreviewMode;
        if (!PREVIEW_MODE_KEYS.includes(mode)) {
          throw new ShellError('INVALID_ARGUMENT', `未知预览模式：${String(params['mode'] ?? '')}`);
        }
        instanceOf(projectId).mode = mode;
        return undefined;
      }

      /* ---------------------- V2-D02 运行计划与实例 ---------------------- */
      case 'runPlan': {
        const instance = instanceOf(projectId);
        const suggestion = suggestRunPlan(collectPlanningEvidence(instance));
        if (suggestion.plan !== null) {
          instance.logs.info(
            `已生成运行计划建议（${suggestion.subProjects.length} 个子工程，${suggestion.plan.services.length} 个服务步骤）；执行前需确认`,
          );
        }
        return suggestion;
      }

      case 'confirmRunPlan': {
        const instance = instanceOf(projectId);
        const rawPlans = params['plans'];
        if (!Array.isArray(rawPlans) || rawPlans.length === 0) {
          throw new ShellError('INVALID_ARGUMENT', '确认的运行计划不能为空');
        }
        // 契约校验：strict 拒绝夹带环境变量值/密钥；计划内容即用户确认过的边界
        const plans = rawPlans.map((raw) => {
          const parsed = runPlanSchema.safeParse(raw);
          if (!parsed.success) {
            throw new ShellError(
              'INVALID_ARGUMENT',
              `运行计划不合法：${parsed.error.issues[0]?.message ?? 'schema 校验失败'}`,
            );
          }
          return parsed.data;
        });
        const confirmed: ConfirmedRunPlan = {
          plannerVersion: String(params['plannerVersion'] ?? ''),
          confirmedAt: Date.now(),
          plans,
        };
        settings.write(runPlanKey(instance.scope), confirmed);
        instance.logs.info(
          `运行计划已确认：${plans.length} 份计划 / ${plans.reduce((n, p) => n + p.services.length, 0)} 个服务步骤（安装/启动前不再二次确认）`,
        );
        return confirmed;
      }

      case 'startRun': {
        const instance = requireProcess(projectId, '运行实例', taskId);
        if (instance.orchestrator === null) {
          throw new ShellError('NOT_SUPPORTED', '运行实例需要受控进程端口，当前未装配。');
        }
        const confirmed = settings.read<ConfirmedRunPlan>(runPlanKey(instance.scope));
        if (confirmed === null || confirmed.plans.length === 0) {
          throw new ShellError(
            'INVALID_ARGUMENT',
            '尚未确认运行计划：请先 runPlan 预览建议并 confirmRunPlan 确认（首次安装/运行前必须显式确认）',
          );
        }
        // 预览服务必须在线：页面反代与 /api 门控都挂在它上面
        if (instance.server === null) {
          await startServer(instance, instance.mode === 'device' ? 'device' : 'linked');
        }
        const spec = buildRuntimeSpec(projectId, instance, confirmed);
        instance.domCompiler.clear();
        instance.inspection.reset(spec.runtimeId);
        for (const service of spec.services) {
          if (service.kind !== 'frontend') continue;
          const args = instance.domCompiler.prepare(
            service.command,
            service.args,
            service.cwd,
            instance.url!,
          );
          if (args) service.args = args;
          else
            instance.logs.warn(
              `DOM 源码映射未接入 ${service.serviceId}：仅支持标准 Vite 开发命令，未知节点禁止猜位置`,
            );
        }
        const snapshot = await instance.orchestrator.start(spec);
        applyRuntimeEndpoints(instance, snapshot);
        // 服务崩溃后同步摘除数据源/反代：后续请求如实报"真实后端不可用"（富诊断），
        // 而不是拿着死端口 502 空响应，更不是悄悄回退 Mock
        instance.orchestrator.onEvent((event) => {
          if (event.type !== 'service-exited') return;
          const service = snapshot.services.find((s) => s.serviceId === event.serviceId);
          if (service === undefined) return;
          if (service.kind === 'backend' && instance.backendUrl === service.baseUrl) {
            instance.setBackend(null);
            instance.logs.warn(
              `后端服务 ${service.serviceId} 已退出（${event.detail}）：数据源已摘除，接口将如实报真实后端不可用`,
            );
          }
          if (
            service.kind === 'frontend' &&
            event.runtimeId === snapshot.runtimeId &&
            instance.proxyTarget?.runtimeId === snapshot.runtimeId &&
            instance.proxyTarget.serviceId === service.serviceId
          ) {
            instance.proxyTarget = null;
            instance.domCompiler.clear();
            instance.inspection.reset();
            instance.lastChangeAt = Date.now();
            instance.logs.warn(`前端 dev server ${service.serviceId} 已退出：页面回退静态托管`);
          }
        });
        void captureThumbnailFor(instance);
        return snapshot;
      }

      case 'runStatus': {
        const instance = instanceOf(projectId);
        const runtimeId =
          typeof params['runtimeId'] === 'string' && params['runtimeId'].length > 0
            ? String(params['runtimeId'])
            : null;
        return instance.orchestrator?.status(runtimeId) ?? null;
      }

      case 'stopRuntime': {
        const instance = instanceOf(projectId);
        const requested =
          typeof params['runtimeId'] === 'string' && params['runtimeId'].length > 0
            ? String(params['runtimeId'])
            : null;
        const snapshot = instance.orchestrator?.status(requested) ?? null;
        if (instance.orchestrator === null || snapshot === null) {
          throw new ShellError('NOT_FOUND', '没有可停止的运行实例');
        }
        await instance.orchestrator.stop(snapshot.runtimeId);
        // 被停实例占用的数据源/反代同步摘除，避免"进程没了 URL 还指过去"
        if (instance.proxyTarget?.runtimeId === snapshot.runtimeId) instance.proxyTarget = null;
        if (instance.inspection.runtimeId === snapshot.runtimeId) {
          instance.domCompiler.clear();
          instance.inspection.reset();
          instance.lastChangeAt = Date.now();
        }
        const backendIsOurs = snapshot.services.some(
          (svc) => svc.kind === 'backend' && instance.backendUrl === svc.baseUrl,
        );
        if (backendIsOurs) instance.setBackend(null);
        instance.logs.info(`运行实例已停止：${snapshot.runtimeId}（精准停止，不影响其它工程）`);
        return instance.orchestrator.status(null);
      }

      case 'restartService': {
        const instance = requireProcess(projectId, '服务重启', taskId);
        if (instance.orchestrator === null) {
          throw new ShellError('NOT_SUPPORTED', '运行实例需要受控进程端口，当前未装配。');
        }
        const runtimeId = String(params['runtimeId'] ?? '');
        const serviceId = String(params['serviceId'] ?? '');
        if (runtimeId.length === 0 || serviceId.length === 0) {
          throw new ShellError('INVALID_ARGUMENT', 'restartService 需要 runtimeId 与 serviceId');
        }
        const frontend = instance.orchestrator
          .status(runtimeId)
          ?.services.some((s) => s.serviceId === serviceId && s.kind === 'frontend');
        if (frontend) instance.inspection.reset(runtimeId);
        const snapshot = await instance.orchestrator.restartService(runtimeId, serviceId);
        applyRuntimeEndpoints(instance, snapshot);
        if (frontend) instance.lastChangeAt = Date.now();
        return snapshot;
      }

      case 'captureThumbnail': {
        const instance = instanceOf(projectId);
        if (instance.url === null) {
          throw new ShellError('INVALID_ARGUMENT', '预览尚未启动，没有可截取的页面');
        }
        const saved = await captureThumbnailFor(instance);
        if (!saved) {
          throw new ShellError('NOT_SUPPORTED', '缩略图生成器未装配或截图失败，请查看预览日志');
        }
        return thumbnailPathOf(projectId, instance.paths);
      }

      case 'inspectionSession': {
        const instance = instanceOf(projectId);
        if (!instance.server) throw new ShellError('INVALID_ARGUMENT', '请先启动本地预览');
        return instance.inspection.open(params['parentOrigin']);
      }
      case 'resolveDom': {
        const inspection = instanceOf(projectId).inspection;
        return inspection.resolve(inspection.validate(params));
      }
      case 'saveDomNote':
      case 'attachDomContext':
        return instanceOf(projectId).inspection.save(params, method === 'attachDomContext');
      case 'domNotes':
        return (
          settings.read<DomAttachment[]>('preview_dom_notes:' + instanceOf(projectId).scope) ?? []
        );

      case 'start': {
        const mode = String(params['mode'] ?? 'static') as PreviewMode;
        if (!PREVIEW_MODE_KEYS.includes(mode)) {
          throw new ShellError('INVALID_ARGUMENT', `未知预览模式：${String(params['mode'] ?? '')}`);
        }
        const instance = instanceOf(projectId);
        await startServer(instance, mode);
        return {
          port: instance.port,
          url: instance.url,
          shifted: instance.port !== DEFAULT_PREVIEW_PORT,
          mode,
        };
      }

      case 'stop': {
        const instance = instanceOf(projectId);
        await stopServer(instance);
        if (instance.runner !== null) await instance.runner.stop();
        // 该工程的全部运行实例一并精准停止（避免预览停止后留下孤儿 dev server）
        if (instance.orchestrator !== null) {
          for (const snapshot of instance.orchestrator.list()) {
            await instance.orchestrator.stop(snapshot.runtimeId).catch(() => undefined);
          }
        }
        instance.setBackend(null);
        return null;
      }

      case 'pages': {
        const pages: Array<{ route: string; name: string }> = [];
        const instance = instanceOf(projectId);
        const designDir = instance.paths.pagesDir(projectId);
        if (existsSync(designDir)) {
          for (const entry of readdirSync(designDir)) {
            if (!entry.endsWith('.dsl.json')) continue;
            try {
              const envelope = JSON.parse(
                readFileSync(instance.paths.inside(designDir, entry), 'utf8'),
              ) as {
                page?: { route?: string; name?: string };
              };
              pages.push({
                route: envelope.page?.route ?? '/',
                name: envelope.page?.name ?? entry,
              });
            } catch {
              // 坏 DSL 跳过，不炸列表
            }
          }
        }
        return pages;
      }

      case 'refresh': {
        const instance = instanceOf(projectId);
        const now = Date.now();
        const elapsedMs = instance.lastChangeAt === null ? null : now - instance.lastChangeAt;
        instance.lastChangeAt = now;
        // 无变更时如实返回 null 而不是 0：0 会被读成"刷新耗时 0ms"，是假的
        return { elapsedMs, reason: String(params['reason'] ?? 'manual') };
      }

      /* ------------------------------ API 调试 ------------------------------ */
      case 'requests':
        return instanceOf(projectId).requests;

      case 'clearRequests': {
        const instance = instanceOf(projectId);
        instance.requests = [];
        return undefined;
      }

      case 'toCurl': {
        const instance = instanceOf(projectId);
        const input = (params['input'] ?? params) as { id?: unknown };
        const entry = instance.requests.find((item) => item.id === String(input.id ?? ''));
        if (entry === undefined) {
          throw new ShellError('NOT_FOUND', `未找到该请求记录：${String(input.id ?? '')}`);
        }
        return buildCurl(
          entry,
          instance.url ?? `http://127.0.0.1:${instance.port ?? DEFAULT_PREVIEW_PORT}`,
        );
      }

      case 'replayRequest': {
        const instance = instanceOf(projectId);
        const input = (params['input'] ?? params) as {
          id?: unknown;
          url?: unknown;
          method?: unknown;
          body?: unknown;
        };
        const source = instance.requests.find((item) => item.id === String(input.id ?? ''));
        if (source === undefined) {
          throw new ShellError('NOT_FOUND', `未找到该请求记录：${String(input.id ?? '')}`);
        }
        const url = typeof input.url === 'string' && input.url.length > 0 ? input.url : source.url;
        validateApiPath(url);
        const method =
          typeof input.method === 'string' && input.method.length > 0
            ? (input.method.toUpperCase() as HttpMethodName)
            : source.method;
        const body =
          input.body !== undefined ? input.body : parseMaybeJson(source.requestBody ?? '');
        const response = await resolveWithMode(instance, {
          url,
          method,
          headers: source.requestHeaders ?? {},
          ...(body !== null && body !== undefined && `${body}`.length > 0 ? { body } : {}),
        });
        recordRequest(instance, {
          method,
          url,
          requestBody: body === null || body === undefined ? null : safeStringify(body),
          response,
          headers: source.requestHeaders ?? {},
        });
        return response;
      }

      /* ------------------------------ 后端托管 ------------------------------ */
      case 'projectProfile': {
        const instance = instanceOf(projectId);
        const profile = detectProfile(instance);
        instance.profile = profile;
        return profile;
      }

      case 'installDependencies': {
        const instance = requireProcess(projectId, '依赖安装', taskId);
        const profile = instance.profile ?? detectProfile(instance);
        instance.profile = profile;
        if (instance.installer === null) {
          throw new ShellError('NOT_SUPPORTED', '依赖安装需要受控进程端口，当前未装配。');
        }
        if (profile.installCmd === null) {
          return {
            ok: false,
            data: null,
            logs: [],
            error: {
              code: 'INSTALL_UNSUPPORTED',
              message: `项目类型 ${profile.label} 暂不支持自动安装依赖，请在预览面板手动填写安装命令。`,
            },
          } satisfies PreviewResult<{ command: string; exitCode: number | null }>;
        }
        return instance.installer.run(profile, instance.codeRoot);
      }

      case 'startBackend': {
        const instance = requireProcess(projectId, '后端托管', taskId);
        const profile = instance.profile ?? detectProfile(instance);
        instance.profile = profile;
        if (options.process === null) {
          throw new ShellError('NOT_SUPPORTED', '后端托管需要受控进程端口，当前未装配。');
        }
        if (instance.runner?.status().running) {
          return { ok: true, data: instance.runner.status().process, logs: [], error: null };
        }
        const runner = new BackendRunner({
          process: options.process,
          logs: instance.logs,
          startPort: profile.portHint ?? DEFAULT_PREVIEW_PORT + 100,
          probe: probePort,
          ready: waitForBackend,
        });
        runner.onEvent((event) => {
          if (event.type === 'started') instance.setBackend(runner.status().process?.url ?? null);
          if (event.type === 'stopped' || event.type === 'exited') instance.setBackend(null);
        });
        instance.runner = runner;

        const result = await runner.start(
          profile,
          instance.codeRoot,
          instance.dataDir === null
            ? undefined
            : { EC_TASK_ID: instance.taskId ?? '', EC_TASK_DATA_DIR: instance.dataDir },
        );
        if (result.ok && result.data !== null) {
          instance.setBackend(result.data.url);
        }
        return result;
      }

      case 'stopBackend': {
        const instance = requireProcess(projectId, '后端托管', taskId);
        if (instance.runner === null) {
          throw new ShellError('NOT_SUPPORTED', '后端尚未托管，无需停止。');
        }
        await instance.runner.stop();
        instance.setBackend(null);
        return null;
      }

      case 'restartBackend': {
        const instance = requireProcess(projectId, '后端托管', taskId);
        if (instance.runner === null) {
          throw new ShellError('NOT_SUPPORTED', '后端尚未托管，无法重启。');
        }
        const result = await instance.runner.restart();
        if (result.ok && result.data !== null) instance.setBackend(result.data.url);
        return result;
      }

      case 'backendStatus': {
        const instance = instanceOf(projectId);
        if (instance.runner === null) return { running: false, process: null };
        const status = instance.runner.status();
        return {
          running: status.running,
          process: status.process satisfies ManagedProcess | null,
        };
      }

      case 'logs': {
        const instance = instanceOf(projectId);
        const filter = (params['filter'] ?? {}) as {
          level?: StreamedLogLine['level'];
          keyword?: string;
          source?: StreamedLogLine['source'];
        };
        return instance.logs.lines({
          ...(filter.level !== undefined ? { level: filter.level } : {}),
          ...(typeof filter.keyword === 'string' ? { keyword: filter.keyword } : {}),
          ...(filter.source !== undefined ? { source: filter.source } : {}),
        });
      }

      /* ------------------------------ 多端 ------------------------------ */
      case 'devices':
        return deviceChannels();

      case 'deviceQr': {
        const instance = instanceOf(projectId);
        const channelId = String(params['channelId'] ?? '');
        if (channelId === 'desktop') {
          throw new ShellError(
            'INVALID_ARGUMENT',
            '桌面端预览不使用二维码：请直接在本地窗口中查看',
          );
        }
        // 默认关闭，且拒绝在未开启时"顺手给个地址"——那等于绕过了用户的显式授权
        if (!readLanSharing(instanceOf(projectId).scope)) {
          throw new ShellError(
            'NOT_SUPPORTED',
            '局域网预览默认关闭：开启后同一网络下的其它设备即可访问你的本机工程，请确认网络环境可信后再开启。',
          );
        }
        const url = instance.url;
        if (url === null) {
          throw new ShellError('INVALID_ARGUMENT', '预览尚未启动，请先启动预览再生成二维码');
        }
        const lan = url.replace('127.0.0.1', localLanAddress() ?? '127.0.0.1');
        return { url: lan, qrText: lan };
      }

      case 'lanSharingEnabled':
        return readLanSharing(instanceOf(projectId).scope);

      case 'setLanSharing': {
        const enabled = params['enabled'] === true;
        const instance = instanceOf(projectId);
        settings.write(lanSharingKey(instance.scope), enabled);
        instance.logs.warn(
          enabled
            ? '局域网预览已开启：同一网络下的设备可访问本机预览服务，请勿在公共网络使用'
            : '局域网预览已关闭：仅本机可访问',
        );
        // 绑定地址在启动时确定，切换后需要重启服务才真正生效（这里如实重启而不是"假装生效"）
        if (instance.server !== null) await startServer(instance, instance.mode);
        return undefined;
      }

      /* ------------------------------ Mock 设置 ------------------------------ */
      case 'mockSettings':
        return instanceOf(projectId).mock.settings();

      case 'setMockSettings': {
        const instance = instanceOf(projectId);
        const patch = (params['patch'] ?? {}) as Partial<MockSettings>;
        instance.mock.updateSettings(patch);
        settings.write(mockSettingsKey(instance.scope), instance.mock.settings());
        instance.logs.info(
          // 注意措辞：日志分级按关键字判定，「错误率」会被误判成 error 级（ERROR_RE 命中"错误"）
          `Mock 设置已更新：规则 ${instance.mock.settings().rules.length} 条，延迟 ${JSON.stringify(
            instance.mock.settings().delayMs,
          )}，注入失败率 ${instance.mock.settings().errorRate}`,
        );
        return undefined;
      }

      /* ---------------------- V2-D02 显式数据模式 ---------------------- */
      case 'dataMode':
        return instanceOf(projectId).dataMode;

      case 'setDataMode': {
        const instance = instanceOf(projectId);
        const mode = String(params['mode'] ?? 'real') as DataMode;
        if (!DATA_MODES.includes(mode)) {
          throw new ShellError('INVALID_ARGUMENT', `未知数据模式：${String(params['mode'] ?? '')}`);
        }
        instance.dataMode = mode;
        settings.write(dataModeKey(instance.scope), mode);
        instance.logs.info(
          mode === 'mock'
            ? '数据来源已显式切换为模拟数据（Mock）：接口响应始终带 X-EC-Data-Source: mock 标记，不代表真实联调通过'
            : '数据来源已切回真实模式：后端不可用时接口如实报错，不再自动回退 Mock',
        );
        return undefined;
      }

      default:
        throw new ShellError('INVALID_ARGUMENT', `preview 域未知方法：${method}`);
    }
  };

  /* ------------------------------ 内部工具 ------------------------------ */

  const requireProcess = (
    projectId: string,
    action: string,
    taskId: string | null,
  ): PreviewInstance => {
    const instance = getInstance(projectId, taskId);
    if (options.process === null) {
      throw new ShellError(
        'NOT_SUPPORTED',
        `${action}需要外壳的受控进程端口，当前外壳未提供；静态预览与 API 调试仍可用。`,
      );
    }
    return instance;
  };

  const detectProfile = (instance: PreviewInstance): ProjectProfile => {
    const names = new Set<string>();
    for (const dir of [instance.codeRoot, instance.staticRoot]) {
      if (!existsSync(dir)) continue;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile()) names.add(entry.name);
        }
      } catch {
        // 读不到就少几个证据，不影响探测
      }
    }
    const profile = detectProjectType([...names]);
    if (profile.kind === 'node') {
      const pkg = JSON.parse(
        readFileSync(instance.paths.inside(instance.codeRoot, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, string> };
      profile.startCmd = pkg.scripts?.['dev']
        ? 'npm run dev'
        : pkg.scripts?.['start']
          ? 'npm start'
          : names.has('server.js')
            ? 'node server.js'
            : names.has('app.js')
              ? 'node app.js'
              : null;
    }
    return profile;
  };

  /* --------------------- V2-D02：运行计划 / 运行实例 / 缩略图 --------------------- */

  /** 只列一层文件名；子目录统一记为 `<dir>/` 形态由调用方决定要不要下钻 */
  const listDirNames = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((entry) => entry.name);
    } catch {
      return [];
    }
  };

  const readJsonFile = (file: string): ParsedPackage | null => {
    const text = readSafely(file);
    if (text === null) return null;
    try {
      return JSON.parse(text) as ParsedPackage;
    } catch {
      return null;
    }
  };

  /** 收集运行计划证据：根 + workspace 子目录（apps/packages/services 一层）。只读，不执行任何脚本 */
  const collectPlanningEvidence = (instance: PreviewInstance) => {
    const rootFiles = listDirNames(instance.codeRoot);
    const files: Record<string, string[]> = { '': rootFiles };
    const packages: Record<string, ParsedPackage> = {};
    const envNames: Record<string, string[]> = {};

    const rootPkg = readJsonFile(instance.paths.inside(instance.codeRoot, 'package.json'));
    if (rootPkg !== null) packages[''] = rootPkg;
    for (const envFile of ['.env.example', '.env.local']) {
      const text = readSafely(instance.paths.inside(instance.codeRoot, envFile));
      if (text === null) continue;
      const names = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
        .map((line) => line.split('=')[0] ?? '');
      envNames[''] = [...(envNames[''] ?? []), ...names];
    }

    const isWorkspace =
      rootFiles.includes('pnpm-workspace.yaml') || rootPkg?.workspaces !== undefined;
    if (isWorkspace) {
      for (const group of ['apps', 'packages', 'services']) {
        const groupDir = instance.paths.inside(instance.codeRoot, group);
        if (!existsSync(groupDir)) continue;
        for (const name of listDirNames(groupDir)) {
          if (name.startsWith('.')) continue;
          const dir = `${group}/${name}`;
          const full = instance.paths.inside(groupDir, name);
          if (!statSyncSafe(full)?.isDirectory()) continue;
          files[dir] = listDirNames(full);
          const pkg = readJsonFile(instance.paths.inside(full, 'package.json'));
          if (pkg !== null) packages[dir] = pkg;
          const envText = readSafely(instance.paths.inside(full, '.env.example'));
          if (envText !== null) {
            envNames[dir] = envText
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
              .map((line) => line.split('=')[0] ?? '');
          }
        }
      }
    }
    return { files, packages, envNames };
  };

  const statSyncSafe = (file: string): { isDirectory: () => boolean } | null => {
    try {
      return statSync(file);
    } catch {
      return null;
    }
  };

  /** 把确认过的多份 RunPlan（每份可指向不同子工程 cwd）编排成一个运行实例规格 */
  const buildRuntimeSpec = (
    projectId: string,
    instance: PreviewInstance,
    confirmed: ConfirmedRunPlan,
  ): RuntimeSpec => {
    const installs: { serviceId: string; command: string; cwd: string }[] = [];
    const services: RuntimeServiceSpec[] = [];
    for (const plan of confirmed.plans) {
      // 计划 cwd 是代码根内的相对路径（'.' = 根）；实例路径负责越界拒绝
      const cwd =
        plan.cwd === '.' ? instance.codeRoot : instance.paths.inside(instance.codeRoot, plan.cwd);
      for (const serviceId of plan.startupOrder) {
        const svc = plan.services.find((s) => s.serviceId === serviceId);
        if (svc === undefined) continue; // startupOrder 与 services 不一致按契约应被 schema 拒绝，这里兜底
        if (svc.role === 'install') {
          installs.push({ serviceId, command: svc.command, cwd });
          continue;
        }
        services.push({
          serviceId,
          kind: svc.role === 'frontend' ? 'frontend' : 'backend',
          command: svc.command,
          args: svc.args,
          cwd,
          env:
            instance.dataDir === null
              ? {}
              : { EC_TASK_ID: instance.taskId ?? '', EC_TASK_DATA_DIR: instance.dataDir },
        });
      }
    }
    if (services.length === 0 && installs.length === 0) {
      throw new ShellError('INVALID_ARGUMENT', '运行计划里没有任何可执行步骤');
    }
    return {
      runtimeId: newUlid(),
      projectId,
      cwd: instance.codeRoot,
      installs,
      services,
    };
  };

  /** 运行实例端点 → 数据源/反代接线：后端接管 /api，前端接管页面 */
  const applyRuntimeEndpoints = (instance: PreviewInstance, snapshot: RuntimeSnapshot): void => {
    let hasBackend = false;
    for (const endpoint of snapshot.services) {
      if (endpoint.port === null || endpoint.baseUrl === null) continue;
      if (endpoint.kind === 'backend') {
        instance.setBackend(endpoint.baseUrl);
        hasBackend = true;
        instance.logs.info(`后端服务已接入数据源：${endpoint.serviceId} → ${endpoint.baseUrl}`);
      } else {
        instance.proxyTarget = {
          runtimeId: snapshot.runtimeId,
          serviceId: endpoint.serviceId,
          baseUrl: endpoint.baseUrl,
        };
        instance.logs.info(
          `前端 dev server 已接入预览（页面反代）：${endpoint.serviceId} → ${endpoint.baseUrl}；/api 仍由预览服务数据源门控`,
        );
      }
    }
    // 联动模式：真实后端接管数据源（'static' 的语义是"只有静态数据"，会把
    // backendAvailable 门死，表现为"实例就绪但 /api 一直 502"）
    if (hasBackend) instance.mode = 'linked';
  };

  const thumbnailPathOf = (projectId: string, localPaths: ProjectPaths = paths): string =>
    localPaths.projectDir(projectId, PROJECT_SUBDIRS.meta, THUMBNAIL_FILE);

  /** 真实预览页截图 → 持久化 meta/thumbnail.png。失败只记日志，不影响预览本身 */
  const captureThumbnailFor = async (instance: PreviewInstance): Promise<boolean> => {
    const capture = options.capturePage;
    if (capture === undefined || capture === null) return false;
    if (instance.url === null) return false;
    const url = instance.url;
    try {
      const png = await capture(url);
      if (png === null || png.length === 0) return false;
      const metaDir = instance.paths.projectDir(instance.projectId, PROJECT_SUBDIRS.meta);
      mkdirSync(metaDir, { recursive: true });
      writeFileSync(join(metaDir, THUMBNAIL_FILE), png);
      instance.logs.info(`项目缩略图已更新（真实预览截图，${png.length} 字节）`);
      return true;
    } catch (error) {
      instance.logs.warn(
        `缩略图生成失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };

  /** 页面请求反代到前端 dev server：流式转发（HMR/资源流不缓冲），失败如实 502 */
  const proxyPage = (
    instance: PreviewInstance,
    req: IncomingMessage,
    res: ServerResponse,
  ): void => {
    const target = instance.proxyTarget;
    if (target === null) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('前端开发服务器不在运行中');
      return;
    }
    forwardHttpRequest(instance, req, res, target.baseUrl).catch((error: unknown) => {
      instance.logs.error(
        `前端页面代理失败：${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      if (!res.writableEnded) res.end('前端开发服务器代理失败');
    });
  };

  const forwardHttpRequest = async (
    instance: PreviewInstance,
    req: IncomingMessage,
    res: ServerResponse,
    baseUrl: string,
  ): Promise<void> => {
    const upstream = new URL(baseUrl);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && !['host', 'connection', 'content-length'].includes(key)) {
        headers[key] = value;
      }
    }
    headers['host'] = upstream.host;
    if (instance.inspection.session) headers['accept-encoding'] = 'identity';
    await new Promise<void>((resolveForward) => {
      const preq = httpRequest(
        {
          hostname: '127.0.0.1',
          port: Number(upstream.port),
          path: req.url ?? '/',
          method: req.method ?? 'GET',
          headers,
        },
        (pres) => {
          if (res.headersSent) {
            pres.resume();
            return;
          }
          const responseHeaders = { ...pres.headers };
          const path = req.url?.split('?')[0] ?? '';
          // Narrow CORS for sandbox module imports; APIs keep their existing data-source policy.
          if (
            req.method === 'GET' &&
            req.headers.origin === 'null' &&
            (path === '/@vite/client' ||
              path === '/@react-refresh' ||
              path === '/@id/__x00__plugin-vue:export-helper' ||
              /\.(?:[cm]?[jt]sx?|vue|css)$/.test(path))
          )
            responseHeaders['access-control-allow-origin'] = 'null';
          const session = instance.inspection.session;
          if (
            session &&
            req.method === 'GET' &&
            pres.statusCode === 200 &&
            String(pres.headers['content-type']).includes('text/html') &&
            !pres.headers['content-encoding']
          ) {
            const chunks: Buffer[] = [];
            let size = 0;
            pres.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size <= MAX_BODY_BYTES) chunks.push(chunk);
              else pres.destroy(new Error('选取 HTML 超出 1MB 上限'));
            });
            pres.on('error', () => {
              if (!res.headersSent) res.writeHead(502);
              res.end('预览 HTML 无法读取');
              resolveForward();
            });
            pres.on('end', () => {
              let html = Buffer.concat(chunks).toString('utf8');
              // Supported Vite adapters already injected before business scripts. Other dev servers
              // still permit selection, but proxy output is never guessed into source mappings.
              if (!html.includes('ec-dom-v1')) html = injectDomSelector(html, session);
              delete responseHeaders['content-length'];
              delete responseHeaders['etag'];
              responseHeaders['cache-control'] = 'no-store';
              res.writeHead(pres.statusCode ?? 502, responseHeaders);
              res.end(html);
              resolveForward();
            });
          } else {
            res.writeHead(pres.statusCode ?? 502, responseHeaders);
            pres.pipe(res);
            pres.on('end', () => resolveForward());
          }
        },
      );
      preq.on('error', (error: Error) => {
        instance.logs.error(
          `代理上游请求失败（${req.method ?? 'GET'} ${req.url ?? '/'} → ${baseUrl}）：${error.message}`,
        );
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        if (!res.writableEnded) res.end('前端开发服务器不可达（可能已退出）');
        resolveForward();
      });
      req.on('error', () => {
        preq.destroy();
        resolveForward();
      });
      req.pipe(preq);
    });
  };

  /**
   * WebSocket 升级转发（HMR）：TCP 层原样转发握手与后续帧。
   * host/origin 改写为目标 dev server 自身——Vite 等会对升级请求做同源检查，
   * 预览面板的页面 origin（预览端口）与 dev server 端口必然不同，这里由受控代理
   * 统一改写，而不是关闭 webSecurity / 全局放宽 CSP。
   */
  const proxyUpgrade = (
    instance: PreviewInstance,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    baseUrl: string,
  ): void => {
    const upstream = new URL(baseUrl);
    const port = Number(upstream.port);
    const upstreamSocket = connect({ host: '127.0.0.1', port }, () => {
      const lines = [`${req.method} ${req.url ?? '/'} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value !== 'string') continue;
        if (key === 'host' || key === 'origin' || key === 'connection') continue;
        lines.push(`${key}: ${value}`);
      }
      lines.push(`host: ${upstream.host}`);
      lines.push(`origin: ${upstream.origin}`);
      lines.push('connection: upgrade');
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    const teardown = (): void => {
      upstreamSocket.destroy();
      socket.destroy();
    };
    upstreamSocket.on('error', () => {
      instance.logs.warn(`HMR WebSocket 代理连接失败（127.0.0.1:${port}），热更新可能不可用`);
      teardown();
    });
    socket.on('error', teardown);
    socket.on('close', teardown);
    upstreamSocket.on('close', teardown);
  };

  const dispose = async (): Promise<void> => {
    for (const instance of instances.values()) {
      instance.dispose();
      await stopServer(instance).catch(() => undefined);
      await instance.runner?.stop().catch(() => undefined);
      await instance.orchestrator?.dispose().catch(() => undefined);
    }
    instances.clear();
  };

  const readRequestLogs = (projectId: string, taskId?: string): readonly ApiRequestLog[] => {
    const instance = instances.get(scopeOf(projectId, taskId ?? null));
    return instance === undefined ? [] : instance.requests;
  };

  const pending = new Map<string, Promise<unknown>>();
  const serialized: DomainRouter = (method, params, ctx) => {
    const projectId = requireProject(params);
    const scope = scopeOf(projectId, taskIdOf(params));
    const previous = pending.get(scope) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => router(method, params, ctx));
    pending.set(scope, next);
    void next
      .finally(() => {
        if (pending.get(scope) === next) pending.delete(scope);
      })
      .catch(() => undefined);
    return next;
  };
  return {
    router: serialized,
    dispose,
    readRequestLogs,
    readDomAttachments: (projectId, taskId) =>
      getInstance(projectId, taskId ?? null).inspection.readAttachments(),
  };
}

/* ------------------------------ 纯工具 ------------------------------ */

function readSafely(file: string): string | null {
  try {
    const stat = statSync(file);
    // 单独一份 spec 通常不大；超过 2MB 的文件不是我们想要的契约草案
    if (stat.size > 2_097_152) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 端口可用性探测（真实 listen 一次，比 `net.connect` 更少误判） */
function probePort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const probe = createServer();
    probe.once('error', () => resolveProbe(false));
    probe.once('listening', () => probe.close(() => resolveProbe(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** 端口可连性探测（运行实例的后端就绪判定；连接即认为服务已接受请求） */
function probeTcpPort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolveProbe(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

/**
 * 页面可加载探测（前端 dev server 就绪的第二条件，V2-SRC-06：
 * 就绪条件是健康检查和页面可加载，不是仅看到"启动成功"字样）。
 * HTTP GET /，状态码 < 500 即认为页面可加载（dev server 的 4xx 也说明 HTTP 栈已工作）。
 */
async function probePageReady(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1_500, agent: false },
      (res) => {
        res.resume();
        resolveProbe((res.statusCode ?? 500) < 500);
      },
    );
    req.once('timeout', () => {
      req.destroy();
      resolveProbe(false);
    });
    req.once('error', () => resolveProbe(false));
    req.end();
  });
}

/**
 * 给子进程注入 PORT 环境变量。
 *
 * 为什么必须注入：托管的 Node ``app.py``/`npm run dev` 大多从 `PORT` 读监听端口。
 * 不注入的话 BackendRunner 分配的端口与应用真实监听的端口会不一致，
 * 于是"预览地址能打开、接口全 502"——这是最容易误判成后端有 bug 的一种故障。
 */
async function waitForBackend(port: number, exited: Promise<unknown>): Promise<void> {
  let ended = false;
  void exited.then(() => {
    ended = true;
  });
  const deadline = Date.now() + 15_000;
  while (!ended && Date.now() < deadline) {
    const listening = await new Promise<boolean>((done) => {
      const socket = connect({ port, host: '127.0.0.1' });
      const finish = (ok: boolean): void => {
        socket.destroy();
        done(ok);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(200, () => finish(false));
    });
    if (listening && !ended) return;
    await new Promise<void>((done) => setTimeout(done, 80));
  }
  throw new Error(ended ? '进程已退出，请查看启动日志' : '等待监听端口超时，请检查 PORT 配置');
}

function validateApiPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) {
    throw new ShellError('INVALID_ARGUMENT', '接口地址必须是当前预览服务的相对路径');
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolveBody('');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolveBody(''));
  });
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return '"[无法序列化的响应]"';
  }
}

/**
 * 转发到真实后端。
 *
 * 只允许 127.0.0.1 基址（`backendUrl` 由本域自己从托管进程拿到），
 * 因此这里不存在"被请求体里的 URL 带去任意主机"的可能。
 */
async function forwardToBackend(
  baseUrl: string,
  input: { url: string; method: HttpMethodName; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; data: unknown }> {
  validateApiPath(input.url);
  const target = new URL(input.url, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (target.origin !== new URL(baseUrl).origin)
    throw new ShellError('INVALID_ARGUMENT', '接口请求越出托管后端');
  // `localhost` 在 Windows 上可能先解析到 ::1，而后端通常只 listen 了 127.0.0.1，
  // 直连会得到 ECONNRESET（表现为"预览地址能打开、接口全炸"）。这里统一落到 IPv4 回环。
  const hostname = target.hostname === 'localhost' ? '127.0.0.1' : target.hostname;
  const payload =
    input.body === undefined
      ? null
      : typeof input.body === 'string'
        ? input.body
        : JSON.stringify(input.body);
  return new Promise((resolveForward) => {
    const req = httpRequest(
      {
        hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: input.method,
        headers: {
          ...(input.headers ?? {}),
          ...(payload !== null
            ? {
                'Content-Type': input.headers?.['content-type'] ?? 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolveForward({ status: res.statusCode ?? 0, data: parseMaybeJson(text) });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolveForward({ status: 504, data: null });
    });
    req.on('error', () => resolveForward({ status: 502, data: null }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** 生成可直接粘贴执行的 cURL（含请求体，单引号转义） */
export function buildCurl(entry: ApiRequestLog, baseUrl: string): string {
  validateApiPath(entry.url);
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const url = `${baseUrl}${entry.url}`;
  const method = entry.method.toUpperCase();
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method))
    throw new ShellError('INVALID_ARGUMENT', '不支持的请求方法');
  const parts = [`curl -X ${method} ${quote(url)}`];
  for (const [key, value] of Object.entries(entry.requestHeaders ?? {}))
    parts.push(`-H ${quote(`${key}: ${value}`)}`);
  if (entry.requestBody !== null && entry.requestBody.length > 0) {
    if (!entry.requestHeaders?.['content-type']) parts.push("-H 'Content-Type: application/json'");
    parts.push(`--data-raw '${entry.requestBody.replace(/'/g, `'\\''`)}'`);
  }
  return parts.join(' ');
}

/** 本机局域网 IPv4（找不到时返回 null，调用方回退 127.0.0.1） */
export function localLanAddress(): string | null {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === 'IPv4') return entry.address;
    }
  }
  return null;
}

/** 在 PATH 里找可执行文件（不 spawn 进程：探测本身不该拖慢或阻塞） */
export function findInPath(names: readonly string[]): string | null {
  const dirs = (process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of dirs) {
    if (dir.trim().length === 0) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
