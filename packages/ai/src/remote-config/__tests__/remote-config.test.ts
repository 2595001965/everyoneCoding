import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import {
  fetchRemoteConfig,
  parseRemoteConfig,
  pickSignature,
  REMOTE_CONFIG_TIMEOUT_MS,
} from '../fetcher';
import { normalizePublicKey, verifySignature } from '../verifier';
import { diffRemoteConfig, planApply, summarizeDiff } from '../applier';
import { createNodeHttpTransport } from '../../core/node-transport';
import { startMockServer, type MockServerHandle } from '../../__tests__/helpers';

let server: MockServerHandle | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

const PAYLOAD = JSON.stringify({
  revision: '2026.09.01',
  providers: [
    {
      name: '团队中转',
      protocol: 'openai',
      baseUrl: 'https://relay.team.example.com/v1',
      models: ['gpt-4o', 'gpt-4o-mini'],
      defaultModel: 'gpt-4o',
    },
  ],
});

describe('远程配置拉取（用户自配 URL，不依赖平台服务端）', () => {
  it('拉取成功：解析出 revision 与 providers', async () => {
    server = await startMockServer([{ method: 'GET', path: '/ai.json', body: PAYLOAD }]);
    const result = await fetchRemoteConfig(
      { url: `${server.url}/ai.json` },
      createNodeHttpTransport(),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(result.document?.payload.revision).toBe('2026.09.01');
    expect(result.document?.payload.providers[0]?.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(result.message).toContain('未校验签名');
    expect(REMOTE_CONFIG_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('URL 不可达：返回结果对象而不是抛错（不阻塞启动）', async () => {
    const result = await fetchRemoteConfig(
      { url: 'http://127.0.0.1:1/ai.json' },
      createNodeHttpTransport(),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('unreachable');
    expect(result.document).toBeNull();
  });

  it('配置了公钥但响应无签名：视为失败', async () => {
    server = await startMockServer([{ method: 'GET', path: '/ai.json', body: PAYLOAD }]);
    const result = await fetchRemoteConfig(
      { url: `${server.url}/ai.json`, publicKey: 'BASE64PUBKEY' },
      createNodeHttpTransport(),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('signature_failed');
    expect(result.message).toContain('缺少签名');
  });

  it('签名不匹配：配置不应用', async () => {
    const { publicKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    server = await startMockServer([
      {
        method: 'GET',
        path: '/ai.json',
        body: PAYLOAD,
        headers: { 'x-signature': Buffer.from('not-a-real-signature').toString('base64') },
      },
    ]);
    const result = await fetchRemoteConfig(
      { url: `${server.url}/ai.json`, publicKey: publicKey as string },
      createNodeHttpTransport(),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('signature_failed');
  });

  it('签名匹配：校验通过', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const signature = cryptoSign(null, Buffer.from(PAYLOAD, 'utf8'), privateKey).toString('base64');
    server = await startMockServer([
      { method: 'GET', path: '/ai.json', body: PAYLOAD, headers: { 'x-signature': signature } },
    ]);

    const result = await fetchRemoteConfig(
      { url: `${server.url}/ai.json`, publicKey: publicKey as string },
      createNodeHttpTransport(),
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain('签名校验通过');
  });

  it('内容非法：归类为 invalid', async () => {
    server = await startMockServer([
      { method: 'GET', path: '/ai.json', body: '{"providers":"oops"}' },
    ]);
    const result = await fetchRemoteConfig(
      { url: `${server.url}/ai.json` },
      createNodeHttpTransport(),
    );
    expect(result.status).toBe('invalid');
  });
});

describe('签名校验细节', () => {
  it('裸 base64 公钥自动补 PEM 头', () => {
    const { publicKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const raw = (publicKey as string).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    expect(normalizePublicKey(raw)).toContain('-----BEGIN PUBLIC KEY-----');
  });

  it('未配置公钥时跳过校验', () => {
    expect(verifySignature('{}', null, null).outcome).toBe('skipped');
  });

  it('签名头解析支持多种大小写与字段名', () => {
    expect(pickSignature({ 'x-signature': 'abc' })).toBe('abc');
    expect(pickSignature({ 'X-EC-Signature': 'def' })).toBe('def');
    expect(pickSignature({})).toBeNull();
  });

  it('正文内 signature 字段也能被识别', () => {
    const document = parseRemoteConfig(`{"signature":"sig","revision":"1","providers":[]}`);
    expect(document.signature).toBe('sig');
    expect(document.payload.revision).toBe('1');
  });
});

describe('差异预览与应用（本地 > 远程默认）', () => {
  const locals = [
    {
      id: 'p1',
      name: '团队中转',
      protocol: 'openai' as const,
      baseUrl: 'https://relay.team.example.com/v1',
      models: ['gpt-4o'],
      headers: {},
      timeoutMs: 30_000,
    },
  ];

  it('已有同名服务时只提示模型差异，不覆盖本地', () => {
    const payload = parseRemoteConfig(PAYLOAD).payload;
    const items = diffRemoteConfig(locals, payload);
    expect(items.some((item) => item.label.includes('新增模型'))).toBe(true);

    const plan = planApply(payload, locals);
    expect(plan.items[0]?.kind).toBe('skip');
    expect(plan.items[0]?.reason).toContain('本地优先');
  });

  it('本地没有的服务标记为新增', () => {
    const payload = parseRemoteConfig(PAYLOAD).payload;
    const plan = planApply(payload, []);
    expect(plan.items[0]?.kind).toBe('create');
    expect(summarizeDiff(diffRemoteConfig([], payload))).toContain('新增');
  });

  it('默认模型变更会被识别（供 UI 弹窗询问）', () => {
    const payload = parseRemoteConfig(PAYLOAD).payload;
    const plan = planApply(payload, locals, { currentDefaultModel: 'old-model' });
    expect(plan.defaultModelChange).toEqual({ before: 'old-model', after: 'gpt-4o' });
  });

  it('远程删除的服务在差异里标为移除', () => {
    const payload = parseRemoteConfig(
      JSON.stringify({
        revision: '2',
        providers: [{ name: '其他', protocol: 'openai', baseUrl: 'https://x.com/v1' }],
      }),
    ).payload;
    const items = diffRemoteConfig(locals, payload);
    expect(items.some((item) => item.kind === 'removed')).toBe(true);
  });
});
