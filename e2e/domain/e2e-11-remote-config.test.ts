/**
 * E2E-11：用户自配远程配置 —— 填入自配 URL → 拉取 → 展示配置差异 → 设为默认；
 *         URL 不可达时不阻塞启动（如实降级）。
 *
 * 装配：真实本地 HTTP 服务（真实请求）+ 真实 `fetchRemoteConfig`（zod 校验 + 超时）
 * + 真实 `diffRemoteConfig` / `planApply`（差异展示与本地优先规则）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  createNodeHttpTransport,
  diffRemoteConfig,
  fetchRemoteConfig,
  planApply,
  summarizeDiff,
  type LocalProviderSnapshot,
} from '@ec/ai';

import { startMockServer, type MockServerHandle } from '../../packages/ai/src/__tests__/helpers';

let server: MockServerHandle | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

/** 用户自配的远程配置文档（本地不存在的 provider → create） */
const REMOTE_DOC = {
  revision: 'rev-2026-09-14',
  updatedAt: 1_760_000_000_000,
  note: '团队默认配置',
  providers: [
    {
      name: '团队中转',
      protocol: 'openai',
      baseUrl: 'https://relay.example.com/v1',
      models: ['gpt-team-large', 'gpt-team-fast'],
      defaultModel: 'gpt-team-large',
    },
  ],
};

describe('E2E-11 用户自配远程配置：拉取 → 差异 → 设为默认', () => {
  it('拉取成功：展示配置差异，确认后默认模型生效', async () => {
    server = await startMockServer([
      { method: 'GET', path: '/config.json', status: 200, body: JSON.stringify(REMOTE_DOC) },
    ]);

    const fetched = await fetchRemoteConfig(
      { url: `${server.url}/config.json` },
      createNodeHttpTransport(),
    );
    expect(fetched.ok).toBe(true);
    expect(fetched.status).toBe('success');
    expect(fetched.document?.payload.revision).toBe('rev-2026-09-14');

    // 本地只有一个自建 provider（与远程不同名）
    const locals: LocalProviderSnapshot[] = [
      {
        id: 'local-1',
        name: '我的中转',
        protocol: 'openai',
        baseUrl: 'https://mine.example.com/v1',
        models: ['gpt-mine-a', 'gpt-mine-b'],
        headers: {},
        timeoutMs: 30_000,
      },
    ];
    const diff = diffRemoteConfig(locals, fetched.document!.payload);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff[0]?.kind).toBe('added');
    expect(summarizeDiff(diff)).toBeTruthy();

    // 用户确认后应用：新 provider 建库 + 默认模型指向远程默认
    const plan = planApply(fetched.document!.payload, locals, { currentDefaultModel: null });
    expect(plan.revision).toBe('rev-2026-09-14');
    expect(plan.items.some((item) => item.kind === 'create' && item.name === '团队中转')).toBe(
      true,
    );
    expect(plan.defaultModel).toBe('gpt-team-large');
  });

  it('本地优先：同名 provider 默认不覆盖（skip 并说明原因）', async () => {
    server = await startMockServer([
      { method: 'GET', path: '/config.json', status: 200, body: JSON.stringify(REMOTE_DOC) },
    ]);
    const fetched = await fetchRemoteConfig(
      { url: `${server.url}/config.json` },
      createNodeHttpTransport(),
    );

    const locals: LocalProviderSnapshot[] = [
      {
        id: 'local-2',
        name: '团队中转',
        protocol: 'openai',
        baseUrl: 'https://local-override.example.com/v1',
        models: ['gpt-local'],
        headers: {},
        timeoutMs: 30_000,
      },
    ];
    const plan = planApply(fetched.document!.payload, locals, { currentDefaultModel: null });
    const item = plan.items.find((entry) => entry.name === '团队中转');
    expect(item?.kind).toBe('skip');
    expect(item?.reason ?? '').toBeTruthy();
  });

  it('URL 不可达时如实返回 unreachable，且不抛错（不阻塞启动）', async () => {
    // 本机高位端口无监听
    const result = await fetchRemoteConfig(
      { url: 'http://127.0.0.1:1/config.json' },
      createNodeHttpTransport(),
      {
        timeoutMs: 2000,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('unreachable');
    expect(result.document).toBeNull();
    expect(result.message ?? '').toBeTruthy();
  });

  it('远程配置内容非法时判定 invalid（不写入脏配置）', async () => {
    server = await startMockServer([
      { method: 'GET', path: '/bad.json', status: 200, body: JSON.stringify({ revision: '' }) },
    ]);
    const result = await fetchRemoteConfig(
      { url: `${server.url}/bad.json` },
      createNodeHttpTransport(),
    );
    expect(result.ok).toBe(false);
    expect(['invalid', 'unreachable']).toContain(result.status);
  });
});
