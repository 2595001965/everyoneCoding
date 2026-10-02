import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDomainEventSink, type DomainControlServiceHost } from '@ec/shell-api';

import { openBusinessDb } from '../domain/db';
import { createControlledProcessHost } from '../domain/process-host';
import { createProductionDomains, type DomainFactoryContext } from '../domain/domain-factories';
import { createDomainRuntime } from '../domain/runtime';
import { createWorkspaceDomain } from '../domain/workspace';

/**
 * V2-D02 预览运行实例集成测试：真实 SQLite + 真实工程目录 + 真实子进程 + 真实 HTTP。
 *
 * 覆盖（D02 卡验收）：
 * 1. 运行计划识别 → 用户确认 → startRun：Vite 形态前端 dev server + Node 后端
 *    双服务真实启动，预览服务反代页面、/api 打到真实后端；
 * 2. 显式 Mock：默认 real 模式下后端不可用如实 502，不自动回退；显式切 mock 才有
 *    模拟数据且始终带 X-EC-Data-Source: mock 标记；显式 mock 压过运行中的后端；
 * 3. 精准停止：stopRuntime 只停该 runtimeId 的服务，端口释放、数据源摘除；
 *    缺依赖/环境失败可诊断（安装失败 → 实例 failed）；
 * 4. 缩略图：预览页就绪后从真实预览生成持久化 PNG，workspace.getThumbnailUrl
 *    返回可读 data URL；无页面时保持 null（明确占位，不编造地址）。
 */

let root: string;
let dataDir: string;
let projectsDir: string;
let db: Database.Database;
let runtime: DomainControlServiceHost;
let processHost: ReturnType<typeof createControlledProcessHost>;

const USER_ID = 'local-user';
const PROJECT_ID = 'p-d02-run';

/** 1x1 PNG（缩略图截图端口用测试替身，验证"落盘 + 可读"链路） */
const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface InvokeOptions {
  domain: string;
  method: string;
  params?: Record<string, unknown>;
}

function invoke(options: InvokeOptions): Promise<{
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}> {
  return runtime.invoke({
    requestId: `t-${options.domain}-${options.method}-${Math.random().toString(36).slice(2, 6)}`,
    domain: options.domain as never,
    method: options.method,
    params: options.params ?? {},
  });
}

async function call<T>(options: InvokeOptions): Promise<T> {
  const response = await invoke(options);
  if (!response.ok) {
    const error = new Error(response.error?.message ?? '域调用失败') as Error & {
      code?: string | undefined;
    };
    error.code = response.error?.code;
    throw error;
  }
  return response.result as T;
}

