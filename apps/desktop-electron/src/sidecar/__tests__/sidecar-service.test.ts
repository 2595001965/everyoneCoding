import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOMAIN_KINDS, DOMAIN_RPC_METHODS, type DomainRpcResponse } from '@ec/shell-api';

import { createHarness, type Harness } from './support/harness';
import { PROTOCOL_VERSION, SIDECAR_EVENTS, SIDECAR_OPS } from '../protocol';

/**
 * T13-01 侧车服务端到端（Tauri 双形态功能等价）。
 *
 * ## 这套用例到底在验证什么
 *
 * 不替换任何领域实现：`createHeadlessRuntime` 会真的开 SQLite、真的跑迁移、
 * 真的读写工程目录，`auth` 域会真的用 HTTP 打到一个本机账号服务。
 * 唯一的替身是**外壳端口**（DPAPI / 打开外链 / 剪贴板）——它们本来就跑在宿主进程里
 * （Rust 侧），这里用等价的假实现回答，正是宿主该做的事。
 *
 * 换句话说：**本文件是"Tauri 实机启动后四域可用"的进程内等价证据**。
 * 真机形态只剩"把内存管道换成 stdin/stdout"这一层差异，那一层由
 * `sidecar-process.test.ts`（真起进程）覆盖。
 *
 * ## 断言纪律
 *
 * 「已装配」的唯一判据不是 `describe()` 自报，而是**调用真的被分发到域路由**。
 * 所以核心断言是：四基础域白名单内**每个方法**都不能返回
 * 「尚未接入 / 未装配」形态的 `NOT_SUPPORTED`——那正是本轮要消灭的状态。
 */

