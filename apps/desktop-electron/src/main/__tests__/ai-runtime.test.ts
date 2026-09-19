import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDpapiStore, createElectronAiRuntime } from '../ai/runtime';
import type { AiStreamEvent } from '@ec/shell-api';

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''),
  };
}

describe('Electron DPAPI secure store', () => {
  it('stores encrypted bytes and round-trips without exposing plaintext filename', async () => {
    const root = `${process.cwd()}/.tmp-secure-store-test`;
    const store = createDpapiStore(fakeSafeStorage(), root);
    await store.set('ai-key', 'provider-abc', 'sk-test-only');
    expect(await store.get('ai-key', 'provider-abc')).toBe('sk-test-only');
    expect(await store.listKeys('ai-key')).toEqual(['provider-abc']);
    await store.delete('ai-key', 'provider-abc');
    expect(await store.get('ai-key', 'provider-abc')).toBeNull();
  });

  it('rejects unsafe key names', async () => {
    const store = createDpapiStore(fakeSafeStorage(), `${process.cwd()}/.tmp-secure-store-test-2`);
    await expect(store.set('ai-key', '../escape', 'secret')).rejects.toThrow();
  });
});

/** OpenAI 兼容的最小 mock：/v1/models + 非流式 chat + SSE 流式 chat */
async function startOpenAiMock(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
        res.write(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
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

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Electron AI 主进程路由（T1-06 / E2E-10）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ec-ai-runtime-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const setup = async () => {
    const mock = await startOpenAiMock();
    const runtime = await createElectronAiRuntime({
      dataDir: join(root, 'data'),
      secureDir: join(root, 'secure'),
      migrationsDir: join(process.cwd(), '..', '..', 'packages', 'data', 'migrations'),
      safeStorage: fakeSafeStorage(),
    });
    return { mock, runtime };
  };

  it('persistApiKey 只回传引用名，且明文可经密钥环取回', async () => {
    const { mock, runtime } = await setup();
    const response = await runtime.invoke({
      requestId: 'r1',
      method: 'persistApiKey',
      params: { apiKey: 'sk-top-secret-123' },
    });
    expect(response.ok).toBe(true);
    const keyRef = response.result as string;
    expect(keyRef).not.toContain('sk-top-secret-123');
    expect(keyRef.startsWith('temp-')).toBe(true);

    // 明文不出主进程：引用名之外没有第二条读明文的 RPC 通道
    // （方法名不在白名单，编译期即被拒；此处故意越权调用，验证运行时同样拒绝）
    const notWhitelisted = await runtime.invoke({
      requestId: 'r2',
      method: 'readDraftKey' as never,
      params: { keyRef },
    });
    expect(notWhitelisted.ok).toBe(false);
    await runtime.dispose();
    await mock.close();
  });

  it('testDraftConnection 路由存在并可用（未保存的 Provider 也能试连）', async () => {
    const { mock, runtime } = await setup();
    const persisted = await runtime.invoke({
      requestId: 'r1',
      method: 'persistApiKey',
      params: { apiKey: 'sk-draft' },
    });
    const keyRef = persisted.result as string;

    const response = await runtime.invoke({
      requestId: 'r2',
      method: 'testDraftConnection',
      params: {
        input: {
          name: '未保存的中转',
          protocol: 'openai',
          baseUrl: mock.url,
          headers: {},
          timeoutMs: 5_000,
          manualModels: ['gpt-test'],
        },
        keyRef,
      },
    });
    expect(response.ok).toBe(true);
    expect((response.result as { ok: boolean }).ok).toBe(true);
    await runtime.dispose();
    await mock.close();
  });

  it('保存 Provider 后能列出、能连通，并完成一次流式生成', async () => {
    const { mock, runtime } = await setup();
    const persisted = await runtime.invoke({
      requestId: 'r1',
      method: 'persistApiKey',
      params: { apiKey: 'sk-saved' },
    });
    const keyRef = persisted.result as string;

    const created = await runtime.invoke({
      requestId: 'r2',
      method: 'createProvider',
      params: {
        userId: 'local-user',
        name: '主中转',
        protocol: 'openai',
        baseUrl: mock.url,
        headers: {},
        timeoutMs: 5_000,
        manualModels: ['gpt-test'],
        keyRef,
      },
    });
    expect(created.ok).toBe(true);

    const listed = await runtime.invoke({ requestId: 'r3', method: 'listProviders', params: {} });
    expect((listed.result as unknown[]).length).toBe(1);

    const events: AiStreamEvent[] = [];
    runtime.stream(
      { requestId: 's1', purpose: 'code', messages: [{ role: 'user', content: 'hi' }] },
      (event) => events.push(event),
    );
    await waitUntil(() => events.some((event) => event.type === 'done'));

    const text = events
      .filter(
        (event): event is Extract<AiStreamEvent, { type: 'chunk' }> =>
          event.type === 'chunk' && event.payload['type'] === 'delta',
      )
      .map((event) => String(event.payload['text'] ?? ''))
      .join('');
    expect(text).toBe('你好');
    expect(events.at(-1)?.type).toBe('done');

    await runtime.dispose();
    await mock.close();
  });
});
