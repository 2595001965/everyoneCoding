import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, watch, type Dirent } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, relative } from 'node:path';
import type Database from 'better-sqlite3';

import {
  BackendRunner,
  BindingResolver,
  DEFAULT_MOCK_SETTINGS,
  DEFAULT_PREVIEW_PORT,
  DependencyInstaller,
  LogStream,
  MockResponseGenerator,
  OpenApiParseError,
  allocatePort,
  createFallbackOpenApi,
  detectProjectType,
  matchRoute,
  parseOpenApiDocument,
  type DataBinding,
  type HttpMethodName,
  type LoadedOpenApi,
  type ManagedProcess,
  type MockSettings,
  type PreviewResult,
  type ProcessHostPort,
  type ProjectProfile,
  type ResolvedResponse,
  type StreamedLogLine,
} from '@ec/preview';
import { ShellError } from '@ec/shell-api';

import type { ControlledProcessHost } from '../process-host';
import { createProjectPaths, PROJECT_SUBDIRS, type ProjectPaths } from '../paths';
import type { DomainRouter } from '../runtime';
import { createSettingStore, type SettingStore } from '../setting-store';

/**
 * preview 域生产路由（T12-04 预览部分）。
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
 * 数据来源优先级由 `BindingResolver` 保证（后端 > Mock > 静态假数据，FR-PRV-02），
 * 本域只负责把三条来源的真实能力注入进去。
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
const LAN_SHARING_KEY = 'preview_lan_sharing';
/** Mock 设置按项目存 */
const mockSettingsKey = (projectId: string): string => `preview_mock_settings:${projectId}`;

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
   * 非请求来源事件（后端进程的后续日志行）。日志在 `startBackend` 返回之后仍会持续产生，
   * 那时没有"在飞的请求"可以附着，必须走这条常驻事件口。
   */
  emit: (domain: 'preview', payload: unknown) => void;
}

