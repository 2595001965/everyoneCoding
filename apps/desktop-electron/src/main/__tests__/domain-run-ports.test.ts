import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDomainEventSink, type DomainControlServiceHost } from '@ec/shell-api';
import { createElement, createEmptyPage, deserializePageDsl, serializePageDsl } from '@ec/designer/dsl';

import { openBusinessDb } from '../domain/db';
import { createProjectPaths } from '../domain/paths';
import { createControlledProcessHost } from '../domain/process-host';
import { createDomainRuntime } from '../domain/runtime';
import {
  createProductionDomains,
  type DomainFactoryContext,
} from '../domain/domain-factories';
import { upsertRegistryEntry } from '../domain/domains/rename-domain';

/**
 * T12-04 生产端口集成测试：Git / 预览 / 导航 / 统一重命名。
 *
 * 全部走**真实** SQLite + 真实工程目录 + 真实域运行时 + 真实子进程，
 * 断言对象是落盘的文件、表里的行、真实的 HTTP 响应与跨进程返回的信封。
 *
 * 覆盖点（对应任务书的五条实现要求与三条验收）：
 * 1. 路径安全：越界 projectId / 相对路径一律拒绝（PATH_ESCAPE / INVALID_ARGUMENT）；
 * 2. 静态预览可访问、端口顺延、Mock 响应、API 面板记录 / 重放 / cURL；
 * 3. 真实后端托管：起一个 Node demo，表单请求打到真实后端（source=backend）；
 * 4. 局域网预览默认关闭、开启提示风险、二维码给局域网地址；
 * 5. 导航：Ctrl 跳转（锚点）+ 反向跳转（注释标记与行区间兜底）+ 跳转统计 + 关系图；
 * 6. 重命名：注册表 → 影响面 → 四栏 diff → 事务执行（代码/文档/记忆/DSL/锚点/注册表）
 *    → 不误伤注释与局部变量（E2E-16）→ 一键撤销（E2E-17）。
 */

let root: string;
let dataDir: string;
let projectsDir: string;
let db: Database.Database;
let runtime: DomainControlServiceHost;
let processHost: ReturnType<typeof createControlledProcessHost>;

const USER_ID = 'local-user';
const PROJECT_ID = 'p-run-ports';

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
    requestId: `t-${options.domain}-${options.method}`,
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

async function expectCode(options: InvokeOptions, code: string): Promise<void> {
  const response = await invoke(options);
  expect(response.ok, `应当失败但成功了：${options.domain}.${options.method}`).toBe(false);
  expect(response.error?.code).toBe(code);
}

function projectFile(relative: string, content: string): void {
  const full = join(projectsDir, PROJECT_ID, relative);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function readProjectFile(relative: string): string {
  return readFileSync(join(projectsDir, PROJECT_ID, relative), 'utf8');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-t1204-'));
  dataDir = join(root, 'data');
  projectsDir = join(root, 'projects');
  mkdirSync(projectsDir, { recursive: true });

  db = openBusinessDb({ dataDir });
  const now = Date.now();
  // 本地用户在 openBusinessDb 里已幂等建过，这里只补项目行
  db.prepare(
    `INSERT INTO project (id, user_id, name, description, status, created_at, updated_at)
     VALUES (?, ?, '运行端口工程', NULL, 'active', ?, ?)`,
  ).run(PROJECT_ID, USER_ID, now, now);

  processHost = createControlledProcessHost({ allowedRoot: projectsDir });

  const ctx: DomainFactoryContext = {
    db,
    projectsDir,
    dataDir,
    userId: USER_ID,
    aiStack: null,
    process: processHost,
    credentials: null,
    emit: (domain, payload) => {
      broadcast.push({ domain, payload });
    },
  };
  const production = createProductionDomains(ctx);
  const events = createDomainEventSink();
  events.subscribe((event) => broadcast.push({ domain: event.domain, payload: event.payload }));
  runtime = createDomainRuntime({
    routers: production.routers,
    syncRouters: production.syncRouters,
    events,
    disposers: production.disposers,
  });
});

const broadcast: Array<{ domain: string; payload: unknown }> = [];

afterAll(async () => {
  await runtime.dispose();
  await processHost.dispose();
  db.close();
  // 临时目录清理是尽力而为：Windows 上若仍有句柄未释放（杀软扫描 / 子进程退出竞态），
  // rmSync 会 EPERM——失败不应判整套用例失败，OS 会回收 %TEMP%
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }
  console.warn(`[afterAll] 临时目录未能删除（句柄未释放）：${root}`);
});

/* ------------------------------ 1. 路径安全 ------------------------------ */