/** 测试专用无池 HTTP 客户端（undici 池复用 socket 会对重启的服务稳定 ECONNRESET） */
function rawFetch(
  url: string,
): Promise<{ status: number; headers: Map<string, string>; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      { host: target.hostname, port: target.port, path: target.pathname, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const headers = new Map<string, string>();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers.set(name, value);
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function projectFile(relative: string, content: string): void {
  const full = join(projectsDir, PROJECT_ID, relative);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

interface ServiceEndpoint {
  serviceId: string;
  kind: 'frontend' | 'backend';
  port: number | null;
  baseUrl: string | null;
  healthPath: string | null;
}

interface RuntimeSnapshot {
  runtimeId: string;
  status: string;
  services: ServiceEndpoint[];
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-d02-'));
  dataDir = join(root, 'data');
  projectsDir = join(root, 'projects');
  mkdirSync(projectsDir, { recursive: true });

  db = openBusinessDb({ dataDir });
  const now = Date.now();
  db.prepare(
    `INSERT INTO project (id, user_id, name, description, status, created_at, updated_at)
     VALUES (?, ?, 'D02 运行工程', NULL, 'active', ?, ?)`,
  ).run(PROJECT_ID, USER_ID, now, now);

  // 工程文件：React/Vite 形态前端（dev server 模拟 Vite CLI 的 --port/--strictPort）
  // + services/api 的 Node 后端（从 PORT 环境变量读监听端口）
  projectFile(
    'code/package.json',
    JSON.stringify({
      name: 'd02-fixture',
      private: true,
      workspaces: ['services/*'],
      scripts: { dev: 'node dev-server.mjs' },
      dependencies: { react: '18.0.0' },
      devDependencies: { vite: '5.0.0' },
    }),
  );
  projectFile('code/index.html', '<!doctype html><title>static</title><h1>static-page</h1>');
  projectFile(
    'code/dev-server.mjs',
    [
      "import { createServer } from 'node:http';",
      'const argv = process.argv.slice(2);',
      "const i = argv.indexOf('--port');",
      'const port = i >= 0 ? Number(argv[i + 1]) : 5173;',
      "const strict = argv.includes('--strictPort');",
      'const server = createServer((_req, res) => {',
      "  res.setHeader('Content-Type', 'text/html');",
      "  res.end('<html><body><h1>dev-page</h1></body></html>');",
      '});',
      "server.on('error', (err) => { console.error('listen failed', err.code); process.exit(1); });",
      "server.listen(port, '127.0.0.1', () => console.log('dev ready on', port, strict ? '(strict)' : ''));",
    ].join('\n'),
  );
  projectFile(
    'code/services/api/package.json',
    JSON.stringify({
      name: 'd02-api',
      private: true,
      scripts: { start: 'node api-server.mjs' },
      dependencies: { express: '4.0.0' },
    }),
  );
  projectFile(
    'code/services/api/api-server.mjs',
    [
      "import { createServer } from 'node:http';",
      'const port = Number(process.env.PORT || 3100);',
      'const server = createServer((req, res) => {',
      "  res.setHeader('Content-Type', 'application/json');",
      "  const url = req.url ?? '/';",
      "  if (url === '/health' || url.startsWith('/api/')) {",
      "    res.end(JSON.stringify({ status: 'ok', via: 'real-backend', path: url }));",
      '  } else {',
      '    res.statusCode = 404;',
      "    res.end('{}');",
      '  }',
      '});',
      "server.on('error', (err) => { console.error('listen failed', err.code); process.exit(1); });",
      "server.listen(port, '127.0.0.1', () => console.log('api ready on', port));",
    ].join('\n'),
  );

  processHost = createControlledProcessHost({ allowedRoot: projectsDir });

  const ctx: DomainFactoryContext = {
    db,
    projectsDir,
    dataDir,
    userId: USER_ID,
    aiStack: null,
    process: processHost,
    capturePage: async (url) =>
      url.startsWith('http://127.0.0.1') ? Buffer.from(FAKE_PNG) : null,
    credentials: null,
    emit: () => undefined,
  };
  const production = createProductionDomains(ctx);
  const workspace = createWorkspaceDomain({ db, dataDir, projectsDir });
  const events = createDomainEventSink();
  runtime = createDomainRuntime({
    routers: { workspace: workspace.router, ...production.routers },
    syncRouters: production.syncRouters,
    events,
    disposers: production.disposers,
  });
});

afterAll(async () => {
  await runtime.dispose();
  await processHost.dispose();
  db.close();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }
});

async function previewUrl(): Promise<string> {
  const state = await call<{ url: string | null }>({
    domain: 'preview',
    method: 'state',
    params: { projectId: PROJECT_ID },
  });
  if (state.url === null) throw new Error('预览服务未启动');
  return state.url;
}

/** runPlan → 用测试替换安装命令（避免真实 npm install）→ confirmRunPlan */
async function confirmFixturePlan(): Promise<void> {
  const suggestion = await call<{
    plannerVersion: string;
    subProjects: Array<{ subProjectId: string; role: string; suggestedRunPlan: Record<string, unknown> | null }>;
    plan: { services: Array<{ serviceId: string; role: string; command: string }> } | null;
    requiresConfirmation: boolean;
    notes: string[];
  }>({ domain: 'preview', method: 'runPlan', params: { projectId: PROJECT_ID } });

  const plans = suggestion.subProjects
    .map((sub) => sub.suggestedRunPlan)
    .filter((plan): plan is Record<string, unknown> => plan !== null)
    .map((plan) => {
      const copy = JSON.parse(JSON.stringify(plan)) as {
        services: Array<{ role: string; command: string }>;
      };
      for (const svc of copy.services) {
        // 安装步骤替换为无网络的 Node 调用（保留"安装先行"的编排语义）
        if (svc.role === 'install') svc.command = 'node -e "console.log(\'install-ok\')"';
      }
      return copy;
    });
  expect(plans.length).toBeGreaterThanOrEqual(2);
  await call({
    domain: 'preview',
    method: 'confirmRunPlan',
    params: { projectId: PROJECT_ID, plans, plannerVersion: suggestion.plannerVersion },
  });
}

describe('V2-D02 运行实例与显式数据模式（真实进程）', () => {
  it('缩略图：预览未启动时 getThumbnailUrl 保持 null（明确占位）', async () => {
    const url = await call<string | null>({
      domain: 'workspace',
      method: 'getThumbnailUrl',
      params: { projectId: PROJECT_ID },
    });
    expect(url).toBeNull();
    expect(existsSync(join(projectsDir, PROJECT_ID, 'meta', 'thumbnail.png'))).toBe(false);
  });

  it('默认 real 模式：后端不可用时接口如实 502，不自动回退 Mock', async () => {
    const state = await call<{ dataMode: string }>({
      domain: 'preview',
      method: 'state',
      params: { projectId: PROJECT_ID },
    });
    expect(state.dataMode).toBe('real');

    const start = await call<{ url: string }>({
      domain: 'preview',
      method: 'start',
      params: { projectId: PROJECT_ID, mode: 'static' },
    });
    expect(start.url).toContain('http://127.0.0.1:');

    const health = await rawFetch(`${start.url}/health`);
    expect(health.status).toBe(502);
    expect(health.headers.get('x-ec-data-source')).toBe('backend');
    expect(health.text).toContain('真实后端不可用');

    // 显式切到 Mock 才有模拟数据，且带来源标记
    await call({
      domain: 'preview',
      method: 'setDataMode',
      params: { projectId: PROJECT_ID, mode: 'mock' },
    });
    const mocked = await rawFetch(`${start.url}/health`);
    expect(mocked.status).toBe(200);
    expect(mocked.headers.get('x-ec-data-source')).toBe('mock');

    // 切回真实模式，恢复如实报错
    await call({
      domain: 'preview',
      method: 'setDataMode',
      params: { projectId: PROJECT_ID, mode: 'real' },
    });
    const real = await rawFetch(`${start.url}/health`);
    expect(real.status).toBe(502);
  });

  it('运行计划：识别出 Vite 前端 + Node 后端，未经确认 startRun 被拒', async () => {
    const suggestion = await call<{
      subProjects: Array<{ role: string; framework: string | null; suggestedRunPlan: unknown }>;
      plan: { services: Array<{ role: string; command: string }> } | null;
      requiresConfirmation: boolean;
    }>({ domain: 'preview', method: 'runPlan', params: { projectId: PROJECT_ID } });

    const roles = suggestion.subProjects.map((s) => s.role);
    expect(roles).toContain('frontend');
    expect(roles).toContain('backend');
    const frontendSub = suggestion.subProjects.find((s) => s.role === 'frontend')!;
    expect(frontendSub.framework).toBe('react-vite');
    expect(suggestion.requiresConfirmation).toBe(true);
    expect(suggestion.plan?.services.some((s) => s.role === 'install')).toBe(true);

    await expect(
      call({ domain: 'preview', method: 'startRun', params: { projectId: PROJECT_ID } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('确认计划 → startRun：双服务真实就绪，页面反代到 dev server，/api 打到真实后端', async () => {
    await confirmFixturePlan();
    let snapshot: RuntimeSnapshot;
    try {
      snapshot = await call<RuntimeSnapshot>({
        domain: 'preview',
        method: 'startRun',
        params: { projectId: PROJECT_ID },
      });
    } catch (error) {
      const logs = await call<unknown[]>({
        domain: 'preview',
        method: 'logs',
        params: { projectId: PROJECT_ID },
      });
      console.error('[debug] startRun 失败，预览日志：');
      for (const line of logs.slice(-40)) console.error(JSON.stringify(line));
      throw error;
    }
    expect(snapshot.runtimeId).toBeTruthy();
    expect(snapshot.status).toBe('ready');
    expect(snapshot.services).toHaveLength(2);
    const frontend = snapshot.services.find((s) => s.kind === 'frontend')!;
    const backend = snapshot.services.find((s) => s.kind === 'backend')!;
    expect(frontend.port).not.toBe(backend.port);
    expect(frontend.baseUrl).toBe(`http://127.0.0.1:${frontend.port}`);

    const url = await previewUrl();

    // 页面反代：预览端口返回的是 dev server 的页面（不是静态 index.html）
    const page = await rawFetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('dev-page');

    // /api → 真实后端（source=backend）
    const api = await rawFetch(`${url}/api/health`);
    expect(api.status).toBe(200);
    expect(api.headers.get('x-ec-data-source')).toBe('backend');
    expect(JSON.parse(api.text)).toMatchObject({ via: 'real-backend' });

    // 后端端口本身也可直连（就绪判定不是只看"启动成功"日志）
    const direct = await rawFetch(`${backend.baseUrl}/health`);
    expect(direct.status).toBe(200);
    expect(JSON.parse(direct.text)).toMatchObject({ via: 'real-backend' });
  });

  it('显式 Mock 压过运行中的真实后端；切回后恢复真实数据', async () => {
    const url = await previewUrl();

    await call({
      domain: 'preview',
      method: 'setDataMode',
      params: { projectId: PROJECT_ID, mode: 'mock' },
    });
    const mocked = await rawFetch(`${url}/health`);
    expect(mocked.status).toBe(200);
    expect(mocked.headers.get('x-ec-data-source')).toBe('mock');

    await call({
      domain: 'preview',
      method: 'setDataMode',
      params: { projectId: PROJECT_ID, mode: 'real' },
    });
    const real = await rawFetch(`${url}/health`);
    expect(real.status).toBe(200);
    expect(real.headers.get('x-ec-data-source')).toBe('backend');
    expect(JSON.parse(real.text)).toMatchObject({ via: 'real-backend' });
  });

  it('精准停止：stopRuntime 后双服务端口释放、数据源摘除，页面回退静态托管', async () => {
    const snapshot = await call<RuntimeSnapshot>({
      domain: 'preview',
      method: 'runStatus',
      params: { projectId: PROJECT_ID },
    });
    const frontend = snapshot.services.find((s) => s.kind === 'frontend')!;
    const backend = snapshot.services.find((s) => s.kind === 'backend')!;
    const url = await previewUrl();

    const after = await call<RuntimeSnapshot | null>({
      domain: 'preview',
      method: 'stopRuntime',
      params: { projectId: PROJECT_ID, runtimeId: snapshot.runtimeId },
    });
    expect(after?.status).toBe('stopped');

    // 端口真的释放了（连不上），而不是"日志说停了"
    await expect(rawFetch(`${backend.baseUrl}/health`)).rejects.toThrow();
    await expect(rawFetch(`http://127.0.0.1:${frontend.port}/`)).rejects.toThrow();

    // 预览服务还在：页面回退静态托管（代码根 index.html），/api 恢复如实报错
    const page = await rawFetch(`${url}/`);
    expect(page.text).toContain('static-page');
    const api = await rawFetch(`${url}/api/health`);
    expect(api.status).toBe(502);
  });

  it('再次启动得到新 runtimeId；预览 stop 全部清停', async () => {
    const first = await call<RuntimeSnapshot>({
      domain: 'preview',
      method: 'startRun',
      params: { projectId: PROJECT_ID },
    });
    expect(first.status).toBe('ready');
    const second = await call<RuntimeSnapshot>({
      domain: 'preview',
      method: 'startRun',
      params: { projectId: PROJECT_ID },
    });
    expect(second.runtimeId).not.toBe(first.runtimeId);

    await call({ domain: 'preview', method: 'stop', params: { projectId: PROJECT_ID } });
    for (const svc of second.services) {
      if (svc.port === null) continue;
      await expect(rawFetch(`http://127.0.0.1:${svc.port}/`)).rejects.toThrow();
    }
  });

  it('缩略图：预览页就绪后生成持久化 PNG，getThumbnailUrl 返回 data URL', async () => {
    const state = await call<{ url: string | null }>({
      domain: 'preview',
      method: 'state',
      params: { projectId: PROJECT_ID },
    });
    if (state.url === null) {
      await call({
        domain: 'preview',
        method: 'start',
        params: { projectId: PROJECT_ID, mode: 'static' },
      });
    }
    // captureThumbnailFor 是 fire-and-forget：给截图端口留出落盘时间
    await new Promise<void>((done) => setTimeout(done, 500));
    // 预览在上一用例被 stop，重新 start 已触发截图
    const file = join(projectsDir, PROJECT_ID, 'meta', 'thumbnail.png');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(FAKE_PNG)).toBe(true);

    const url = await call<string | null>({
      domain: 'workspace',
      method: 'getThumbnailUrl',
      params: { projectId: PROJECT_ID },
    });
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it('安装失败可诊断：实例 failed 且不启动任何服务', async () => {
    // 覆盖一份"必败"安装命令的计划
    const suggestion = await call<{
      subProjects: Array<{ suggestedRunPlan: Record<string, unknown> | null }>;
    }>({ domain: 'preview', method: 'runPlan', params: { projectId: PROJECT_ID } });
    const plans = suggestion.subProjects
      .map((sub) => sub.suggestedRunPlan)
      .filter((plan): plan is Record<string, unknown> => plan !== null)
      .map((plan) => {
        const copy = JSON.parse(JSON.stringify(plan)) as {
          services: Array<{ role: string; command: string }>;
        };
        for (const svc of copy.services) {
          if (svc.role === 'install') svc.command = 'node -e "process.exit(3)"';
        }
        return copy;
      });
    await call({
      domain: 'preview',
      method: 'confirmRunPlan',
      params: { projectId: PROJECT_ID, plans },
    });
    await expect(
      call({ domain: 'preview', method: 'startRun', params: { projectId: PROJECT_ID } }),
    ).rejects.toThrow(/安装步骤失败/);
    const snapshot = await call<RuntimeSnapshot | null>({
      domain: 'preview',
      method: 'runStatus',
      params: { projectId: PROJECT_ID },
    });
    expect(snapshot?.status).toBe('failed');
    expect(snapshot?.services).toHaveLength(0);

    // 恢复正常计划，别影响其它用例（本文件最后一个用例，保持卫生即可）
    await confirmFixturePlan();
  });
});
