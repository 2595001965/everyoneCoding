import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

import { mask, registerSecretValue } from '@ec/core';

import { createAiStack } from '../../service/ai-stack';
import { collect } from '../../core/stream';
import { normalizePurpose } from '../../domain/purpose-binding';
import { fetchRemoteConfig, parseRemoteConfig } from '../../remote-config/fetcher';
import type { HttpTransport } from '../../core/http';
import {
  insertUser,
  openTestDb,
  startMockServer,
  testSecureStore,
  type MockServerHandle,
} from '../../__tests__/helpers';

/**
 * T12-08：用途绑定 / 候选顺序 / 脱敏 / 远程配置签名信封。
 * 请求全部打到本机 mock；Key 为明显伪造的字符串。
 */

const USER = 'USER0000000000000000000000';
const SSE = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
  `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  })}\n\n` +
  'data: [DONE]\n\n';

const servers: MockServerHandle[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function relay(text: string): Promise<MockServerHandle> {
  const server = await startMockServer([
    {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'text/event-stream' },
      body: SSE(text),
    },
  ]);
  servers.push(server);
  return server;
}

async function seed() {
  const db = openTestDb();
  insertUser(db, USER);
  const stack = createAiStack({ db, secureStore: testSecureStore(), userId: USER });
  const a = await relay('来自 A');
  const b = await relay('来自 B');
  const providerA = await stack.providers.create({
    userId: USER,
    name: 'A',
    protocol: 'openai',
    baseUrl: `${a.url}/v1`,
    order: 0,
  });
  const providerB = await stack.providers.create({
    userId: USER,
    name: 'B',
    protocol: 'openai',
    baseUrl: `${b.url}/v1`,
    order: 1,
  });
  const modelA = stack.models.create(providerA.id, 'model-a');
  const modelB = stack.models.create(providerB.id, 'model-b');
  return { db, stack, a, b, providerA, providerB, modelA, modelB };
}

describe('用途化模型绑定走网关同一条解析链', () => {
  it('业务别名 commit-message 归一为 commit-msg，并命中「非首位」Provider 上的绑定模型', async () => {
    const { db, stack, a, b, modelA, modelB } = await seed();
    stack.bindings.save(USER, {
      bindings: { 'commit-msg': modelB.id },
      useDefaultForAll: false,
      defaultModelId: modelA.id,
    });

    const result = await collect(
      stack.gateway.chat({
        userId: USER,
        purpose: 'commit-message' as never,
        messages: [{ role: 'user', content: 'diff' }],
      }),
    );
    expect(result.text).toBe('来自 B');
    // 此前候选列表整体按 order 重排，绑定在 order=1 的模型会被 order=0 的 A 抢走
    expect(a.requests).toHaveLength(0);
    expect(b.requests).toHaveLength(1);
    expect(JSON.parse(b.requests[0]?.body ?? '{}')).toMatchObject({ model: 'model-b' });

    const purposes = db.prepare('SELECT purpose FROM usage_record').all() as Array<{
      purpose: string;
    }>;
    expect(purposes.map((row) => row.purpose)).toEqual(['commit-msg']);
  });

  it('绑定模型所属 Provider 被停用时不再被当作首选', async () => {
    const { stack, a, b, providerB, modelB } = await seed();
    stack.bindings.save(USER, {
      bindings: { code: modelB.id },
      useDefaultForAll: false,
      defaultModelId: null,
    });
    stack.providers.setEnabled(providerB.id, false);
    const result = await collect(
      stack.gateway.chat({
        userId: USER,
        purpose: 'code',
        messages: [{ role: 'user', content: 'x' }],
      }),
    );
    expect(result.text).toBe('来自 A');
    expect(b.requests).toHaveLength(0);
    expect(a.requests).toHaveLength(1);
  });

  it('describeModel 与 chat 同口径：未知用途回落 code，未配置时为 null', async () => {
    expect(normalizePurpose('pipeline')).toBe('requirement');
    expect(normalizePurpose('merge-conflict')).toBe('code');
    expect(normalizePurpose('???')).toBe('code');

    const db = openTestDb();
    insertUser(db, USER);
    const empty = createAiStack({ db, secureStore: testSecureStore(), userId: USER });
    expect(empty.gateway.describeModel(USER, 'code')).toBeNull();
    expect(empty.control.readiness().ready).toBe(false);
  });

  it('平台账号服务停服时，本地 BYOK 仍直连且只发送本地 Provider Key', async () => {
    const db = openTestDb();
    insertUser(db, USER);
    const local = await relay('BYOK remains local');
    let platformTokenReads = 0;
    const stack = createAiStack({
      db,
      secureStore: testSecureStore(),
      userId: USER,
      platformGateway: {
        accountBaseUrl: 'http://127.0.0.1:1',
        getAccessToken: async () => {
          platformTokenReads += 1;
          throw new Error('simulated platform outage');
        },
      },
    });
    const provider = await stack.providers.create({
      userId: USER,
      name: '本地 BYOK',
      protocol: 'openai',
      baseUrl: `${local.url}/v1`,
    });
    await stack.providers.saveApiKey(provider.id, 'local-only-BYOK-key');
    const model = stack.models.create(provider.id, 'local-model');
    stack.bindings.save(USER, {
      bindings: {},
      useDefaultForAll: true,
      defaultModelId: model.id,
    });

    const result = await collect(
      stack.gateway.chat({
        userId: USER,
        purpose: 'code',
        messages: [{ role: 'user', content: 'never upload local key' }],
      }),
    );

    expect(result.text).toBe('BYOK remains local');
    expect(platformTokenReads).toBe(0);
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0]?.headers['authorization']).toBe('Bearer local-only-BYOK-key');
    expect(local.requests[0]?.body).not.toContain('local-only-BYOK-key');
  });
});