describe('工程根目录安全校验', () => {
  it('createProjectPaths 拒绝越界 id 与越界相对路径', () => {
    const paths = createProjectPaths({ projectsDir });
    const codeRoot = paths.codeRoot(PROJECT_ID);

    expect(() => paths.projectRoot('../evil')).toThrowError(/非法项目标识/);
    expect(() => paths.projectRoot('..')).toThrowError(/非法项目标识/);
    expect(() => paths.inside(codeRoot, '../outside.ts')).toThrowError(/越出工程根目录/);
    expect(() => paths.inside(codeRoot, 'C:/Windows/system32/evil.dll')).toThrowError(
      /越出工程根目录/,
    );
    expect(() => paths.inside(codeRoot, '\\\\server\\share\\x')).toThrowError(/越出工程根目录/);
    // 正常路径必须通过（否则"安全校验"会直接变成不可用）
    expect(paths.relative(codeRoot, paths.inside(codeRoot, 'src/app.ts'))).toBe('src/app.ts');
  });

  it('四域在收到越界 projectId 时一律拒绝，而不是去读磁盘', async () => {
    for (const domain of ['git', 'preview', 'rename']) {
      await expectCode({ domain, method: 'openProject', params: { projectId: '../evil' } }, 'INVALID_ARGUMENT');
    }
    await expectCode(
      { domain: 'nav', method: 'openProject', params: { projectId: '..\\evil' } },
      'INVALID_ARGUMENT',
    );
  });

  it('受控进程端口拒绝把工作目录设到工程根之外', async () => {
    await expect(
      processHost.spawn('node', ['-e', 'console.log(1)'], { cwd: root }),
    ).rejects.toThrowError(/越出工程根目录/);
  });
});

/* ------------------------------ 2. 预览：静态 + Mock + API 面板 ------------------------------ */

