import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import type {
  AiControlServiceHost,
  AiStreamEvent,
  DomainControlServiceHost,
  DomainEvent,
} from '@ec/shell-api';

import { createElectronAiRuntime } from '../ai/runtime';
import { refreshRemoteConfigOnBoot } from '../ai/boot-refresh';
import { createHeadlessRuntime, type HeadlessRuntime } from '../runtime/bootstrap';

/**
 * T12-08 AI 主链路集成测试。
 *
 * 全部走真实装配（SQLite 迁移、AI 栈、域工厂、Node HTTP 传输），唯一的替身是：
 * - DPAPI 原语（等价的可逆假实现）；
 * - 模型中转 / 远程配置源：本机 HTTP mock，**从不连外网**。
 *
 * 测试 Key 一律是明显伪造的字符串（不是任何真实服务签发的 Key）。
 */

const FAKE_KEY = 'test-only-fake-relay-key-0001-not-real';
const FAKE_KEY_2 = 'test-only-fake-relay-key-0002-not-real';
const MIGRATIONS = join(process.cwd(), '..', '..', 'packages', 'data', 'migrations');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''),
  };
}

const root = mkdtempSync(join(tmpdir(), 'ec-ai-mainline-'));
let dirSeq = 0;
function freshDirs(): { dataDir: string; secureDir: string; workspace: string; cacheDir: string } {
  dirSeq += 1;
  const base = join(root, `case-${dirSeq}`);
  return {
    dataDir: join(base, 'data'),
    secureDir: join(base, 'secure'),
    workspace: join(base, 'workspace'),
    cacheDir: join(base, 'cache'),
  };
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------ mock 服务 ------------------------------ */

interface MockHandle {
  url: string;
  requests: Array<{
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
  }>;
  close(): Promise<void>;
}

type Responder = (
  req: { method: string; url: string; body: string; headers: IncomingMessage['headers'] },
  res: ServerResponse,
) => void;

async function startMock(respond: Responder): Promise<MockHandle> {
  const requests: MockHandle['requests'] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(entry);
      respond(entry, res);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const PAGE_JSON = {
  id: 'page-login',
  name: '登录页',
  route: '/login',
  platform: 'web',
  tree: { id: 'root', type: 'Container', props: {}, children: [] },
  states: [],
  events: [],
};

const CODE_OUTPUT = {
  files: [
    {
      path: 'src/health.ts',
      content: 'export function health(): string {\n  return "ok";\n}\n',
      action: 'create',
      language: 'ts',
    },
  ],
  anchors: [],
  summary: '新增健康检查接口',
  notes: '',
  decision: { referencedMemory: [], rationale: '最小实现', risks: [], uncovered: [] },
};

function sseOpenAi(res: ServerResponse, pieces: string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const piece of pieces) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  res.write(
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
}

/** OpenAI 兼容中转：按请求内容返回对话 / 页面 DSL（带围栏）/ 代码输出契约 */
function openAiRelay(expectedKey: string): Responder {
  return (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${expectedKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid key' } }));
      return;
    }
    if (req.method === 'GET' && req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'relay-model' }, { id: 'relay-model-mini' }] }));
      return;
    }
    const body = JSON.parse(req.body || '{}') as {
      stream?: boolean;
      messages?: Array<{ content?: unknown }>;
    };
    const text = JSON.stringify(body.messages ?? []);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
      return;
    }
    if (text.includes('界面生成器')) {
      const fenced = `好的，页面如下：\n\`\`\`json\n${JSON.stringify(PAGE_JSON)}\n\`\`\``;
      sseOpenAi(res, [fenced.slice(0, 20), fenced.slice(20)]);
      return;
    }
    if (text.includes('CODEGEN')) {
      const json = JSON.stringify(CODE_OUTPUT);
      sseOpenAi(res, [json.slice(0, 30), json.slice(30)]);
      return;
    }
    sseOpenAi(res, ['你', '好']);
  };
}

