import { afterAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createDpapiStore, createElectronAiRuntime } from '../ai/runtime';
import { createNodeHttpTransport, type HttpTransport, type AiEventRecord } from '@ec/ai';
import {
  AuthClient,
  type AuthSession,
  type SecureStorePort,
  type SystemPort,
  type TransportPort,
} from '@ec/account';
import type { AiStreamEvent } from '@ec/shell-api';

type AiRuntime = Awaited<ReturnType<typeof createElectronAiRuntime>>;

/**
 * V2-T03：免平台登录的本地 Provider 完整闭环（V2-MDL-04/05/07、V2-E2E-01/12）。
 *
 * 上游说明：全部请求打向本机 OpenAI 协议 mock（127.0.0.1），**模拟上游，非真实 Provider，
 * 未发生任何付费调用**。平台域网络用「非回环即拒绝」的传输层模拟防火墙禁用。
 */

const SECRET_KEY = 'sk-t03-local-secret-42cafe';

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''),
  };
}

/** OpenAI 兼容 mock：响应带 marker 与实测 usage（连接测试/生成的入账依据） */
async function startOpenAiMock(
  marker: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'shared-model' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: {"choices":[{"delta":{"content":"${marker}"}}]}\n\n`);
        res.write(
          `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: marker }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 模拟「平台域名网络被禁用」：只放行回环，其余目标一律拒绝并计数 */