describe('预览生产端口（静态 / Mock / API 调试）', () => {
  it('静态预览可访问；未匹配接口走 Mock；端口顺延有提示', async () => {
    // 静态产物目录（优先托管 dist）
    projectFile('code/dist/index.html', '<!doctype html><title>预览页</title><h1>demo</h1>');
    projectFile('code/package.json', JSON.stringify({ name: 'demo', scripts: { dev: 'node server.js' } }));

    const started = await call<{ port: number; url: string; shifted: boolean }>({
      domain: 'preview',
      method: 'start',
      params: { projectId: PROJECT_ID, mode: 'static' },
    });
    expect(started.port).toBeGreaterThan(0);

    const html = await fetch(`${started.url}/`).then((res) => res.text());
    expect(html).toContain('预览页');

    // 未匹配到 OpenAPI 路由的接口：走内置兜底 spec 的 /health（Mock 数据源）
    const health = await fetch(`${started.url}/health`);
    expect(health.headers.get('x-ec-data-source')).toBe('mock');
    const payload = (await health.json()) as { status?: unknown };
    expect(typeof payload.status).toBe('string');

    // API 面板记录 + cURL + 重放（先清空，保证计数确定）
    await call({ domain: 'preview', method: 'clearRequests', params: { projectId: PROJECT_ID } });
    await fetch(`${started.url}/health`);

    const logs = await call<Array<{ id: string; method: string; url: string; source: string }>>({
      domain: 'preview',
      method: 'requests',
      params: { projectId: PROJECT_ID },
    });
    expect(logs.length).toBe(1);
    const last = logs.at(-1);
    expect(last?.source).toBe('mock');
    expect(last?.url).toBe('/health');

    const curl = await call<string>({
      domain: 'preview',
      method: 'toCurl',
      params: { projectId: PROJECT_ID, input: { id: last?.id } },
    });
    expect(curl).toContain('curl -X GET');
    expect(curl).toContain('/health');

    const replayed = await call<{ status: number; source: string }>({
      domain: 'preview',
      method: 'replayRequest',
      params: { projectId: PROJECT_ID, input: { id: last?.id } },
    });
    expect(replayed.status).toBe(200);
    expect(replayed.source).toBe('mock');

    // 重放本身也要进日志（否则"重放了几次"无法追溯）
    const afterReplay = await call<unknown[]>({
      domain: 'preview',
      method: 'requests',
      params: { projectId: PROJECT_ID },
    });
    expect(afterReplay.length).toBe(2);

    await call({ domain: 'preview', method: 'clearRequests', params: { projectId: PROJECT_ID } });
    expect(
      await call<unknown[]>({ domain: 'preview', method: 'requests', params: { projectId: PROJECT_ID } }),
    ).toEqual([]);
  });

  it('默认端口被占用时自动顺延，并在 notice 里说清原因', async () => {
    await call({ domain: 'preview', method: 'stop', params: { projectId: PROJECT_ID } });
    const blocker: Server = createServer((_req, res) => res.end('busy'));
    await new Promise<void>((resolveListen) =>
      blocker.listen(4173, '127.0.0.1', () => resolveListen()),
    );
    try {
      const started = await call<{ port: number; shifted: boolean }>({
        domain: 'preview',
        method: 'start',
        params: { projectId: PROJECT_ID, mode: 'static' },
      });
      expect(started.shifted).toBe(true);
      expect(started.port).toBe(4174);
      const state = await call<{ notice: string | null }>({
        domain: 'preview',
        method: 'state',
        params: { projectId: PROJECT_ID },
      });
      expect(state.notice).toContain('顺延');
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
      await call({ domain: 'preview', method: 'stop', params: { projectId: PROJECT_ID } });
    }
  });

  it('局域网预览默认关闭；开启前取二维码被拒并说明风险；开启后给局域网地址', async () => {
    await call({ domain: 'preview', method: 'start', params: { projectId: PROJECT_ID, mode: 'static' } });
    expect(
      await call<boolean>({ domain: 'preview', method: 'lanSharingEnabled', params: { projectId: PROJECT_ID } }),
    ).toBe(false);
    await expectCode(
      { domain: 'preview', method: 'deviceQr', params: { projectId: PROJECT_ID, channelId: 'mobile' } },
      'NOT_SUPPORTED',
    );

    const devices = await call<Array<{ id: string; available: boolean; guide: string | null }>>({
      domain: 'preview',
      method: 'devices',
      params: { projectId: PROJECT_ID },
    });
    // 桌面端永远可用；移动端/鸿蒙按探测结果如实标记并给安装引导
    expect(devices.find((item) => item.id === 'desktop')?.available).toBe(true);
    const mobile = devices.find((item) => item.id === 'mobile');
    expect(mobile?.available === true || (mobile?.guide ?? '').includes('adb')).toBe(true);

    await call({
      domain: 'preview',
      method: 'setLanSharing',
      params: { projectId: PROJECT_ID, enabled: true },
    });
    expect(
      await call<boolean>({ domain: 'preview', method: 'lanSharingEnabled', params: { projectId: PROJECT_ID } }),
    ).toBe(true);
    const qr = await call<{ url: string; qrText: string }>({
      domain: 'preview',
      method: 'deviceQr',
      params: { projectId: PROJECT_ID, channelId: 'mobile' },
    });
    expect(qr.qrText).toBe(qr.url);
    expect(qr.url.startsWith('http://')).toBe(true);
    // 关闭后回到默认态，且不再提供二维码
    await call({
      domain: 'preview',
      method: 'setLanSharing',
      params: { projectId: PROJECT_ID, enabled: false },
    });
    await expectCode(
      { domain: 'preview', method: 'deviceQr', params: { projectId: PROJECT_ID, channelId: 'mobile' } },
      'NOT_SUPPORTED',
    );
    await call({ domain: 'preview', method: 'stop', params: { projectId: PROJECT_ID } });
  });

  it('Mock 设置可持久化（重载域后仍生效）', async () => {
    await call({
      domain: 'preview',
      method: 'setMockSettings',
      params: { projectId: PROJECT_ID, patch: { delayMs: 12, errorRate: 0.5, errorStatus: 503 } },
    });
    const settings = await call<{ delayMs: number; errorStatus: number }>({
      domain: 'preview',
      method: 'mockSettings',
      params: { projectId: PROJECT_ID },
    });
    expect(settings.delayMs).toBe(12);
    expect(settings.errorStatus).toBe(503);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM setting WHERE key LIKE 'preview_mock_settings:%'`).get(),
    ).toEqual({ n: 1 });
  });
});

/* ------------------------------ 3. 真实后端托管 ------------------------------ */

describe('真实后端托管（受控进程端口）', () => {
  const DEMO = [
    "const http = require('node:http');",
    'const port = Number(process.env.PORT || 3100);',
    'const server = http.createServer((req, res) => {',
    "  let body = '';",
    "  req.on('data', (chunk) => { body += chunk; });",
    "  req.on('end', () => {",
    "    res.setHeader('content-type', 'application/json');",
    '    res.end(JSON.stringify({',
    '      ok: true,',
    '      port,',
    '      method: req.method,',
    '      path: req.url,',
    "      echo: body.length > 0 ? JSON.parse(body) : null,",
    '    }));',
    '  });',
    '});',
    "server.listen(port, '127.0.0.1', () => console.log('demo listening on ' + port));",
    '',
  ].join('\n');

  it('启动 Node demo 后，表单请求打到真实后端（source=backend），日志可查', async () => {
    projectFile('code/server.js', DEMO);
    projectFile('code/package.json', JSON.stringify({ name: 'demo', scripts: { dev: 'node server.js' } }));

    const profile = await call<{ kind: string; startCmd: string | null; requiresManualCommand: boolean }>({
      domain: 'preview',
      method: 'projectProfile',
      params: { projectId: PROJECT_ID },
    });
    expect(profile.kind).toBe('node');
    expect(profile.startCmd).toBe('npm run dev');

    const started = await call<{ ok: boolean; data: { port: number; url: string } | null; error: unknown }>({
      domain: 'preview',
      method: 'startBackend',
      params: { projectId: PROJECT_ID },
    });
    expect(started.ok, `后端启动失败：${JSON.stringify(started.error)}`).toBe(true);
    const backendPort = started.data?.port ?? 0;
    expect(backendPort).toBeGreaterThan(0);

    // 预览服务本身也要起来：它承担"表单请求 → 真实后端"的转发与记录
    const preview = await call<{ url: string }>({
      domain: 'preview',
      method: 'start',
      params: { projectId: PROJECT_ID, mode: 'linked' },
    });

    // 等后端真正开始监听：`startBackend` 在 spawn 后立即返回（进程托管语义），
    // 此刻 `npm run dev` 还在启动中。不等待的话，请求会打到"还没监听"的后端，
    // 这正是验收里"表单请求打到真实后端"最容易被误判成失败的场景。
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      const lines = await call<Array<{ text: string }>>({
        domain: 'preview',
        method: 'logs',
        params: { projectId: PROJECT_ID },
      });
      if (lines.some((line) => line.text.includes('demo listening on'))) {
        ready = true;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    expect(ready).toBe(true);

    const response = await fetch(`${preview.url}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'wu' }),
    }).catch(async (error: unknown) => {
      // 失败时把预览侧的请求日志与后端日志带出来：能直接区分"转发失败"与"后端没起来"
      const diag = await call<unknown[]>({
        domain: 'preview',
        method: 'requests',
        params: { projectId: PROJECT_ID },
      });
      const backendLogs = await call<Array<{ text: string; level: string }>>({
        domain: 'preview',
        method: 'logs',
        params: { projectId: PROJECT_ID },
      });
      const probe = await fetch(`${preview.url}/`).then(
        (res) => `GET / → ${res.status}`,
        (cause: unknown) => `GET / 也失败：${cause instanceof Error ? cause.message : ''}`,
      );
      throw new Error(
        `表单请求失败：${error instanceof Error ? error.message : String(error)}；` +
          `preview.url=${preview.url}；${probe}；` +
          `预览请求日志=${JSON.stringify(diag)}；后端日志=${JSON.stringify(backendLogs.slice(-8))}`,
      );
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; echo: { username: string } | null; port: number };
    expect(body.ok).toBe(true);
    expect(body.echo?.username).toBe('wu');
    // 端口一致性：应用真实监听的端口就是预分配并注入 PORT 的那个
    expect(body.port).toBe(backendPort);
    expect(response.headers.get('x-ec-data-source')).toBe('backend');

    // 请求日志登记为 backend 来源
    const logs = await call<Array<{ url: string; source: string; method: string }>>({
      domain: 'preview',
      method: 'requests',
      params: { projectId: PROJECT_ID },
    });
    const login = logs.find((item) => item.url === '/api/login');
    expect(login?.source).toBe('backend');
    expect(login?.method).toBe('POST');

    // 后端启动日志经常驻事件口回流（结构化行），且缓冲里也查得到
    const lines = await call<Array<{ text: string; source: string }>>({
      domain: 'preview',
      method: 'logs',
      params: { projectId: PROJECT_ID },
    });
    expect(lines.some((line) => line.text.includes('demo listening on'))).toBe(true);
    expect(
      broadcast.some((item) => {
        const payload = item.payload as { type?: string } | null;
        return item.domain === 'preview' && payload?.type === 'preview:log';
      }),
    ).toBe(true);

    const status = await call<{ running: boolean }>({
      domain: 'preview',
      method: 'backendStatus',
      params: { projectId: PROJECT_ID },
    });
    expect(status.running).toBe(true);

    await call({ domain: 'preview', method: 'stopBackend', params: { projectId: PROJECT_ID } });
    const stopped = await call<{ running: boolean }>({
      domain: 'preview',
      method: 'backendStatus',
      params: { projectId: PROJECT_ID },
    });
    expect(stopped.running).toBe(false);
    await call({ domain: 'preview', method: 'stop', params: { projectId: PROJECT_ID } });
  }, 120_000);

  it('未装配进程端口时后端托管如实报 NOT_SUPPORTED（静态预览不受影响）', async () => {
    const degraded = createProductionDomains({
      db,
      projectsDir,
      dataDir,
      userId: USER_ID,
      aiStack: null,
      process: null,
      credentials: null,
      emit: () => undefined,
    });
    let message = '';
    try {
      await degraded.routers.preview?.(
        'startBackend',
        { projectId: PROJECT_ID },
        { requestId: 'degraded', emit: () => undefined },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('受控进程端口');
    for (const dispose of degraded.disposers) await dispose();
  });
});