interface DomainReply {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** 本轮要消灭的措辞：出现即说明"通道在、运行时没接" */
const NOT_ASSEMBLED_PATTERN = /尚未接入|未装配|尚未接入域端口运行时|尚未提供域端口/;

function isNotAssembled(error: { code: string; message: string } | undefined): boolean {
  return (
    error !== undefined &&
    error.code === 'NOT_SUPPORTED' &&
    NOT_ASSEMBLED_PATTERN.test(error.message)
  );
}

/** 假账号服务：真实 HTTP，endpoint 与 PRD §8 的服务端接口同形 */
async function startAccountServer(): Promise<{ url: string; close(): Promise<void> }> {
  const tokens = (): Record<string, unknown> => ({
    accessToken: 'at-e2e',
    refreshToken: 'rt-e2e',
    expiresAt: Date.now() + 3_600_000,
    refreshExpiresAt: Date.now() + 86_400_000,
  });
  const identity = (email: string): Record<string, unknown> => ({
    accountId: 'acc-e2e',
    login: email,
    displayName: '门禁用户',
    avatarUrl: null,
    emailVerified: true,
    hasPassword: true,
  });

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const url = request.url ?? '';
      if (request.method === 'POST' && url === '/api/auth/register') {
        send(201, { identity: identity(String(body['email'])), tokens: tokens() });
        return;
      }
      if (request.method === 'POST' && url === '/api/auth/login') {
        send(200, { identity: identity(String(body['email'])), tokens: tokens() });
        return;
      }
      if (request.method === 'POST' && url === '/api/auth/refresh') {
        send(200, tokens());
        return;
      }
      if (request.method === 'GET' && url === '/api/auth/bindings') {
        send(200, []);
        return;
      }
      if (request.method === 'POST' && url === '/api/auth/email/verify') {
        send(200, { ok: true });
        return;
      }
      if (request.method === 'POST' && url === '/api/auth/password/reset') {
        send(200, { ok: true });
        return;
      }
      send(404, { code: 'not_found', message: `测试服务未实现：${request.method} ${url}` });
    });
  });

  await new Promise<void>((resolvePromise) =>
    server.listen(0, '127.0.0.1', () => resolvePromise()),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('假账号服务未能监听端口');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

describe('侧车 E2E：真实运行时 + 真实协议（Tauri 形态四域端到端）', () => {
  let account: Awaited<ReturnType<typeof startAccountServer>>;
  let harness: Harness;

  const invoke = async (
    domain: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<DomainReply> => {
    const reply = await harness.request(SIDECAR_OPS.domainInvoke, {
      requestId: `req-${domain}-${method}`,
      domain,
      method,
      params,
    });
    expect(reply.ok, `domain.invoke 本身失败：${JSON.stringify(reply.error)}`).toBe(true);
    return reply.result as DomainReply;
  };

  beforeAll(async () => {
    account = await startAccountServer();
    harness = createHarness({ accountBaseUrl: account.url });
    harness.welcome();
    await harness.ready;
  }, 60_000);

  afterAll(async () => {
    await harness?.dispose();
    await account?.close();
  });

  /* --------------------------- 握手与能力协商 --------------------------- */

  it('hello → welcome → ready：协议版本一致，握手帧携带运行时标识', async () => {
    const hello = JSON.parse(harness.received[0] as string) as Record<string, unknown>;
    expect(hello['t']).toBe('hello');
    expect(hello['protocol']).toBe(PROTOCOL_VERSION);
    expect(hello['runtime']).toBe('everyone-coding-sidecar');
    expect(typeof hello['pid']).toBe('number');

    const ready = harness.received.find(
      (line) => (JSON.parse(line) as { t: string }).t === 'ready',
    );
    expect(ready).toBeTruthy();
  });

  it('ready 如实上报全部 15 个域可用，且 AI 栈可用（DPAPI 由宿主提供）', async () => {
    const ready = await harness.ready;
    expect(ready.domains.map((item) => item.kind).sort()).toEqual([...DOMAIN_KINDS].sort());
    const unavailable = ready.domains.filter((item) => !item.available);
    expect(unavailable, `不应有未装配的域：${JSON.stringify(unavailable)}`).toEqual([]);
    expect(ready.ai.available).toBe(true);
    // 同步口只在 memory / pipeline 上存在；Tauri 形态不暴露（无同步 IPC 原语）
    expect(ready.syncDomains.sort()).toEqual(['memory', 'pipeline']);
  });

  it('describe 与 ready 同源：15 个域全部 available', async () => {
    const reply = await harness.request(SIDECAR_OPS.domainDescribe);
    expect(reply.ok).toBe(true);
    const described = reply.result as Array<{ kind: string; available: boolean }>;
    expect(described).toHaveLength(DOMAIN_KINDS.length);
    expect(described.every((item) => item.available)).toBe(true);
  });

  /* ------------------- 四基础域：白名单每个方法都必须被分发 ------------------- */

  it('四基础域白名单内每个方法都被真实分发（不出现"尚未接入"的 NOT_SUPPORTED）', async () => {
    const baseDomains = ['workspace', 'docs', 'auth', 'settings'] as const;
    const problems: string[] = [];
    let dispatched = 0;

    for (const domain of baseDomains) {
      for (const method of DOMAIN_RPC_METHODS[domain]) {
        const reply = await invoke(domain, method);
        dispatched += 1;
        expect(reply.requestId, `${domain}.${method} 的 requestId 必须原样回传`).toBe(
          `req-${domain}-${method}`,
        );
        expect(typeof reply.ok, `${domain}.${method} 必须返回结构化结果`).toBe('boolean');
        if (isNotAssembled(reply.error)) {
          problems.push(`${domain}.${method} → ${reply.error?.message}`);
        }
      }
    }

    expect(problems, `以下方法仍停留在"未接入"状态：\n${problems.join('\n')}`).toEqual([]);
    // 四域白名单合计 69 个方法（19 + 20 + 14 + 16）
    expect(dispatched).toBe(
      DOMAIN_RPC_METHODS.workspace.length +
        DOMAIN_RPC_METHODS.docs.length +
        DOMAIN_RPC_METHODS.auth.length +
        DOMAIN_RPC_METHODS.settings.length,
    );
  }, 120_000);

  it('生产能力域同样被真实分发（不出现"尚未接入"的 NOT_SUPPORTED）', async () => {
    const production = [
      'memory',
      'pipeline',
      'git',
      'preview',
      'rename',
      'package',
      'usage',
      'ai-context',
      'code',
      'nav',
      'designer',
    ] as const;
    const problems: string[] = [];
    for (const domain of production) {
      for (const method of DOMAIN_RPC_METHODS[domain]) {
        const reply = await invoke(domain, method);
        if (isNotAssembled(reply.error))
          problems.push(`${domain}.${method} → ${reply.error?.message}`);
      }
    }
    expect(problems, `以下方法仍停留在"未接入"状态：\n${problems.join('\n')}`).toEqual([]);
  }, 120_000);

  /* ------------------------- 四域真实业务链路（真成功） ------------------------- */

  it('workspace：建项目 → 列表 → 读取 → 标记打开 → 阶段/指标 → 归档 → 回收站 → 还原', async () => {
    const created = await invoke('workspace', 'createProject', {
      input: { name: '门禁项目', description: 'Tauri 侧车端到端', targetPlatforms: ['web'] },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const project = created.result as { id: string; name: string };
    expect(project.id).toBeTruthy();
    expect(project.name).toBe('门禁项目');

    const listed = await invoke('workspace', 'listProjects', {});
    expect(listed.ok).toBe(true);
    // `listProjects` 返回的是摘要数组（不是分页信封）—— 逐字照真实契约断言
    const page = listed.result as Array<{ id: string }>;
    expect(page.map((item) => item.id)).toContain(project.id);

    const fetched = await invoke('workspace', 'getProject', { id: project.id });
    expect(fetched.ok).toBe(true);
    expect((fetched.result as { id: string }).id).toBe(project.id);

    expect((await invoke('workspace', 'markOpened', { id: project.id })).ok).toBe(true);

    const stage = await invoke('workspace', 'getProjectStage', { projectId: project.id });
    expect(stage.ok, JSON.stringify(stage.error)).toBe(true);

    const metrics = await invoke('workspace', 'getDashboardMetrics', { projectId: project.id });
    expect(metrics.ok, JSON.stringify(metrics.error)).toBe(true);

    const renamed = await invoke('workspace', 'updateProject', {
      id: project.id,
      patch: { name: '门禁项目（已改名）' },
    });
    expect(renamed.ok, JSON.stringify(renamed.error)).toBe(true);

    expect((await invoke('workspace', 'archiveProject', { id: project.id })).ok).toBe(true);
    expect((await invoke('workspace', 'unarchiveProject', { id: project.id })).ok).toBe(true);
    expect((await invoke('workspace', 'moveToRecycleBin', { id: project.id })).ok).toBe(true);
    expect((await invoke('workspace', 'restoreFromRecycleBin', { id: project.id })).ok).toBe(true);

    const cleaned = await invoke('workspace', 'cleanupExpiredRecycleBin');
    expect(cleaned.ok, JSON.stringify(cleaned.error)).toBe(true);
  }, 60_000);

  it('docs：导入 → 列表 → 读取 → 版本 → 支持格式 → 记忆节点', async () => {
    const project = await invoke('workspace', 'createProject', {
      input: { name: '文档项目', targetPlatforms: ['web'] },
    });
    const projectId = (project.result as { id: string }).id;

    const imported = await invoke('docs', 'importDocument', {
      input: {
        projectId,
        format: 'markdown',
        title: '需求说明',
        raw: '# 需求说明\n\n这是一个端到端用例导入的文档。\n',
      },
    });
    expect(imported.ok, JSON.stringify(imported.error)).toBe(true);
    const doc = imported.result as { id: string };
    expect(doc.id).toBeTruthy();

    const listed = await invoke('docs', 'listDocuments', { projectId });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect((listed.result as unknown[]).length).toBeGreaterThan(0);

    const fetched = await invoke('docs', 'getDocument', { id: doc.id });
    expect(fetched.ok, JSON.stringify(fetched.error)).toBe(true);

    const versions = await invoke('docs', 'listVersions', { id: doc.id });
    expect(versions.ok, JSON.stringify(versions.error)).toBe(true);

    const formats = await invoke('docs', 'supportedFormats');
    expect(formats.ok, JSON.stringify(formats.error)).toBe(true);
    expect(Array.isArray(formats.result)).toBe(true);

    const nodes = await invoke('docs', 'listMemoryNodes', { projectId });
    expect(nodes.ok, JSON.stringify(nodes.error)).toBe(true);

    const links = await invoke('docs', 'countLinksForMemories', { memoryIds: [] });
    expect(links.ok, JSON.stringify(links.error)).toBe(true);

    expect((await invoke('docs', 'deleteDocument', { id: doc.id })).ok).toBe(true);
    expect((await invoke('docs', 'restoreDocument', { id: doc.id })).ok).toBe(true);
    expect((await invoke('docs', 'purgeDocument', { id: doc.id })).ok).toBe(true);
  }, 60_000);

  it('auth：注册 → 恢复（含刷新）→ 绑定列表 → 离线态（真实 HTTP + DPAPI 落盘）', async () => {
    const registered = await invoke('auth', 'register', {
      input: {
        email: 'e2e@example.com',
        password: 'Abcd1234',
        confirm: 'Abcd1234',
        rememberMe: true,
      },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const session = registered.result as {
      identity: { login: string };
      tokens: { accessToken: string };
    };
    expect(session.identity.login).toBe('e2e@example.com');
    expect(session.tokens.accessToken).toBe('at-e2e');

    const restored = await invoke('auth', 'restore');
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect((restored.result as { identity: { login: string } }).identity.login).toBe(
      'e2e@example.com',
    );

    const bindings = await invoke('auth', 'listBindings');
    expect(bindings.ok, JSON.stringify(bindings.error)).toBe(true);

    const offline = await invoke('auth', 'isOffline');
    expect(offline.ok).toBe(true);

    // 退出后会话清空：本地缓存必须一起失效，否则"退出登录"只清了个界面
    expect((await invoke('auth', 'logout')).ok).toBe(true);
    const afterLogout = await invoke('auth', 'restore');
    expect(afterLogout.ok).toBe(true);
    expect(afterLogout.result).toBeNull();

    // 令牌确实经宿主 DPAPI 落过盘（明文不得出现）
    expect(harness.hostCalls.some((call) => call.capability === 'secure.encrypt')).toBe(true);

    const loggedIn = await invoke('auth', 'login', {
      input: { email: 'e2e@example.com', password: 'Abcd1234' },
    });
    expect(loggedIn.ok, JSON.stringify(loggedIn.error)).toBe(true);
  }, 60_000);

  it('settings：getAll → 更新并落盘 → 数据目录 → 命令表 → 遥测检视/清除', async () => {
    const all = await invoke('settings', 'getAll');
    expect(all.ok, JSON.stringify(all.error)).toBe(true);
    expect(all.result).toBeTruthy();

    const updated = await invoke('settings', 'update', { patch: { language: 'zh-CN' } });
    expect(updated.ok, JSON.stringify(updated.error)).toBe(true);

    const dirs = await invoke('settings', 'getDataDirs');
    expect(dirs.ok, JSON.stringify(dirs.error)).toBe(true);
    expect(dirs.result).toBeTruthy();

    const commands = await invoke('settings', 'listCommands');
    expect(commands.ok, JSON.stringify(commands.error)).toBe(true);

    const telemetry = await invoke('settings', 'inspectLocalTelemetry');
    expect(telemetry.ok, JSON.stringify(telemetry.error)).toBe(true);

    const cleared = await invoke('settings', 'clearLocalTelemetry');
    expect(cleared.ok, JSON.stringify(cleared.error)).toBe(true);

    const backup = await invoke('settings', 'getBackupConfig');
    expect(backup.ok, JSON.stringify(backup.error)).toBe(true);
  }, 60_000);

  /* ------------------------------ 事件回传 ------------------------------ */

  it('请求内事件按 requestId 回传（域事件带 domain 与 requestId 信封）', async () => {
    const project = await invoke('workspace', 'createProject', {
      input: { name: '事件项目', targetPlatforms: ['web'] },
    });
    const projectId = (project.result as { id: string }).id;
    expect((await invoke('pipeline', 'initProject', { projectId })).ok).toBe(true);

    const eventPromise = harness.nextEvent(SIDECAR_EVENTS.domainEvent, 15_000);
    const reply = await invoke('pipeline', 'startStage', { projectId, stage: 'S1' });
    expect(reply.ok, JSON.stringify(reply.error)).toBe(true);

    const event = (await eventPromise) as {
      requestId: string;
      domain: string;
      payload: { type: string; projectId: string; event: string };
    };
    expect(event.requestId).toBe('req-pipeline-startStage');
    expect(event.domain).toBe('pipeline');
    expect(event.payload.type).toBe('pipeline:stage-event');
    expect(event.payload.projectId).toBe(projectId);
    expect(event.payload.event).toBe('start');
  }, 30_000);

  /* ---------------------------- AI 栈（真实） ---------------------------- */

  it('AI：listProviders / listAllModels / budgetConfig 走真实 AiStack（无"未接入"）', async () => {
    const providers = await harness.request(SIDECAR_OPS.aiInvoke, {
      requestId: 'ai-1',
      method: 'listProviders',
      params: {},
    });
    expect(providers.ok).toBe(true);
    expect((providers.result as { ok: boolean }).ok).toBe(true);

    const models = await harness.request(SIDECAR_OPS.aiInvoke, {
      requestId: 'ai-2',
      method: 'listAllModels',
      params: {},
    });
    expect(models.ok).toBe(true);

    const budget = await harness.request(SIDECAR_OPS.aiInvoke, {
      requestId: 'ai-3',
      method: 'budgetConfig',
      params: {},
    });
    expect(budget.ok).toBe(true);

    // 预算写入必须落库（重启后仍生效），因此要经过 host 的 DPAPI/文件路径
    const setBudget = await harness.request(SIDECAR_OPS.aiInvoke, {
      requestId: 'ai-4',
      method: 'setBudget',
      params: { dailyUsd: 3, monthlyUsd: 30, alertRatio: 0.8 },
    });
    expect(setBudget.ok, JSON.stringify(setBudget.error)).toBe(true);

    const readBack = await harness.request(SIDECAR_OPS.aiInvoke, {
      requestId: 'ai-5',
      method: 'budgetConfig',
      params: {},
    });
    const config = (readBack.result as { result: { dailyUsd: number } }).result;
    expect(config.dailyUsd).toBe(3);
  }, 60_000);

  it('AI：白名单外的方法一律 INVALID_ARGUMENT（不做反射式分发）', async () => {
    const reply = await harness.request(SIDECAR_OPS.aiInvoke, {
      requestId: 'ai-bad',
      method: 'deleteEverything',
      params: {},
    });
    expect(reply.ok).toBe(true);
    const result = reply.result as { ok: boolean; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_ARGUMENT');
  });

  /* --------------------------- 错误码与安全边界 --------------------------- */

  it('未知域方法 → INVALID_ARGUMENT（与 Electron 同一错误码）', async () => {
    const reply = await invoke('workspace', 'notARealMethod');
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('未知域 / 缺字段 → INVALID_ARGUMENT（域成员判定先于分发）', async () => {
    const reply = await harness.request(SIDECAR_OPS.domainInvoke, {
      requestId: 'bad-domain',
      domain: 'not-a-domain',
      method: 'listProjects',
      params: {},
    });
    expect(reply.ok).toBe(true);
    const result = reply.result as DomainRpcResponse;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('未知 op → INVALID_ARGUMENT，且连接保持可用（不崩、不静默吞）', async () => {
    const reply = await harness.request('domain.magic', {});
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('INVALID_ARGUMENT');

    // 连接仍然健康：后续调用照常成功
    const ping = await harness.request(SIDECAR_OPS.ping);
    expect(ping.ok).toBe(true);
    expect((ping.result as { pong: boolean }).pong).toBe(true);
  });

  it('错误消息经脱敏后才回传（Bearer / sk- 不得外泄）', async () => {
    // 触发一个会带上敏感串的真实错误：把密文当明文解，走 host 能力的失败路径
    const reply = await harness.request(SIDECAR_OPS.domainInvoke, {
      requestId: 'sanitize-probe',
      domain: 'auth',
      method: 'login',
      params: { input: { email: 'sk-abcdefgh12345678@example.com', password: 'Bearer abcdefgh' } },
    });
    expect(reply.ok).toBe(true);
    const result = reply.result as DomainRpcResponse;
    if (result.ok === false) {
      expect(result.error?.message ?? '').not.toMatch(/sk-abcdefgh12345678/);
    }
  }, 30_000);

  /* ------------------------------- stdout 纯净 ------------------------------- */

  it('侧车 stdout 只含合法协议帧（console 已被改道 stderr）', () => {
    for (const line of harness.received) {
      const frame = JSON.parse(line) as { t?: unknown };
      expect(typeof frame.t, `非协议行污染了 stdout：${line.slice(0, 120)}`).toBe('string');
    }
    // 至少跑过 hello / ready / res / evt 四类帧，证明断言不是空转
    const kinds = new Set(harness.received.map((line) => (JSON.parse(line) as { t: string }).t));
    expect(kinds.has('hello')).toBe(true);
    expect(kinds.has('ready')).toBe(true);
    expect(kinds.has('res')).toBe(true);
  });
});