function makePlatformBlockedTransport(): { blocked: string[]; transport: HttpTransport } {
  const inner = createNodeHttpTransport();
  const blocked: string[] = [];
  return {
    blocked,
    transport: {
      request: async (req) => {
        const host = new URL(req.url).hostname;
        if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
          return inner.request(req);
        }
        blocked.push(req.url);
        throw new Error(`模拟防火墙：平台域网络已被禁用（${host}）`);
      },
      close: async () => {
        await inner.close?.();
      },
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface RuntimeHarness {
  root: string;
  dataDir: string;
  secureDir: string;
  close: () => Promise<void>;
}

async function withRuntime(
  options: {
    transport?: HttpTransport;
    onAiEvent?: (record: AiEventRecord) => void;
  },
  run: (runtime: AiRuntime, harness: RuntimeHarness) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ec-t03-local-'));
  const dataDir = join(root, 'data');
  const secureDir = join(root, 'secure');
  const runtime = await createElectronAiRuntime({
    dataDir,
    secureDir,
    migrationsDir: join(process.cwd(), '..', '..', 'packages', 'data', 'migrations'),
    safeStorage: fakeSafeStorage(),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.onAiEvent ? { onAiEvent: options.onAiEvent } : {}),
  });
  try {
    await run(runtime, { root, dataDir, secureDir, close: async () => undefined });
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

async function rpc<T>(
  runtime: {
    invoke: (r: never) => Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>;
  },
  requestId: string,
  method: string,
  params: unknown,
): Promise<T> {
  const response = (await runtime.invoke({
    requestId,
    method,
    params,
  } as never)) as { ok: boolean; result?: unknown; error?: { message: string } };
  if (!response.ok) throw new Error(response.error?.message ?? `RPC ${method} 失败`);
  return response.result as T;
}

async function collectStream(
  runtime: AiRuntime,
  request: { purpose?: string; providerId?: string; modelId?: string },
): Promise<{ text: string; error: string | null }> {
  const events: AiStreamEvent[] = [];
  runtime.stream(
    {
      requestId: `s-${Math.random().toString(36).slice(2)}`,
      purpose: request.purpose ?? 'code',
      messages: [{ role: 'user', content: 'hi' }],
      ...(request.providerId !== undefined ? { providerId: request.providerId } : {}),
      ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
    },
    (event: AiStreamEvent) => events.push(event),
  );
  await waitUntil(() => events.some((event) => event.type === 'done'));
  const text = events
    .filter(
      (event): event is Extract<AiStreamEvent, { type: 'chunk' }> =>
        event.type === 'chunk' && event.payload['type'] === 'delta',
    )
    .map((event) => String(event.payload['text'] ?? ''))
    .join('');
  const streamError = events.find((event) => event.type === 'error');
  return { text, error: streamError ? String(streamError.error.message) : null };
}

/** 建一个已配 Key、已连通的本地 Provider（V2-MDL-04 首次使用路径的脚本化） */
async function seedProvider(runtime: AiRuntime, baseUrl: string, name: string): Promise<string> {
  const keyRef = await rpc<string>(runtime, 'k1', 'persistApiKey', { apiKey: SECRET_KEY });
  const provider = await rpc<{ id: string }>(runtime, 'k2', 'createProvider', {
    userId: 'local-user',
    name,
    protocol: 'openai',
    baseUrl,
    headers: {},
    timeoutMs: 5_000,
    manualModels: ['shared-model'],
    keyRef,
  });
  return provider.id;
}

async function firstModelId(runtime: AiRuntime, providerId: string): Promise<string> {
  const models = await rpc<Array<{ id: string; name: string }>>(runtime, 'm1', 'listModels', {
    providerId,
  });
  const first = models.find((model) => model.name === 'shared-model');
  if (!first) throw new Error('手填模型未落库');
  return first.id;
}

describe('V2-T03 免平台登录的本地 Provider 闭环', () => {
  it('空用户数据域、全程无平台账号：可建 Provider、配 Key、连接测试并入账、完成生成', async () => {
    const mock = await startOpenAiMock('本地直连OK');
    await withRuntime({}, async (runtime) => {
      const providerId = await seedProvider(runtime, mock.url, '我的中转');
      const modelId = await firstModelId(runtime, providerId);

      // 连接测试是真实对话：结果可用，且实测 usage 入账（purpose=connection-test）
      const test = await rpc<{
        ok: boolean;
        usage: { totalTokens: number } | null;
        modelName: string | null;
      }>(runtime, 't1', 'testConnection', { providerId });
      expect(test.ok).toBe(true);
      expect(test.modelName).toBe('shared-model');
      expect(test.usage?.totalTokens).toBe(4);

      const usage1 = await rpc<{ requests: number; totalTokens: number }>(
        runtime,
        't2',
        'monthlyUsage',
        {},
      );
      expect(usage1.requests).toBe(1);
      expect(usage1.totalTokens).toBe(4);

      // 用途绑定保存完整路由（model.id 是 provider 作用域的），生成走默认绑定
      await rpc(runtime, 'b1', 'saveBinding', {
        binding: { bindings: { code: modelId }, useDefaultForAll: false, defaultModelId: modelId },
      });
      const generated = await collectStream(runtime, {});
      expect(generated.error).toBeNull();
      expect(generated.text).toBe('本地直连OK');

      // 生成入账：连接测试 4 + 生成 8 = 12
      const usage2 = await rpc<{ requests: number; totalTokens: number }>(
        runtime,
        't3',
        'monthlyUsage',
        {},
      );
      expect(usage2.requests).toBe(2);
      expect(usage2.totalTokens).toBe(12);
    });
    await mock.close();
  });

  it('平台域网络被禁用 + 已登录平台余额为零的假象：BYOK 生成照常，平台零请求', async () => {
    const mock = await startOpenAiMock('禁网也能生成');
    const guard = makePlatformBlockedTransport();
    const events: AiEventRecord[] = [];
    await withRuntime(
      { transport: guard.transport, onAiEvent: (record) => events.push(record) },
      async (runtime, harness) => {
        const providerId = await seedProvider(runtime, mock.url, '离线中转');
        const modelId = await firstModelId(runtime, providerId);
        await rpc(runtime, 'b1', 'saveBinding', {
          binding: {
            bindings: { code: modelId },
            useDefaultForAll: false,
            defaultModelId: modelId,
          },
        });

        // 平台「已登录且余额为零」：只留下会话痕迹，客户端不存在任何平台余额查询路径
        const dpapi = createDpapiStore(fakeSafeStorage(), harness.secureDir);
        await dpapi.set(
          'oauth-token',
          'account__session',
          JSON.stringify({ note: 'zero-balance-session' }),
        );

        // 完整生成流程：连接测试（真实对话并入账）→ 流式生成
        const test = await rpc<{ ok: boolean }>(runtime, 't0', 'testConnection', { providerId });
        expect(test.ok).toBe(true);
        const generated = await collectStream(runtime, {});
        expect(generated.error).toBeNull();
        expect(generated.text).toBe('禁网也能生成');

        // 全流程（连接测试 + 生成）没有一次非回环请求：平台域零访问
        expect(guard.blocked).toEqual([]);
        const usage = await rpc<{ requests: number }>(runtime, 't1', 'monthlyUsage', {});
        expect(usage.requests).toBeGreaterThanOrEqual(2);
      },
    );
    await mock.close();
  });

  it('A/B 两个 Provider 用同一个 modelId：绑定与显式路由各走各的，用量分开记账', async () => {
    const mockA = await startOpenAiMock('来自A');
    const mockB = await startOpenAiMock('来自B');
    await withRuntime({}, async (runtime) => {
      const providerA = await seedProvider(runtime, mockA.url, '渠道A');
      const providerB = await seedProvider(runtime, mockB.url, '渠道B');
      const modelA = await firstModelId(runtime, providerA);
      const modelB = await firstModelId(runtime, providerB);
      expect(modelA).not.toBe(modelB);

      await rpc(runtime, 'b1', 'saveBinding', {
        binding: { bindings: { code: modelA }, useDefaultForAll: false, defaultModelId: modelA },
      });
      const viaBinding = await collectStream(runtime, {});
      expect(viaBinding.text).toBe('来自A');

      const viaExplicit = await collectStream(runtime, { providerId: providerB, modelId: modelB });
      expect(viaExplicit.text).toBe('来自B');

      const byModel = await rpc<Array<{ modelId: string; totals: { totalTokens: number } }>>(
        runtime,
        'u1',
        'usageByModel',
        {},
      );
      const totalsA = byModel.find((row) => row.modelId === modelA);
      const totalsB = byModel.find((row) => row.modelId === modelB);
      expect(totalsA?.totals.totalTokens).toBeGreaterThan(0);
      expect(totalsB?.totals.totalTokens).toBeGreaterThan(0);
    });
    await mockA.close();
    await mockB.close();
  });

  it('全流程日志、事件、RPC 响应与本地数据库均无 Key 明文', async () => {
    const mock = await startOpenAiMock('脱敏检查');
    const events: AiEventRecord[] = [];
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const responses: unknown[] = [];
    await withRuntime({ onAiEvent: (record) => events.push(record) }, async (runtime, harness) => {
      const rawInvoke = runtime.invoke.bind(runtime);
      runtime.invoke = (async (request: never) => {
        const response = await rawInvoke(request);
        responses.push(response);
        return response;
      }) as typeof runtime.invoke;

      const providerId = await seedProvider(runtime, mock.url, '脱敏中转');
      await rpc<{ ok: boolean }>(runtime, 't1', 'testConnection', { providerId });
      const generated = await collectStream(runtime, {});
      expect(generated.error).toBeNull();

      // SQLite 明文扫描：provider / secure_ref / usage_record 等任何行都不含 Key
      const db = new Database(join(harness.dataDir, 'everyonecoding.sqlite'), { readonly: true });
      const dump = ['provider', 'secure_ref', 'usage_record', 'ai_model_config']
        .map((table) =>
          db
            .prepare(`SELECT * FROM ${table}`)
            .all()
            .map((row) => JSON.stringify(row))
            .join('\n'),
        )
        .join('\n');
      db.close();
      expect(dump).not.toContain(SECRET_KEY);

      // 密钥环文件名不携带 Key；文件内容由外壳加密（测试桩为前缀格式，不做明文断言）
      const keyFiles = readdirSync(join(harness.secureDir, 'ai-key'));
      expect(keyFiles.every((name) => !name.includes(SECRET_KEY))).toBe(true);
    });
    consoleSpy.mockRestore();

    const leaked = [
      JSON.stringify(events),
      JSON.stringify(responses),
      consoleSpy.mock.calls.map((args) => args.join(' ')).join('\n'),
    ].join('\n');
    expect(leaked).not.toContain(SECRET_KEY);
    await mock.close();
  });

  it('平台登出只清会话：本地 Provider、密钥环与生成能力原样保留，且登出不需要平台在线', async () => {
    const mock = await startOpenAiMock('登出后仍在');
    await withRuntime({}, async (runtime, harness) => {
      const providerId = await seedProvider(runtime, mock.url, '登出保留中转');
      const modelId = await firstModelId(runtime, providerId);
      await rpc(runtime, 'b1', 'saveBinding', {
        binding: { bindings: { code: modelId }, useDefaultForAll: false, defaultModelId: modelId },
      });

      // 平台会话与 AI 密钥环共用同一 DPAPI 根，但分属不同命名空间
      const dpapi = createDpapiStore(fakeSafeStorage(), harness.secureDir);
      const authSecure: SecureStorePort = {
        set: (key, value) => dpapi.set('oauth-token', key.replace(/[^A-Za-z0-9._-]/g, '_'), value),
        get: (key) => dpapi.get('oauth-token', key.replace(/[^A-Za-z0-9._-]/g, '_')),
        delete: (key) => dpapi.delete('oauth-token', key.replace(/[^A-Za-z0-9._-]/g, '_')),
      };
      const transport: TransportPort = {
        request: async () => {
          throw new Error('平台不可达：登出不应发起任何平台请求');
        },
      };
      const system: SystemPort = {
        openExternal: async () => undefined,
        startLoopback: async () => ({
          redirectUri: 'http://127.0.0.1:0/oauth',
          stop: () => undefined,
        }),
        registerProtocol: async () => false,
        writeClipboard: async () => undefined,
      };
      const client = new AuthClient({
        transport,
        system,
        secure: authSecure,
        baseUrl: 'https://platform.example.test',
      });
      const now = Date.now();
      const session: AuthSession = {
        identity: {
          accountId: 'acc-1',
          login: 'dev@example.com',
          displayName: 'Dev',
          avatarUrl: null,
          emailVerified: true,
          hasPassword: true,
        },
        tokens: {
          accessToken: 'acc-token',
          refreshToken: 'refresh-token',
          expiresAt: now + 3_600_000,
          refreshExpiresAt: now + 30 * 24 * 3_600_000,
        },
        rememberUntil: now + 7 * 24 * 3_600_000,
      };
      await client.session.save(session);
      expect(await client.restore()).not.toBeNull();

      await client.logout();
      expect(await client.restore()).toBeNull();
      expect(await dpapi.listKeys('oauth-token')).toEqual([]);

      // 登出后本地配置与能力原样：Provider 还在、密钥环未动、生成照常
      const providers = await rpc<Array<{ id: string }>>(runtime, 'l1', 'listProviders', {});
      expect(providers.map((provider) => provider.id)).toContain(providerId);
      expect(await dpapi.listKeys('ai-key')).not.toEqual([]);
      const generated = await collectStream(runtime, {});
      expect(generated.error).toBeNull();
      expect(generated.text).toBe('登出后仍在');
    });
    await mock.close();
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