/* ------------------------------ 4. 导航 ------------------------------ */

describe('导航生产端口（跳转 / 反向跳转 / 关系图 / 数据流）', () => {
  const ELEMENT_ID = 'el-login-button';
  const PAGE_ID = 'page-login';
  const CONTROLLER = [
    '// @everyonecoding:anchor el-login-button',
    'export class LoginController {',
    '  handleLoginButton(): string {',
    "    return 'ok';",
    '  }',
    '}',
    '',
  ].join('\n');

  it('Ctrl 跳转命中锚点、反向跳转回设计器、统计与关系图有真实数据', async () => {
    // 设计器 DSL（用工厂 + 序列化生成，保证与渲染层同一份合法结构）
    const page = createEmptyPage({
      id: PAGE_ID,
      projectId: PROJECT_ID,
      name: '登录页',
      route: '/login',
    });
    page.tree.children = [
      createElement({ id: ELEMENT_ID, type: 'Button', name: '登录按钮' }),
    ];
    const envelope = serializePageDsl(page);
    // 合法性唯一判据：反序列化通过
    expect(deserializePageDsl(envelope).dsl.id).toBe(PAGE_ID);
    projectFile(`design/pages/${PAGE_ID}.dsl.json`, envelope);
    projectFile('code/src/LoginController.ts', CONTROLLER);

    const now = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO page (id, project_id, feature_id, name, route, dsl_ref, created_at, updated_at)
       VALUES (?, ?, NULL, '登录页', '/login', ?, ?, ?)`,
    ).run(PAGE_ID, PROJECT_ID, `design/pages/${PAGE_ID}.dsl.json`, now, now);
    db.prepare(
      `INSERT OR REPLACE INTO element (id, page_id, parent_id, type, name, order_index, created_at, updated_at)
       VALUES (?, ?, NULL, 'Button', '登录按钮', 0, ?, ?)`,
    ).run(ELEMENT_ID, PAGE_ID, now, now);
    db.prepare(
      `INSERT OR REPLACE INTO code_anchor (id, project_id, element_id, page_id, feature_id, file_path, symbol, start_line, end_line, kind, commit_sha, created_at, updated_at)
       VALUES ('anc-login', ?, ?, ?, NULL, 'src/LoginController.ts', 'handleLoginButton', 1, 7, 'controller', NULL, ?, ?)`,
    ).run(PROJECT_ID, ELEMENT_ID, PAGE_ID, now, now);

    const opened = await call<{ anchors: number }>({
      domain: 'nav',
      method: 'openProject',
      params: { projectId: PROJECT_ID },
    });
    expect(opened.anchors).toBe(1);

    const request = { pageId: PAGE_ID, elementId: ELEMENT_ID, elementName: '登录按钮' };
    const jump = await call<{
      targets: Array<{ id: string; kind: string; filePath: string | null; layer: number }>;
      layers: unknown[];
      preferred: { id: string } | null;
    }>({ domain: 'nav', method: 'resolveJump', params: { projectId: PROJECT_ID, request } });
    expect(jump.targets.length).toBeGreaterThan(0);
    const anchorTarget = jump.targets.find((item) => item.id === 'anchor:anc-login');
    expect(anchorTarget?.filePath).toBe('src/LoginController.ts');
    expect(jump.layers.length).toBeGreaterThan(0);
    expect(jump.preferred).not.toBeNull();

    const hover = await call<Array<{ id: string; score: number; reasons: string[] }>>({
      domain: 'nav',
      method: 'hoverTargets',
      params: { projectId: PROJECT_ID, request },
    });
    expect(hover.some((item) => item.id === 'anchor:anc-login')).toBe(true);

    const committed = await call<{ success: boolean; message: string }>({
      domain: 'nav',
      method: 'commitJump',
      params: { projectId: PROJECT_ID, target: anchorTarget },
    });
    expect(committed.success).toBe(true);
    const stats = await call<{ forward: { total: number; success: number } }>({
      domain: 'nav',
      method: 'jumpStats',
      params: { projectId: PROJECT_ID },
    });
    expect(stats.forward.total).toBe(1);
    expect(stats.forward.success).toBe(1);

    // 反向跳转：注释标记命中（第 1 行）
    const reverse = await call<{ success: boolean; hits: Array<{ elementId: string; element: { name: string } | null }> }>({
      domain: 'nav',
      method: 'reverseJump',
      params: { projectId: PROJECT_ID, input: { filePath: 'src/LoginController.ts', line: 1 } },
    });
    expect(reverse.success).toBe(true);
    expect(reverse.hits[0]?.elementId).toBe(ELEMENT_ID);
    expect(reverse.hits[0]?.element?.name).toBe('登录按钮');

    // 反向跳转：没有注释标记的行用锚点区间兜底（第 4 行落在 1..7 内）
    const fallback = await call<{ success: boolean; hits: Array<{ anchorId: string | null }> }>({
      domain: 'nav',
      method: 'reverseJump',
      params: { projectId: PROJECT_ID, input: { filePath: 'src/LoginController.ts', line: 4 } },
    });
    expect(fallback.success).toBe(true);
    expect(fallback.hits[0]?.anchorId).toBe('anc-login');

    const graph = await call<{ nodes: unknown[]; edges: unknown[] }>({
      domain: 'nav',
      method: 'relationGraph',
      params: { projectId: PROJECT_ID },
    });
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);

    const flow = await call<Array<{ kind: string; ok: boolean }>>({
      domain: 'nav',
      method: 'dataFlow',
      params: { projectId: PROJECT_ID, elementId: ELEMENT_ID },
    });
    expect(flow.map((step) => step.kind)).toEqual([
      'element',
      'event',
      'api',
      'backend',
      'writeback',
      'render',
    ]);
    // 没有预览请求日志时，接口之后的环节必须如实标为"未观测到"，不能假装成功
    expect(flow.find((step) => step.kind === 'api')?.ok).toBe(false);
  });
});

/* ------------------------------ 5. 统一重命名 ------------------------------ */

describe('统一重命名生产端口（事务 / 不误伤 / 可撤销）', () => {
  const OLD_NAME = '登录按钮';
  const NEW_NAME = '登录提交';
  const REGISTRY_ID = 'reg-element-el-login-button';
  const FILE_MAIN = [
    "import { LoginButton } from './LoginButton';",
    '',
    'export function LoginPage(): unknown {',
    '  // LoginButton 在注释里，不能被改',
    '  const LoginButton = shadow();',
    '  const loginButton = useRef(null);',
    "  const text = 'LoginButton 在字符串里，不能改';",
    '  return {',
    '    node: <LoginButton ref={loginButton} className="login-button" />',
    '  };',
    '}',
    '',
  ].join('\n');

  const runExecute = async (): Promise<{ ok: boolean; eventId: string; applied: number }> => {
    const analysis = await call<{
      groups: Array<{ level: string; items: Array<{ id: string; selected: boolean }> }>;
      totals: { total: number; selected: number };
    }>({
      domain: 'rename',
      method: 'analyze',
      params: { projectId: PROJECT_ID, registryId: REGISTRY_ID, newName: NEW_NAME },
    });
    expect(analysis.totals.total).toBeGreaterThan(0);
    // warn 区默认不勾选（FR-UNI-03）
    const warnGroup = analysis.groups.find((group) => group.level === 'warn');
    expect(warnGroup?.items.every((item) => item.selected === false) ?? true).toBe(true);

    const selection = analysis.groups
      .flatMap((group) => group.items)
      .filter((item) => item.selected)
      .map((item) => item.id);
    expect(selection.length).toBeGreaterThan(0);

    const result = await call<{ ok: boolean; event: { id: string } | null; applied: number; failures: string[] }>({
      domain: 'rename',
      method: 'execute',
      params: { projectId: PROJECT_ID, registryId: REGISTRY_ID, newName: NEW_NAME, selection },
    });
    expect(result.ok, `重命名失败：${result.failures.join('；')}`).toBe(true);
    expect(result.event).not.toBeNull();
    return { ok: result.ok, eventId: result.event?.id ?? '', applied: result.applied };
  };

  it('注册表登记后可查询；非法名被阻断并给出 3 个建议名', async () => {
    upsertRegistryEntry(db, {
      projectId: PROJECT_ID,
      entityType: 'element',
      entityId: 'el-login-button',
      canonicalName: OLD_NAME,
    });

    const targets = await call<Array<{ registryId: string; canonicalName: string; projections: Record<string, string> }>>({
      domain: 'rename',
      method: 'listTargets',
      params: { projectId: PROJECT_ID },
    });
    const target = targets.find((item) => item.registryId === REGISTRY_ID);
    expect(target?.canonicalName).toBe(OLD_NAME);
    // 八类投影都要派生出来（缺项会让冲突检测失效）
    expect(Object.keys(target?.projections ?? {}).length).toBeGreaterThanOrEqual(8);

    const bad = await call<{ ok: boolean; violations: unknown[]; suggestions: string[] }>({
      domain: 'rename',
      method: 'check',
      params: { projectId: PROJECT_ID, registryId: REGISTRY_ID, newName: '1 非法名!' },
    });
    expect(bad.ok).toBe(false);
    expect(bad.violations.length).toBeGreaterThan(0);
    expect(bad.suggestions.length).toBe(3);

    const context = await call<{ projectId: string; platform: string }>({
      domain: 'rename',
      method: 'projectContext',
      params: { projectId: PROJECT_ID },
    });
    expect(context.projectId).toBe(PROJECT_ID);
  });

  it('执行事务：代码/文档/记忆/DSL/锚点/注册表一并同步，且不误伤注释与局部变量', async () => {
    projectFile('code/src/pages/Login.tsx', FILE_MAIN);
    // 逻辑结构：DSL 里挂一个同名节点
    const page = createEmptyPage({
      id: 'page-login',
      projectId: PROJECT_ID,
      name: '登录页',
      route: '/login',
    });
    page.tree.children = [createElement({ id: 'btn-1', type: 'Button', name: OLD_NAME })];
    projectFile(`design/pages/page-login.dsl.json`, serializePageDsl(page));

    const now = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO page (id, project_id, feature_id, name, route, dsl_ref, created_at, updated_at)
       VALUES ('page-login', ?, NULL, '登录页', '/login', 'design/pages/page-login.dsl.json', ?, ?)`,
    ).run(PROJECT_ID, now, now);
    // `code_anchor.element_id` 是指向 `element` 的外键：缺行会直接 FOREIGN KEY constraint failed
    db.prepare(
      `INSERT OR REPLACE INTO element (id, page_id, parent_id, type, name, order_index, created_at, updated_at)
       VALUES ('btn-1', 'page-login', NULL, 'Button', ?, 0, ?, ?)`,
    ).run(OLD_NAME, now, now);
    db.prepare(
      `INSERT OR REPLACE INTO document (id, project_id, kind, title, content_ref, version, content_text, created_at, updated_at)
       VALUES ('doc-1', ?, 'requirement', '需求文档', NULL, 1, ?, ?, ?)`,
    ).run(PROJECT_ID, `# 用户登录\n\n点击${OLD_NAME}完成认证。\n`, now, now);
    db.prepare(
      `INSERT OR REPLACE INTO memory_item (id, user_id, scope, project_id, title, content, structured, source_type, created_at, updated_at)
       VALUES ('mem-1', ?, 'page', ?, '登录页记忆', ?, NULL, 'manual', ?, ?)`,
    ).run(USER_ID, PROJECT_ID, `登录页的主操作是点击${OLD_NAME}提交表单。`, now, now);
    db.prepare(
      `INSERT OR REPLACE INTO code_anchor (id, project_id, element_id, page_id, feature_id, file_path, symbol, start_line, end_line, kind, commit_sha, created_at, updated_at)
       VALUES ('anc-login-2', ?, 'btn-1', 'page-login', NULL, 'src/pages/Login.tsx', ?, 1, 11, 'dto', NULL, ?, ?)`,
    ).run(PROJECT_ID, target_component_of(OLD_NAME), now, now);

    const diff = await call<{
      columns: Array<{ column: string; entries: unknown[] }>;
      summary: { total: number; selected: number; inspectText: string };
      scopeNotice: string;
    }>({
      domain: 'rename',
      method: 'buildDiff',
      params: { projectId: PROJECT_ID, registryId: REGISTRY_ID, newName: NEW_NAME },
    });
    expect(diff.columns.map((column) => column.column)).toEqual(['code', 'doc', 'memory', 'logic']);
    expect(diff.summary.total).toBeGreaterThan(0);
    // D-07：面板必须明确"仅限本项目生效"，且不含跨项目条目
    expect(diff.scopeNotice).toContain('不修改长期记忆');

    const executed = await runExecute();
    expect(executed.applied).toBeGreaterThan(0);

    // 代码：组件名与变量名被改，注释 / 局部变量 / 字符串字面量原样保留（E2E-16）
    const code = readProjectFile('code/src/pages/Login.tsx');
    expect(code).toContain('LoginSubmit');
    expect(code).toContain('// LoginButton 在注释里，不能被改');
    expect(code).toContain('const LoginButton = shadow();');
    expect(code).toContain("'LoginButton 在字符串里，不能改'");

    // 文档与记忆正文同步
    const doc = db.prepare(`SELECT content_text FROM document WHERE id = 'doc-1'`).get() as {
      content_text: string;
    };
    expect(doc.content_text).toContain(NEW_NAME);
    expect(doc.content_text).not.toContain(OLD_NAME);
    const memory = db.prepare(`SELECT content FROM memory_item WHERE id = 'mem-1'`).get() as {
      content: string;
    };
    expect(memory.content).toContain(NEW_NAME);

    // DSL 节点名同步
    const dsl = JSON.parse(readProjectFile('design/pages/page-login.dsl.json')) as {
      page: { tree: { children: Array<{ name?: string }> } };
    };
    expect(dsl.page.tree.children[0]?.name).toBe(NEW_NAME);

    // 注册表规范名同步
    const entry = db
      .prepare(`SELECT canonical_name FROM registry_entry WHERE id = ?`)
      .get(REGISTRY_ID) as { canonical_name: string };
    expect(entry.canonical_name).toBe(NEW_NAME);

    // 重命名事件落库（含变更集，供撤销）
    const event = db
      .prepare(`SELECT changeset_json, undone FROM rename_event WHERE id = ?`)
      .get(executed.eventId) as { changeset_json: string | null; undone: number };
    expect(event.changeset_json).not.toBeNull();
    expect(event.undone).toBe(0);

    const history = await call<Array<{ eventId: string; oldName: string; newName: string }>>({
      domain: 'rename',
      method: 'history',
      params: { projectId: PROJECT_ID },
    });
    expect(history[0]?.oldName).toBe(OLD_NAME);
    expect(history[0]?.newName).toBe(NEW_NAME);

    // 一键撤销：代码 / 文档 / 记忆 / DSL / 注册表全部还原（E2E-17）
    const undo = await call<{ ok: boolean; restored: string[]; failures: string[] }>({
      domain: 'rename',
      method: 'undo',
      params: { projectId: PROJECT_ID, eventId: executed.eventId },
    });
    expect(undo.ok, `撤销失败：${undo.failures.join('；')}`).toBe(true);
    expect(readProjectFile('code/src/pages/Login.tsx')).toBe(FILE_MAIN);
    const docAfter = db.prepare(`SELECT content_text FROM document WHERE id = 'doc-1'`).get() as {
      content_text: string;
    };
    expect(docAfter.content_text).toContain(OLD_NAME);
    const entryAfter = db
      .prepare(`SELECT canonical_name FROM registry_entry WHERE id = ?`)
      .get(REGISTRY_ID) as { canonical_name: string };
    expect(entryAfter.canonical_name).toBe(OLD_NAME);

    // 重复撤销被拒（破坏性操作不能"撤销两次"）
    const again = await call<{ ok: boolean; failures: string[] }>({
      domain: 'rename',
      method: 'undo',
      params: { projectId: PROJECT_ID, eventId: executed.eventId },
    });
    expect(again.ok).toBe(false);
    expect(again.failures.join('')).toContain('已撤销');
  }, 120_000);

  it('批量计划与规范化：diff 预览齐备，无漂移时为无操作', async () => {
    const plan = await call<{ batchId: string; steps: unknown[]; blocked: unknown[]; scopeNotice: string }>({
      domain: 'rename',
      method: 'planBatch',
      params: { projectId: PROJECT_ID, normalize: true },
    });
    expect(plan.batchId.length).toBeGreaterThan(0);
    expect(plan.blocked).toEqual([]);
    // D-07：面板必须明确"仅限本项目生效"
    expect(plan.scopeNotice).toContain('仅限当前项目');

    const run = await call<{ ok: boolean; batchId: string }>({
      domain: 'rename',
      method: 'runBatch',
      params: { projectId: PROJECT_ID, batchId: plan.batchId },
    });
    expect(run.ok).toBe(true);
    // 过期/不存在的批量计划必须被拒，而不是静默 no-op
    const missing = await invoke({
      domain: 'rename',
      method: 'runBatch',
      params: { projectId: PROJECT_ID, batchId: 'not-exist' },
    });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe('NOT_FOUND');

    expect(
      await call<unknown[]>({ domain: 'rename', method: 'pendingCleanup', params: { projectId: PROJECT_ID } }),
    ).toEqual([]);
    expect(
      await call<number>({
        domain: 'rename',
        method: 'cleanAliases',
        params: { projectId: PROJECT_ID, items: [] },
      }),
    ).toBe(0);
  });

  it('数据库迁移：未配置数据源时如实拒绝执行并给出引导（D-08 默认不执行）', async () => {
    const plan = await call<{ error?: string; guidance?: string; migrationId?: string }>({
      domain: 'rename',
      method: 'planMigration',
      params: {
        projectId: PROJECT_ID,
        table: 'users',
        oldColumn: 'user_name',
        newColumn: 'display_name',
        dialect: 'sqlite',
      },
    });
    // AI 栈未装配：如实返回错误与引导，绝不用内置模板顶替
    expect(plan.error).toBeTruthy();
    expect(plan.guidance).toContain('设置');

    const run = await invoke({
      domain: 'rename',
      method: 'runMigration',
      params: { projectId: PROJECT_ID, migrationId: 'whatever', confirmed: true },
    });
    expect(run.ok).toBe(false);
    expect(run.error?.code).toBe('NOT_FOUND');
  });
});