describe('密钥脱敏：登记过的明文在任何文本里都被打码', () => {
  it('非 sk- 格式的中转 Key 也按前 4 后 4 打码', () => {
    const key = 'relayKEY-0123456789-abcdefXYZ';
    expect(mask(`bad key ${key}`)).toContain(key); // 规则式脱敏认不出这种格式
    registerSecretValue(key);
    const masked = mask(`upstream rejected ${key} (401)`);
    expect(masked).not.toContain(key);
    expect(masked).toContain('rela***fXYZ');
  });

  it('过短的值不登记（避免误伤正文）', () => {
    registerSecretValue('short');
    expect(mask('a short text')).toBe('a short text');
  });
});

describe('远程配置信封签名与敏感头', () => {
  const keys = generateKeyPairSync('ed25519');
  const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const payload = {
    version: 7,
    defaultModelId: 'm1',
    providers: [
      {
        name: 'R',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:9/v1',
        models: ['m1'],
        headers: { 'x-api-key': 'never-store-me', 'X-Region': 'cn' },
      },
    ],
  };

  const transportOf = (body: string, headers: Record<string, string> = {}): HttpTransport =>
    ({
      request: async () => ({ status: 200, headers, text: async () => body }),
    }) as unknown as HttpTransport;

  it('payload 为字符串的信封：签名覆盖该字符串；PRD 字段名 version / defaultModelId 被接受', async () => {
    const text = JSON.stringify(payload);
    const body = JSON.stringify({
      payload: text,
      signature: sign(null, Buffer.from(text), keys.privateKey).toString('base64'),
    });
    const result = await fetchRemoteConfig({ url: 'http://x', publicKey: pem }, transportOf(body));
    expect(result.status).toBe('success');
    expect(result.document?.payload.revision).toBe('7');
    expect(result.document?.payload.defaultModel).toBe('m1');
    expect(result.document?.payload.providers[0]?.headers).toEqual({ 'X-Region': 'cn' });
    expect(result.document?.cacheJson).not.toContain('never-store-me');
    expect(result.message).toMatch(/已忽略/);
  });

  it('payload 为对象的信封：签名覆盖紧凑 JSON；篡改后拒绝', async () => {
    const signature = sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString(
      'base64',
    );
    const ok = await fetchRemoteConfig(
      { url: 'http://x', publicKey: pem },
      transportOf(JSON.stringify({ payload, signature })),
    );
    expect(ok.status).toBe('success');

    const tampered = await fetchRemoteConfig(
      { url: 'http://x', publicKey: pem },
      transportOf(JSON.stringify({ payload: { ...payload, version: 8 }, signature })),
    );
    expect(tampered).toMatchObject({ ok: false, status: 'signature_failed', document: null });
  });

  it('配置了公钥但完全没有签名：拒绝', async () => {
    const result = await fetchRemoteConfig(
      { url: 'http://x', publicKey: pem },
      transportOf(JSON.stringify(payload)),
    );
    expect(result.status).toBe('signature_failed');
  });

  it('缓存正文可被 parseRemoteConfig 回读', () => {
    const document = parseRemoteConfig(JSON.stringify(payload));
    expect(parseRemoteConfig(document.cacheJson).payload.revision).toBe('7');
  });
});