/** Anthropic 兼容中转：/v1/models + /v1/messages SSE */
function anthropicRelay(expectedKey: string): Responder {
  return (req, res) => {
    if (req.headers['x-api-key'] !== expectedKey) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message: 'invalid x-api-key' } }));
      return;
    }
    if (req.method === 'GET' && req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-relay' }] }));
      return;
    }
    const body = JSON.parse(req.body || '{}') as { stream?: boolean };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
    );
    res.write(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    );
    for (const piece of ['来自', 'Anthropic']) {
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: piece },
        })}\n\n`,
      );
    }
    res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
    res.write(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
    );
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  };
}

/* ------------------------------ 辅助 ------------------------------ */

let seq = 0;
async function call<T>(ai: AiControlServiceHost, method: string, params: unknown = {}): Promise<T> {
  seq += 1;
  const response = await ai.invoke({ requestId: `t-${seq}`, method: method as never, params });
  if (!response.ok) throw new Error(`${method} 失败：${response.error?.message ?? ''}`);
  return response.result as T;
}

async function streamText(
  ai: AiControlServiceHost,
  purpose: string,
  prompt = '你好',
): Promise<{ text: string; errors: string[]; done: AiStreamEvent | null }> {
  seq += 1;
  let text = '';
  const errors: string[] = [];
  let done: AiStreamEvent | null = null;
  await new Promise<void>((resolve) => {
    ai.stream(
      { requestId: `s-${seq}`, purpose, messages: [{ role: 'user', content: prompt }] },
      (event) => {
        if (event.type === 'chunk' && event.payload.type === 'delta') {
          text += String(event.payload['text'] ?? '');
        } else if (event.type === 'error') {
          errors.push(event.error.message);
        } else if (event.type === 'done') {
          done = event;
          resolve();
        }
      },
    );
  });
  return { text, errors, done };
}

async function addProvider(
  ai: AiControlServiceHost,
  input: {
    name: string;
    protocol: 'openai' | 'anthropic';
    baseUrl: string;
    apiKey: string;
    order?: number;
  },
): Promise<{ id: string }> {
  const keyRef = await call<string>(ai, 'persistApiKey', { apiKey: input.apiKey });
  return call<{ id: string }>(ai, 'createProvider', {
    name: input.name,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    headers: {},
    timeoutMs: 5_000,
    keyRef,
    ...(input.order !== undefined ? { order: input.order } : {}),
  });
}

async function domainCall<T>(
  runtime: HeadlessRuntime,
  domain: string,
  method: string,
  params: Record<string, unknown>,
  onEvent?: (event: DomainEvent) => void,
): Promise<T> {
  seq += 1;
  const requestId = `d-${seq}`;
  const host = runtime.domain as DomainControlServiceHost;
  if (onEvent) host.events.register(requestId, onEvent);
  try {
    const response = await host.invoke({ requestId, domain: domain as never, method, params });
    if (!response.ok) throw new Error(response.error?.message ?? `${domain}.${method} 失败`);
    return response.result as T;
  } finally {
    if (onEvent) host.events.unregister(requestId);
  }
}

async function headless(dirs = freshDirs()): Promise<HeadlessRuntime> {
  return createHeadlessRuntime({
    dataDir: dirs.dataDir,
    cacheDir: dirs.cacheDir,
    defaultWorkspaceRoot: dirs.workspace,
    secureDir: dirs.secureDir,
    safeStorage: fakeSafeStorage(),
    migrationsDir: MIGRATIONS,
    userId: 'local-user',
    ports: {
      openExternal: async () => undefined,
      writeClipboard: () => undefined,
    },
  });
}

/* ------------------------------ 用例 ------------------------------ */

describe('T12-08 模型生成主链路（OpenAI / Anthropic 兼容中转）', () => {
  it('OpenAI 兼容：连接测试 + 模型列表 + 流式对话 + 结构化页面生成 + 代码生成，全部走同一网关', async () => {
    const relay = await startMock(openAiRelay(FAKE_KEY));
    const dirs = freshDirs();
    const runtime = await headless(dirs);
    try {
      const ai = runtime.ai as AiControlServiceHost;
      expect(ai).not.toBeNull();

      const provider = await addProvider(ai, {
        name: 'OpenAI 中转',
        protocol: 'openai',
        baseUrl: relay.url,
        apiKey: FAKE_KEY,
      });
      const tested = await call<{ ok: boolean }>(ai, 'testConnection', { providerId: provider.id });
      expect(tested.ok).toBe(true);
      const models = await call<Array<{ name: string }>>(ai, 'refreshModels', {
        providerId: provider.id,
      });
      expect(models.map((model) => model.name)).toEqual(
        expect.arrayContaining(['relay-model', 'relay-model-mini']),
      );
      const readiness = await call<{ ready: boolean }>(ai, 'readiness');
      expect(readiness.ready).toBe(true);

      // 1) 流式对话
      const chat = await streamText(ai, 'requirement');
      expect(chat.errors).toEqual([]);
      expect(chat.text).toBe('你好');

      // 2) 结构化页面生成（designer 域，模型把 JSON 包在围栏里也能解析）
      const projectId = 'proj-mainline';
      mkdirSync(join(dirs.workspace, 'projects', projectId), { recursive: true });
      const page = await domainCall<{ candidate: unknown; raw: string }>(
        runtime,
        'designer',
        'generatePage',
        { projectId, request: { prompt: '登录页', platform: 'web', route: '/login' } },
      );
      expect(page.raw).toContain('```json');
      expect(page.candidate).toMatchObject({ id: 'page-login', route: '/login' });

      // 3) 代码生成（code 域：Generator → 网关流式 → 输出契约 → WritePipeline 计划）
      const generated = await domainCall<{
        status: string;
        plan: { entries: Array<{ path: string }> } | null;
        summary: string | null;
        sessionId: string;
      }>(runtime, 'code', 'generate', {
        projectId,
        request: {
          system: 'CODEGEN 系统提示',
          user: '写一个健康检查接口',
          target: 'backend-code',
        },
      });
      expect(generated.status).toBe('planned');
      expect(generated.summary).toBe('新增健康检查接口');
      expect(generated.plan?.entries.map((entry) => entry.path)).toEqual(['src/health.ts']);
      // 持久任务语义：生成事件走会话快照光标（agent.output.* 的 payload.type 携带 code:* 事件）
      const snapshot = await domainCall<{
        events: Array<{ payload: { type?: string } }>;
      }>(runtime, 'code', 'taskSnapshot', {
        projectId,
        sessionId: generated.sessionId,
        after: 0,
      });
      const types = snapshot.events.map((event) => event.payload.type);
      expect(types).toContain('code:generate-started');
      expect(types).toContain('code:generate-delta');
      expect(types).toContain('code:generate-done');

      // 所有模型请求都带同一把（伪造）Key，且全部打到这个中转
      const chatCalls = relay.requests.filter((req) => req.method === 'POST');
      expect(chatCalls.length).toBeGreaterThanOrEqual(3);

      // 用途归一 + 用量落库：项目行不存在时按「无项目」记，生成本身不受影响
      const db = new Database(join(dirs.dataDir, 'everyonecoding.sqlite'), { readonly: true });
      try {
        const purposes = (
          db.prepare('SELECT DISTINCT purpose FROM usage_record').all() as Array<{
            purpose: string;
          }>
        ).map((row) => row.purpose);
        expect(purposes).toEqual(expect.arrayContaining(['requirement', 'interface', 'code']));
      } finally {
        db.close();
      }
    } finally {
      await runtime.dispose();
      await relay.close();
    }
  });

  it('代码生成可中断并保留已生成部分，「继续生成」从中断处续写后产出计划', async () => {
    let hang = true;
    const json = JSON.stringify(CODE_OUTPUT);
    const relay = await startMock((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'relay-model' }] }));
        return;
      }
      if (hang) {
        // 先吐一段，再挂住不结束：模拟长生成过程中用户点「中断」
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: json.slice(0, 40) } }] })}