/* ------------------------------ 辅助 ------------------------------ */

/** 与注册表命名规则一致地算出组件投影（测试断言锚点符号用） */
function target_component_of(canonicalName: string): string {
  return canonicalName === '登录按钮' ? 'LoginButton' : canonicalName;
}

/* ------------------------------ 6. Git 凭据 ------------------------------ */

describe('Git 生产端口（凭据 / 自动提交策略 / 破坏性操作拦截）', () => {
  it('DPAPI 不可用时凭据方法如实报 NOT_SUPPORTED，不降级明文', async () => {
    await expectCode(
      { domain: 'git', method: 'credentialBindings', params: { projectId: PROJECT_ID } },
      'NOT_SUPPORTED',
    );
    await expectCode(
      {
        domain: 'git',
        method: 'saveHttpsCredential',
        params: { projectId: PROJECT_ID, input: { remoteName: 'origin', token: 'sk-should-not-leak' } },
      },
      'NOT_SUPPORTED',
    );
  });

  it('自动提交策略走真实 setting 表（此前因列名写错会直接抛 SQL 错）', async () => {
    const initial = await call<{ trigger: string }>({
      domain: 'git',
      method: 'autoCommitPolicy',
      params: { projectId: PROJECT_ID },
    });
    expect(initial.trigger).toBe('off');

    await call({
      domain: 'git',
      method: 'setAutoCommitPolicy',
      params: { projectId: PROJECT_ID, policy: { trigger: 'per-stage', conventional: 'angular' } },
    });
    const updated = await call<{ trigger: string }>({
      domain: 'git',
      method: 'autoCommitPolicy',
      params: { projectId: PROJECT_ID },
    });
    expect(updated.trigger).toBe('per-stage');
    expect(
      db
        .prepare(`SELECT value_json FROM setting WHERE user_id = ? AND key = 'git_auto_commit_policy'`)
        .get(USER_ID),
    ).toBeTruthy();
  });
});