interface PreviewInstance {
  readonly projectId: string;
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
  readRequestLogs: (projectId: string) => readonly ApiRequestLog[];
} {
  const paths: ProjectPaths = createProjectPaths({ projectsDir: options.projectsDir });
  const settings: SettingStore = createSettingStore({ db: options.db, userId: options.userId });
  const instances = new Map<string, PreviewInstance>();

  const requireProject = (params: Record<string, unknown>): string => {
    const projectId = String(params['projectId'] ?? '');
    if (projectId.length === 0) throw new ShellError('INVALID_ARGUMENT', '缺少 projectId');
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
  ): { spec: LoadedOpenApi; source: string | null } => {
    const docsDir = paths.projectDir(projectId, PROJECT_SUBDIRS.docs);
    const pipelineDir = paths.projectDir(projectId, PROJECT_SUBDIRS.pipeline);
    const candidates: string[] = [];

    const collect = (dir: string, depth = 0): void => {
      if (depth > 3 || !existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
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
          source: relative(paths.projectRoot(projectId), file),
        };
      } catch (error) {
        logs.warn(
          `OpenAPI 文件解析失败（已跳过）：${relative(paths.projectRoot(projectId), file)} ${
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
          source: relative(paths.projectRoot(projectId), file),
        };
      } catch {
        // 围栏内容不是合法 spec：继续找下一个候选
      }
    }

    logs.warn('未找到项目 OpenAPI 草案，Mock 将使用内置兜底契约（仅用于演示，不代表真实接口）');
    return { spec: createFallbackOpenApi(), source: null };
  };

  /* ------------------------------ 实例构造 ------------------------------ */

  const resolveStaticRoot = (projectId: string): { root: string; fallback: boolean } => {
    const codeRoot = paths.codeRoot(projectId);
    for (const candidate of STATIC_ROOT_CANDIDATES) {
      const dir = paths.projectDir(projectId, PROJECT_SUBDIRS.code, candidate);
      if (existsSync(dir) && statSync(dir).isDirectory()) return { root: dir, fallback: false };
    }
    return { root: codeRoot, fallback: true };
  };

  const instanceOf = (projectId: string): PreviewInstance => {
    const cached = instances.get(projectId);
    if (cached !== undefined) return cached;

    const codeRoot = paths.codeRoot(projectId);
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
      });
    });
    const { root: staticRoot, fallback } = resolveStaticRoot(projectId);
    const mockSettings = settings.read<MockSettings>(mockSettingsKey(projectId)) ?? {
      ...DEFAULT_MOCK_SETTINGS,
    };
    const mock = new MockResponseGenerator({ settings: mockSettings });
    const { spec, source } = loadOpenApiFor(projectId, logs);
    if (fallback) {
      logs.info('未发现构建产物目录（dist/build/public），静态预览直接托管代码根目录');
    }

    let backendUrl: string | null = null;
    const backendPort: { available: boolean } = { available: false };
    const pendingPort: { value: number | null } = { value: null };

    // 后端请求能力：只有"受控进程托管的真实后端"才算可用（FR-PRV-02 的第一优先级）
    const backendRequester = {
      get available(): boolean {
        return backendPort.available && backendUrl !== null;
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

    const instance: PreviewInstance = {
      projectId,
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
    instances.set(projectId, instance);
    return instance;
  };

  /* ------------------------------ 静态服务 ------------------------------ */

  const serveStatic = (
    instance: PreviewInstance,
    urlPath: string,
  ): { status: number; body: Buffer; type: string } | null => {
    const relativePath = decodeURIComponent(urlPath.split('?')[0] ?? '/');
    const root = instance.staticRoot;
    let target: string;
    try {
      target = paths.inside(root, relativePath === '/' ? 'index.html' : relativePath);
    } catch {
      return null;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      // SPA 兜底：未命中文件回 index.html（前端路由刷新不该 404）
      try {
        target = paths.inside(root, 'index.html');
      } catch {
        return null;
      }
      if (!existsSync(target)) return null;
    }
    const type = MIME[extname(target)] ?? 'application/octet-stream';
    return { status: 200, body: readFileSync(target), type };
  };

  const isApiRequest = (instance: PreviewInstance, method: string, urlPath: string): boolean => {
    if (urlPath.startsWith('/api/') || urlPath === '/api') return true;
    if (method !== 'GET' && method !== 'HEAD') return true;
    return matchRoute(instance.openapi.routes, method, urlPath) !== null;
  };

  const recordRequest = (
    instance: PreviewInstance,
    input: {
      method: HttpMethodName;
      url: string;
      requestBody: string | null;
      response: ResolvedResponse;
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
    const binding: DataBinding | null = null;
    let response: ResolvedResponse;
    try {
      response = await instance.resolver.resolve({
        url: urlPath,
        method,
        ...(body.length > 0 ? { body: parseMaybeJson(body) } : {}),
        binding,
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
    const lanSharing = readLanSharing();
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
      const method = (req.method ?? 'GET').toUpperCase();
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
      const file = serveStatic(instance, urlPath);
      if (file === null) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('预览资源不存在');
        return;
      }
      res.writeHead(200, {
        'Content-Type': file.type,
        'Cache-Control': 'no-store',
      });
      res.end(file.body);
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
  };

  const stopServer = async (instance: PreviewInstance): Promise<void> => {
    if (instance.server === null) return;
    await new Promise<void>((resolveClose) => {
      instance.server?.close(() => resolveClose());
    });
    instance.server = null;
    instance.port = null;
    instance.url = null;
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
          const full = join(dir, entry.name);
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

  const readLanSharing = (): boolean => settings.read<boolean>(LAN_SHARING_KEY) === true;

  /* ------------------------------ 路由 ------------------------------ */

  const router: DomainRouter = async (method, params) => {
    const projectId = requireProject(params);

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
        return null;
      }

      case 'pages': {
        const pages: Array<{ route: string; name: string }> = [];
        const designDir = paths.pagesDir(projectId);
        if (existsSync(designDir)) {
          for (const entry of readdirSync(designDir)) {
            if (!entry.endsWith('.dsl.json')) continue;
            try {
              const envelope = JSON.parse(readFileSync(join(designDir, entry), 'utf8')) as {
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
        const method =
          typeof input.method === 'string' && input.method.length > 0
            ? (input.method.toUpperCase() as HttpMethodName)
            : source.method;
        const body =
          input.body !== undefined ? input.body : parseMaybeJson(source.requestBody ?? '');
        const response = await instance.resolver.resolve({
          url,
          method,
          ...(body !== null && body !== undefined && `${body}`.length > 0 ? { body } : {}),
        });
        recordRequest(instance, {
          method,
          url,
          requestBody: body === null || body === undefined ? null : safeStringify(body),
          response,
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
        const instance = requireProcess(projectId, '依赖安装');
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
        const instance = requireProcess(projectId, '后端托管');
        const profile = instance.profile ?? detectProfile(instance);
        instance.profile = profile;
        if (options.process === null) {
          throw new ShellError('NOT_SUPPORTED', '后端托管需要受控进程端口，当前未装配。');
        }
        // ① 先分配端口（应用要从 PORT 环境变量读它）
        const basePort = profile.portHint ?? DEFAULT_PREVIEW_PORT + 100;
        const allocation = await allocatePort({ start: basePort, probe: probePort });
        instance.pendingPort.value = allocation.port;
        if (allocation.log !== null) instance.logs.info(allocation.log);

        // ② 用同一个端口建 runner，保证 runner 报的 url 与应用真实监听的端口一致
        const runner = new BackendRunner({
          process: withPortEnv(options.process, instance.pendingPort),
          logs: instance.logs,
          startPort: allocation.port,
          probe: probePort,
        });
        runner.onEvent((event) => {
          if (event.type === 'started') instance.setBackend(runner.status().process?.url ?? null);
          if (event.type === 'stopped' || event.type === 'exited') instance.setBackend(null);
        });
        instance.runner = runner;

        const result = await runner.start(profile, instance.codeRoot);
        if (result.ok && result.data !== null) {
          instance.setBackend(result.data.url);
          if (result.data.port !== allocation.port) {
            instance.logs.warn(
              `后端实际端口 ${result.data.port} 与预分配端口 ${allocation.port} 不一致，` +
                '接口代理将使用实际端口；若表单请求 502，请检查应用是否忽略 PORT 环境变量。',
            );
          }
        }
        return result;
      }

      case 'stopBackend': {
        const instance = requireProcess(projectId, '后端托管');
        if (instance.runner === null) {
          throw new ShellError('NOT_SUPPORTED', '后端尚未托管，无需停止。');
        }
        await instance.runner.stop();
        instance.setBackend(null);
        return null;
      }

      case 'restartBackend': {
        const instance = requireProcess(projectId, '后端托管');
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
        if (!readLanSharing()) {
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
        return readLanSharing();

      case 'setLanSharing': {
        const enabled = params['enabled'] === true;
        settings.write(LAN_SHARING_KEY, enabled);
        const instance = instanceOf(projectId);
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
        settings.write(mockSettingsKey(projectId), instance.mock.settings());
        instance.logs.info(
          // 注意措辞：日志分级按关键字判定，「错误率」会被误判成 error 级（ERROR_RE 命中"错误"）
          `Mock 设置已更新：规则 ${instance.mock.settings().rules.length} 条，延迟 ${JSON.stringify(
            instance.mock.settings().delayMs,
          )}，注入失败率 ${instance.mock.settings().errorRate}`,
        );
        return undefined;
      }

      default:
        throw new ShellError('INVALID_ARGUMENT', `preview 域未知方法：${method}`);
    }
  };

  /* ------------------------------ 内部工具 ------------------------------ */

  const requireProcess = (projectId: string, action: string): PreviewInstance => {
    const instance = instanceOf(projectId);
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
    return detectProjectType([...names]);
  };

  const dispose = async (): Promise<void> => {
    for (const instance of instances.values()) {
      instance.dispose();
      await stopServer(instance).catch(() => undefined);
      await instance.runner?.stop().catch(() => undefined);
    }
    instances.clear();
  };

  const readRequestLogs = (projectId: string): readonly ApiRequestLog[] => {
    const instance = instances.get(projectId);
    return instance === undefined ? [] : instance.requests;
  };

  return { router, dispose, readRequestLogs };
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

/**
 * 给子进程注入 PORT 环境变量。
 *
 * 为什么必须注入：托管的 Node ``app.py``/`npm run dev` 大多从 `PORT` 读监听端口。
 * 不注入的话 BackendRunner 分配的端口与应用真实监听的端口会不一致，
 * 于是"预览地址能打开、接口全 502"——这是最容易误判成后端有 bug 的一种故障。
 */
function withPortEnv(
  base: ControlledProcessHost,
  pendingPort: { value: number | null },
): ProcessHostPort {
  return {
    async spawn(command, args, spawnOptions) {
      const port = pendingPort.value;
      return base.spawn(command, args, {
        ...(spawnOptions?.cwd !== undefined ? { cwd: spawnOptions.cwd } : {}),
        env: {
          ...(spawnOptions?.env ?? {}),
          ...(port !== null ? { PORT: String(port) } : {}),
        },
        shell: spawnOptions?.shell ?? true,
      });
    },
  };
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
  const target = new URL(input.url, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  // `localhost` 在 Windows 上可能先解析到 ::1，而后端通常只 listen 了 127.0.0.1，
  // 直连会得到 ECONNRESET（表现为"预览地址能打开、接口全炸"）。这里统一落到 IPv4 回环。
  const hostname = target.hostname === 'localhost' ? '127.0.0.1' : target.hostname;
  const payload = input.body === undefined ? null : JSON.stringify(input.body);
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
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
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
  const url = entry.url.startsWith('http') ? entry.url : `${baseUrl}${entry.url}`;
  const parts = [`curl -X ${entry.method} '${url}'`];
  if (entry.requestBody !== null && entry.requestBody.length > 0) {
    parts.push("-H 'Content-Type: application/json'");
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