`);
        return;
      }
      sseOpenAi(res, [json.slice(40)]);
    });
    const dirs = freshDirs();
    const runtime = await headless(dirs);
    try {
      const ai = runtime.ai as AiControlServiceHost;
      const provider = await addProvider(ai, {
        name: '中转',
        protocol: 'openai',
        baseUrl: relay.url,
        apiKey: FAKE_KEY,
      });
      await call(ai, 'refreshModels', { providerId: provider.id });
      const projectId = 'proj-abort';

      let sawDelta!: () => void;
      const deltaSeen = new Promise<void>((resolve) => {
        sawDelta = resolve;
      });
      const pending = domainCall<{ status: string; raw: string; partial: boolean }>(
        runtime,
        'code',
        'generate',
        { projectId, request: { system: 'CODEGEN', user: '写接口', target: 'backend-code' } },
        (event) => {
          if ((event.payload as { type?: string }).type === 'code:generate-delta') sawDelta();
        },
      );
      // 增量是攒批下发的：40 字符不足一批，等不到事件就直接按时间点中断
      await Promise.race([deltaSeen, new Promise((resolve) => setTimeout(resolve, 500))]);
      expect(await domainCall<boolean>(runtime, 'code', 'abortGeneration', { projectId })).toBe(
        true,
      );
      const aborted = await pending;
      expect(aborted.status).toBe('aborted');
      expect(aborted.partial).toBe(true);
      expect(aborted.raw).toBe(json.slice(0, 40));

      hang = false;
      const resumed = await domainCall<{ status: string; plan: unknown }>(
        runtime,
        'code',
        'generate',
        { projectId, request: { continue: true } },
      );
      // 续写的是后半段：单独解析不成完整契约时降级，但不会丢内容也不会抛错
      expect(['planned', 'degraded']).toContain(resumed.status);
      const lastBody = relay.requests.at(-1)?.body ?? '';
      expect(lastBody).toContain('从中断处继续');
    } finally {
      await runtime.dispose();
      await relay.close();
    }
  });

  it('Anthropic 兼容：连接测试 + 模型列表 + 流式对话', async () => {
    const relay = await startMock(anthropicRelay(FAKE_KEY_2));
    const dirs = freshDirs();
    const ai = await createElectronAiRuntime({
      dataDir: dirs.dataDir,
      secureDir: dirs.secureDir,
      migrationsDir: MIGRATIONS,
      safeStorage: fakeSafeStorage(),
      onAiEvent: () => undefined,
    });
    try {
      const provider = await addProvider(ai, {
        name: 'Anthropic 中转',
        protocol: 'anthropic',
        baseUrl: relay.url,
        apiKey: FAKE_KEY_2,
      });
      const tested = await call<{ ok: boolean }>(ai, 'testConnection', { providerId: provider.id });
      expect(tested.ok).toBe(true);
      const models = await call<Array<{ name: string }>>(ai, 'refreshModels', {
        providerId: provider.id,
      });
      expect(models.map((model) => model.name)).toContain('claude-relay');

      const chat = await streamText(ai, 'code');
      expect(chat.errors).toEqual([]);
      expect(chat.text).toBe('来自Anthropic');
      expect(relay.requests.some((req) => req.url.includes('/messages'))).toBe(true);
    } finally {
      await ai.dispose();
      await relay.close();
    }
  });

  it('没有任何模型配置：自检给出可执行步骤，代码生成报可执行引导而不是空结果', async () => {
    const runtime = await headless();
    try {
      const ai = runtime.ai as AiControlServiceHost;
      const readiness = await call<{
        ready: boolean;
        steps: Array<{ id: string; done: boolean; action: string }>;
      }>(ai, 'readiness');
      expect(readiness.ready).toBe(false);
      expect(readiness.steps.find((step) => step.id === 'provider')?.done).toBe(false);
      expect(readiness.steps.every((step) => step.action.length > 0)).toBe(true);

      await expect(
        domainCall(runtime, 'code', 'generate', {
          projectId: 'proj-empty',
          request: { system: 'CODEGEN', user: '随便写点', target: 'backend-code' },
        }),
      ).rejects.toThrow(/设置 → 模型服务/);

      const chat = await streamText(ai, 'code');
      expect(chat.errors.join('')).toMatch(/设置 → 模型服务/);
    } finally {
      await runtime.dispose();
    }
  });
});

describe('T12-08 预算 / 容灾 / 限流走同一份配置', () => {
  it('预算超限在网络请求前拒绝，并记录事件', async () => {
    const relay = await startMock(openAiRelay(FAKE_KEY));
    const dirs = freshDirs();
    const ai = await createElectronAiRuntime({
      dataDir: dirs.dataDir,
      secureDir: dirs.secureDir,
      migrationsDir: MIGRATIONS,
      safeStorage: fakeSafeStorage(),
      onAiEvent: () => undefined,
    });
    try {
      const provider = await addProvider(ai, {
        name: '中转',
        protocol: 'openai',
        baseUrl: relay.url,
        apiKey: FAKE_KEY,
      });
      await call(ai, 'refreshModels', { providerId: provider.id });
      await call(ai, 'setBudget', { dailyUsd: 0 });
      const before = relay.requests.length;

      const chat = await streamText(ai, 'code');
      expect(chat.text).toBe('');
      expect(chat.errors.join('')).toMatch(/预算已用尽/);
      // 关键断言：一次网络请求都没有发出
      expect(relay.requests.length).toBe(before);

      const events = await call<Array<{ kind: string }>>(ai, 'recentEvents');
      expect(events.some((event) => event.kind === 'budget-exceeded')).toBe(true);
    } finally {
      await ai.dispose();
      await relay.close();
    }
  });

  it('主服务连续失败按配置切换备用，事件已脱敏；容灾策略与限流重启后仍生效', async () => {
    // 主服务：503 且把 Key 回显在错误体里（真实中转常见的坏习惯）
    const primary = await startMock((req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: `upstream unavailable for key ${String(req.headers['authorization'])}`,
          },
        }),
      );
    });
    const backup = await startMock(openAiRelay(FAKE_KEY_2));
    const dirs = freshDirs();
    const records: Array<{ kind: string; message: string }> = [];
    const open = () =>
      createElectronAiRuntime({
        dataDir: dirs.dataDir,
        secureDir: dirs.secureDir,
        migrationsDir: MIGRATIONS,
        safeStorage: fakeSafeStorage(),
        retry: { maxRetries: 0 },
        onAiEvent: (record) => records.push(record),
      });
    let ai = await open();
    try {
      const main = await addProvider(ai, {
        name: '主服务',
        protocol: 'openai',
        baseUrl: primary.url,
        apiKey: FAKE_KEY,
        order: 0,
      });
      await addProvider(ai, {
        name: '备用服务',
        protocol: 'openai',
        baseUrl: backup.url,
        apiKey: FAKE_KEY_2,
        order: 1,
      });
      await call(ai, 'addManualModel', { providerId: main.id, name: 'primary-model' });
      const backupModels = await call<Array<{ id: string }>>(ai, 'listAllModels');
      expect(backupModels.length).toBeGreaterThan(0);
      await call(ai, 'refreshModels', {
        providerId: (await call<Array<{ id: string; name: string }>>(ai, 'listProviders')).find(
          (item) => item.name === '备用服务',
        )?.id,
      });

      const policy = await call<{ enabled: boolean; failureThreshold: number }>(
        ai,
        'setFailoverPolicy',
        { policy: { enabled: true, failureThreshold: 1 } },
      );
      expect(policy).toMatchObject({ enabled: true, failureThreshold: 1 });
      await call(ai, 'setLimits', { providerId: main.id, limits: { qps: 5, concurrency: 2 } });

      const chat = await streamText(ai, 'code');
      expect(chat.errors).toEqual([]);
      expect(chat.text).toBe('你好');
      expect(primary.requests.length).toBe(1);

      const events = await call<Array<{ kind: string; message: string }>>(ai, 'recentEvents');
      const switched = events.find((event) => event.kind === 'failover');
      expect(switched).toBeDefined();
      // 脱敏：事件、落点日志里都不得出现明文 Key
      for (const text of [
        ...events.map((event) => event.message),
        ...records.map((r) => r.message),
      ]) {
        expect(text).not.toContain(FAKE_KEY);
      }
      expect(records.some((record) => record.kind === 'failover')).toBe(true);

      // 重启：容灾策略与限流来自落库配置，不回到缺省
      await ai.dispose();
      ai = await open();
      const reloaded = await call<{ enabled: boolean; failureThreshold: number }>(
        ai,
        'failoverPolicy',
      );
      expect(reloaded).toMatchObject({ enabled: true, failureThreshold: 1 });
      const limits = await call<Record<string, { qps: number; concurrency: number }>>(
        ai,
        'limitsConfig',
      );
      expect(limits[main.id]).toEqual({ qps: 5, concurrency: 2 });

      // 关闭容灾：主服务失败就如实报错，不再切备用
      await call(ai, 'setFailoverPolicy', { policy: { enabled: false } });
      const backupBefore = backup.requests.length;
      const failed = await streamText(ai, 'code');
      expect(failed.errors.length).toBeGreaterThan(0);
      expect(failed.errors.join('')).not.toContain(FAKE_KEY);
      expect(backup.requests.length).toBe(backupBefore);
    } finally {
      await ai.dispose();
      await primary.close();
      await backup.close();
    }
  });
});

describe('T12-08 远程配置启动刷新', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  function signedEnvelope(payload: Record<string, unknown>): string {
    const text = JSON.stringify(payload);
    return JSON.stringify({
      payload: text,
      signature: sign(null, Buffer.from(text, 'utf8'), keys.privateKey).toString('base64'),
    });
  }

  it('成功拉取按本地优先自动应用；签名错误不应用；不可达用缓存；慢源不拖住启动', async () => {
    let mode: 'good' | 'tampered' | 'hang' = 'good';
    const remote = await startMock((_req, res) => {
      if (mode === 'hang') return; // 永不应答
      const good = {
        version: 'rev-1',
        defaultModelId: 'remote-model',
        providers: [
          {
            name: '远程中转',
            protocol: 'openai',
            baseUrl: 'http://127.0.0.1:9/v1',
            models: ['remote-model'],
            headers: { Authorization: 'Bearer should-never-be-stored', 'X-Trace': 'on' },
          },
        ],
      };
      const body =
        mode === 'good'
          ? signedEnvelope(good)
          : // 篡改：内容换成 rev-2 并新增服务，但签名仍是 rev-1 的
            JSON.stringify({
              payload: JSON.stringify({
                ...good,
                version: 'rev-2',
                providers: [...good.providers, { ...good.providers[0], name: '恶意服务' }],
              }),
              signature: JSON.parse(signedEnvelope(good)).signature,
            });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    const dirs = freshDirs();
    const ai = await createElectronAiRuntime({
      dataDir: dirs.dataDir,
      secureDir: dirs.secureDir,
      migrationsDir: MIGRATIONS,
      safeStorage: fakeSafeStorage(),
      onAiEvent: () => undefined,
    });
    const quiet = { info: () => undefined, warn: () => undefined };
    try {
      const source = await call<{ id: string }>(ai, 'createRemoteSource', {
        name: '团队配置',
        url: `${remote.url}/config.json`,
        publicKey: publicKeyPem,
        enabled: true,
      });

      // 1) 签名正确：自动新增远程服务（敏感头被剔除），默认模型改为询问而不是直接改
      const first = await refreshRemoteConfigOnBoot(ai, { logger: quiet });
      expect(first.ok).toBe(true);
      expect(first.items[0]).toMatchObject({ ok: true, created: ['远程中转'] });
      expect(first.items[0]?.pendingDefaultModel).toMatchObject({ after: 'remote-model' });
      expect(first.items[0]?.message).toMatch(/已忽略.*Authorization/);
      const providers = await call<Array<{ name: string; headers: Record<string, string> }>>(
        ai,
        'listProviders',
      );
      const created = providers.find((item) => item.name === '远程中转');
      expect(created?.headers).toEqual({ 'X-Trace': 'on' });

      // 2) 签名错误：不应用、不覆盖缓存
      mode = 'tampered';
      const second = await refreshRemoteConfigOnBoot(ai, { logger: quiet });
      expect(second.items[0]).toMatchObject({
        ok: false,
        status: 'signature_failed',
        usingCache: true,
      });
      const afterTamper = await call<Array<{ name: string }>>(ai, 'listProviders');
      expect(afterTamper.map((item) => item.name)).not.toContain('恶意服务');
      const sources = await call<
        Array<{
          lastStatus: string;
          lastPayloadJson: string | null;
          appliedRevision: string | null;
        }>
      >(ai, 'listRemoteSources');
      expect(sources[0]?.lastStatus).toBe('signature_failed');
      expect(sources[0]?.appliedRevision).toBe('rev-1');
      expect(sources[0]?.lastPayloadJson).toContain('rev-1');
      expect(sources[0]?.lastPayloadJson).not.toContain('should-never-be-stored');
      // 用缓存应用也只会是 rev-1
      const applied = await call<{ revision: string }>(ai, 'applyRemoteSource', { id: source.id });
      expect(applied.revision).toBe('rev-1');

      // 3) 慢源：总闸到点即返回，不拖住启动
      mode = 'hang';
      const started = Date.now();
      const slow = await refreshRemoteConfigOnBoot(ai, { logger: quiet, timeoutMs: 300 });
      expect(slow.ok).toBe(false);
      expect(slow.error).toMatch(/继续使用本地缓存/);
      expect(Date.now() - started).toBeLessThan(5_000);

      // 4) 不可达：结果对象如实报 unreachable，缓存仍在
      await remote.close();
      const unreachable = await call<
        Array<{ result: { ok: boolean; status: string }; usingCache: boolean }>
      >(ai, 'refreshRemoteSourcesOnBoot');
      expect(unreachable[0]).toMatchObject({
        result: { ok: false, status: 'unreachable' },
        usingCache: true,
      });

      // 5) 换公钥：旧缓存作废，不能再被应用
      await call(ai, 'updateRemoteSource', {
        id: source.id,
        patch: {
          publicKey: generateKeyPairSync('ed25519')
            .publicKey.export({ type: 'spki', format: 'pem' })
            .toString(),
        },
      });
      const cleared = await call<Array<{ lastPayloadJson: string | null }>>(
        ai,
        'listRemoteSources',
      );
      expect(cleared[0]?.lastPayloadJson).toBeNull();
    } finally {
      await ai.dispose();
      await remote.close().catch(() => undefined);
    }
  });

  it('AI 栈缺席或 RPC 抛错时启动刷新安全返回，不抛出', async () => {
    const skipped = await refreshRemoteConfigOnBoot(null);
    expect(skipped).toMatchObject({ ok: false, items: [] });
    const broken = await refreshRemoteConfigOnBoot(
      {
        invoke: () => Promise.reject(new Error('boom')),
      },
      { logger: { info: () => undefined, warn: () => undefined } },
    );
    expect(broken).toMatchObject({ ok: false, error: 'boom' });
  });
});
