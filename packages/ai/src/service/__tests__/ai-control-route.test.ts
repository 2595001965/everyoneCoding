import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { DataClient, Migrator } from '@ec/data';

import { createAiStack, type AiStack } from '../../service/ai-stack';
import { PurposeBindingRepo } from '../../repo/purpose-binding-repo';
import { UsageRepo } from '../../repo/usage-repo';
import {
  coreRouteOfModelRoute,
  modelRouteOfCoreRoute,
  persistentRouteKeyOf,
  routeOfModel,
} from '../../domain/model-route';
import { parseProviderModelKey } from '@ec/core';
import {
  startMockServer,
  testSecureStore,
  insertUser,
  type MockServerHandle,
} from '../../__tests__/helpers';

/**
 * V2-T02 验收（V2-MDL-01/02/03/06）：
 * A/B 两个 Provider 使用同一个 modelId 时，模型、用途绑定、默认路由、用量
 * 与目录来源必须按复合路由身份隔离——重启不混淆，远程刷新不覆盖本地，不按名字猜路由。
 */

const USER = 'USER0000000000000000000000';

const stacks: AiStack[] = [];
const servers: MockServerHandle[] = [];
const tempDirs: string[] = [];
const openDbs: Database.Database[] = [];

afterAll(async () => {
  for (const stack of stacks) await stack.dispose();
  for (const server of servers) await server.close();
  for (const db of openDbs) db.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function openDb(filePath: string, seedUser = true): Database.Database {
  const client = DataClient.open({ filePath });
  Migrator.fromDirectory(client.raw).up();
  if (seedUser) insertUser(client.raw, USER);
  openDbs.push(client.raw);
  return client.raw;
}

function buildStack(db: Database.Database): AiStack {
  const stack = createAiStack({ db, secureStore: testSecureStore(), userId: USER });
  stacks.push(stack);
  return stack;
}

async function setupTwoProviders(): Promise<{
  db: Database.Database;
  stack: AiStack;
  providerAId: string;
  providerBId: string;
}> {
  const db = openDb(':memory:');
  const stack = buildStack(db);
  const providerA = await stack.control.createProvider({
    name: '渠道A',
    protocol: 'openai',
    baseUrl: 'https://a.example.com/v1',
  });
  const providerB = await stack.control.createProvider({
    name: '渠道B',
    protocol: 'openai',
    baseUrl: 'https://b.example.com/v1',
  });
  return { db, stack, providerAId: providerA.id, providerBId: providerB.id };
}

describe('A/B Provider 同 modelId：复合路由身份隔离（V2-T02）', () => {
  it('同名模型各自独立保存/编辑/删除，providerModelId 互不相同，重复添加幂等', async () => {
    const { stack, providerAId, providerBId } = await setupTwoProviders();

    const modelA = stack.control.addManualModel(providerAId, 'shared-model');
    const modelB = stack.control.addManualModel(providerBId, 'shared-model');

    expect(modelA.id).not.toBe(modelB.id);
    expect(modelA.providerModelId).toBe(`${providerAId}:shared-model`);
    expect(modelB.providerModelId).toBe(`${providerBId}:shared-model`);

    // 同一条路由重复添加：幂等返回同一行，不产生重复（数据库唯一约束兜底）
    const again = stack.control.addManualModel(providerAId, 'shared-model');
    expect(again.id).toBe(modelA.id);
    expect(stack.models.list(providerAId)).toHaveLength(1);

    // 独立编辑：改 A 的能力不影响 B
    stack.control.updateCapability(modelA.id, { contextWindow: 123_456 });
    expect(stack.models.findById(modelA.id)?.capability.contextWindow).toBe(123_456);
    expect(stack.models.findById(modelB.id)?.capability.contextWindow).not.toBe(123_456);

    // 独立删除：删 B 的模型不影响 A
    expect(stack.models.remove(modelB.id)).toBe(true);
    expect(stack.models.findById(modelA.id)).not.toBeNull();
    expect(stack.models.list(providerBId)).toHaveLength(0);
  });

  it('用途绑定与默认路由指向不同渠道的同名模型时，网关解析不串路由', async () => {
    const { db, stack, providerAId, providerBId } = await setupTwoProviders();
    const modelA = stack.control.addManualModel(providerAId, 'shared-model');
    const modelB = stack.control.addManualModel(providerBId, 'shared-model');

    stack.control.saveBinding({
      bindings: { code: modelA.id, 'commit-msg': modelB.id },
      useDefaultForAll: false,
      defaultModelId: modelB.id,
    });

    // 与网关同一条解析链：readiness 报告每用途的实际 Provider+Model
    const readiness = stack.control.readiness();
    const byPurpose = new Map(readiness.purposes.map((item) => [item.purpose, item]));
    expect(byPurpose.get('code')).toMatchObject({
      modelName: 'shared-model',
      providerName: '渠道A',
    });
    expect(byPurpose.get('commit-msg')).toMatchObject({
      modelName: 'shared-model',
      providerName: '渠道B',
    });
    // 未绑定的用途走默认模型（渠道B 的那一行）
    expect(byPurpose.get('requirement')).toMatchObject({
      modelName: 'shared-model',
      providerName: '渠道B',
    });

    expect(stack.gateway.describeModel(USER, 'code')?.providerId).toBe(providerAId);
    expect(stack.gateway.describeModel(USER, 'commit-msg')?.providerId).toBe(providerBId);
    expect(stack.gateway.describeModel(USER, 'requirement')?.providerId).toBe(providerBId);

    // 悬空绑定：指向已删除模型的绑定不落到任何同名替身上，回退走默认路由
    const doomed = stack.control.addManualModel(providerAId, 'doomed-model');
    stack.models.remove(doomed.id);
    expect(stack.gateway.describeModel(USER, 'requirement')?.providerId).toBe(providerBId);
    const stored = new PurposeBindingRepo(db).get(USER);
    expect(stored.bindings.code).toBe(modelA.id);
    expect(stored.bindings['commit-msg']).toBe(modelB.id);
  });

  it('重启（关库重开）后路由身份与绑定保持一致，不混淆', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ec-route-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'route.sqlite');
    const db = openDb(dbPath);
    const stack = buildStack(db);
    const providerA = await stack.control.createProvider({
      name: '渠道A',
      protocol: 'openai',
      baseUrl: 'https://a.example.com/v1',
    });
    const providerB = await stack.control.createProvider({
      name: '渠道B',
      protocol: 'openai',
      baseUrl: 'https://b.example.com/v1',
    });
    const modelA = stack.control.addManualModel(providerA.id, 'shared-model');
    const modelB = stack.control.addManualModel(providerB.id, 'shared-model');
    stack.control.saveBinding({
      bindings: { code: modelA.id },
      useDefaultForAll: false,
      defaultModelId: modelB.id,
    });
    db.close();

    const stack2 = buildStack(openDb(dbPath, false));
    const routes = stack2.models
      .listAll()
      .map((model) => model.providerModelId)
      .sort();
    expect(routes).toEqual([`${providerA.id}:shared-model`, `${providerB.id}:shared-model`].sort());
    expect(stack2.gateway.describeModel(USER, 'code')).toMatchObject({
      providerId: providerA.id,
      modelId: modelA.id,
    });
    expect(stack2.gateway.describeModel(USER, 'requirement')).toMatchObject({
      providerId: providerB.id,
    });
  });

  it('远程刷新不覆盖本地配置；默认模型名命中多渠道时不按名字猜，唯一命中才绑定', async () => {
    const { stack, providerAId, providerBId } = await setupTwoProviders();
    const soloA = stack.control.addManualModel(providerAId, 'a-solo-model');
    stack.control.addManualModel(providerAId, 'shared-model');
    stack.control.addManualModel(providerBId, 'shared-model');
    const uniqueB = stack.control.addManualModel(providerBId, 'unique-b-model');
    stack.control.saveBinding({
      bindings: {},
      useDefaultForAll: false,
      defaultModelId: soloA.id,
    });
    const baseUrlA = stack.providers.findById(providerAId)?.baseUrl;

    const revisions: Array<Record<string, unknown>> = [];
    const server = await startMockServer([
      {
        method: 'GET',
        path: '/config.json',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(revisions.shift() ?? { revision: 'rev-0', providers: [] }));
        },
      },
    ]);
    servers.push(server);
    const source = stack.control.createRemoteSource({
      name: '团队配置',
      url: `${server.url}/config.json`,
      enabled: true,
    });

    // rev-1：远程默认模型名同时存在于渠道A/B → 歧义；同名本地服务绝不被远程覆盖
    revisions.push({
      revision: 'rev-1',
      defaultModel: 'shared-model',
      providers: [
        {
          name: '渠道A',
          protocol: 'openai',
          baseUrl: 'https://evil.example.com/v1',
          models: ['shared-model'],
        },
      ],
    });
    await stack.control.fetchRemoteSource(source.id);
    const plan1 = await stack.control.applyRemoteSource(source.id, { ackDefaultModel: true });

    expect(stack.providers.findById(providerAId)?.baseUrl).toBe(baseUrlA);
    expect(stack.providers.findById(providerAId)?.source).toBe('custom');
    expect(plan1.defaultModelChange).toMatchObject({
      after: 'shared-model',
      resolution: 'ambiguous',
    });
    expect(stack.control.getBinding().defaultModelId).toBe(soloA.id);

    // rev-2：默认模型名只在渠道B 存在 → 唯一命中，绑定渠道B 的路由
    revisions.push({ revision: 'rev-2', defaultModel: 'unique-b-model', providers: [] });
    await stack.control.fetchRemoteSource(source.id);
    const plan2 = await stack.control.applyRemoteSource(source.id, { ackDefaultModel: true });
    expect(plan2.defaultModelChange).toMatchObject({
      after: 'unique-b-model',
      resolution: 'applied',
    });
    expect(stack.control.getBinding().defaultModelId).toBe(uniqueB.id);
  });

  it('同名模型换渠道的默认路由：提示完整路由变化，确认换绑、拒绝保持、无处解析不猜（V2-D00）', async () => {
    const { stack, providerAId, providerBId } = await setupTwoProviders();
    const modelA = stack.control.addManualModel(providerAId, 'shared-model');
    const modelB = stack.control.addManualModel(providerBId, 'shared-model');
    stack.control.saveBinding({
      bindings: {},
      useDefaultForAll: false,
      defaultModelId: modelA.id,
    });
    // 本地渠道C 存在但没有 shared-model：用于「指名渠道内无处解析」
    const providerC = await stack.control.createProvider({
      name: '渠道C',
      protocol: 'openai',
      baseUrl: 'https://c.example.com/v1',
    });
    stack.control.addManualModel(providerC.id, 'c-only-model');

    const revisions: Array<Record<string, unknown>> = [];
    const server = await startMockServer([
      {
        method: 'GET',
        path: '/config.json',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(revisions.shift() ?? { revision: 'rev-0', providers: [] }));
        },
      },
    ]);
    servers.push(server);
    const source = stack.control.createRemoteSource({
      name: '团队配置',
      url: `${server.url}/config.json`,
      enabled: true,
    });

    // rev-1：渠道B 声明同名默认模型 → 完整路由变化必须提示（旧实现只比名字，漏报为 null）
    revisions.push({
      revision: 'rev-b',
      providers: [
        {
          name: '渠道A',
          protocol: 'openai',
          baseUrl: 'https://a.example.com/v1',
          models: ['shared-model'],
        },
        {
          name: '渠道B',
          protocol: 'openai',
          baseUrl: 'https://b.example.com/v1',
          models: ['shared-model'],
          defaultModel: 'shared-model',
        },
      ],
    });
    await stack.control.fetchRemoteSource(source.id);
    const preview = await stack.control.previewRemoteSource(source.id);
    expect(preview.plan?.defaultModelChange).toMatchObject({
      before: 'shared-model',
      after: 'shared-model',
      providerName: '渠道B',
      providerSwitch: { from: '渠道A', to: '渠道B' },
    });

    // 未确认不切换：resolution=pending，绑定仍在原渠道 A
    const planPending = await stack.control.applyRemoteSource(source.id, {});
    expect(planPending.defaultModelChange).toMatchObject({
      resolution: 'pending',
      providerSwitch: { from: '渠道A', to: '渠道B' },
    });
    expect(stack.control.getBinding().defaultModelId).toBe(modelA.id);

    // 确认后绑定渠道B 的同名路由；远程目录引用（colon 句柄）指向 B
    const planApplied = await stack.control.applyRemoteSource(source.id, {
      ackDefaultModel: true,
    });
    expect(planApplied.defaultModelChange).toMatchObject({
      resolution: 'applied',
      providerModelId: `${providerBId}:shared-model`,
    });
    expect(stack.control.getBinding().defaultModelId).toBe(modelB.id);

    // 真实 model 行无歧义转换到公共用量/价格路由（core v2 slash 键绑 ULID，不含模型名），
    // 且能与 colon 句柄经单点转换互相对应
    const boundRow = stack.models.findById(modelB.id);
    expect(boundRow).not.toBeNull();
    const route = routeOfModel({
      id: modelB.id,
      providerId: providerBId,
      name: boundRow?.name ?? 'shared-model',
    });
    const usageKey = persistentRouteKeyOf(route);
    expect(usageKey).toBe(`${providerBId}/${modelB.id}`);
    expect(parseProviderModelKey(usageKey)).toEqual({
      providerId: providerBId,
      modelId: modelB.id,
    });
    expect(coreRouteOfModelRoute(route)).toEqual({ providerId: providerBId, modelId: modelB.id });
    expect(
      modelRouteOfCoreRoute({ providerId: providerBId, modelId: modelB.id }, 'shared-model')
        ?.providerModelId,
    ).toBe(`${providerBId}:shared-model`);

    // rev-2：远程指名渠道C 的同名默认模型，但渠道C 内没有该模型 → missing，绑定保持渠道B，不回退全局猜 A
    revisions.push({
      revision: 'rev-missing',
      providers: [
        {
          name: '渠道A',
          protocol: 'openai',
          baseUrl: 'https://a.example.com/v1',
          models: ['shared-model'],
        },
        {
          name: '渠道C',
          protocol: 'openai',
          baseUrl: 'https://c.example.com/v1',
          models: ['c-only-model'],
          defaultModel: 'shared-model',
        },
      ],
    });
    await stack.control.fetchRemoteSource(source.id);
    const planMissing = await stack.control.applyRemoteSource(source.id, { ackDefaultModel: true });
    expect(planMissing.defaultModelChange).toMatchObject({
      providerSwitch: { from: '渠道B', to: '渠道C' },
      resolution: 'missing',
    });
    expect(stack.control.getBinding().defaultModelId).toBe(modelB.id);
  });

  it('目录来源区分：远程配置创建的 Provider 标记 platform；用量按路由分开记账', async () => {
    const { db, stack, providerAId, providerBId } = await setupTwoProviders();
    const modelA = stack.control.addManualModel(providerAId, 'shared-model');
    const modelB = stack.control.addManualModel(providerBId, 'shared-model');

    const server = await startMockServer([
      {
        method: 'GET',
        path: '/config.json',
        body: JSON.stringify({
          revision: 'rev-9',
          providers: [
            {
              name: '目录中转',
              protocol: 'openai',
              baseUrl: 'https://catalog.example.com/v1',
              models: ['catalog-model'],
            },
          ],
        }),
      },
    ]);
    servers.push(server);
    const source = stack.control.createRemoteSource({
      name: '目录',
      url: `${server.url}/config.json`,
      enabled: true,
    });
    await stack.control.fetchRemoteSource(source.id);
    await stack.control.applyRemoteSource(source.id, {});
    const created = stack.providers.list(USER).find((provider) => provider.name === '目录中转');
    expect(created?.source).toBe('platform');

    // 用量按路由分开：同一模型名在 A/B 各自成桶；无模型的历史保留 unknown 桶，不猜
    const usage = new UsageRepo(db);
    usage.record({
      userId: USER,
      providerId: providerAId,
      modelId: modelA.id,
      promptTokens: 10,
      completionTokens: 5,
      cost: 0.1,
    });
    usage.record({
      userId: USER,
      providerId: providerBId,
      modelId: modelB.id,
      promptTokens: 20,
      completionTokens: 1,
      cost: 0.2,
    });
    usage.record({ userId: USER, promptTokens: 3, completionTokens: 3, cost: null });
    const now = Date.now();
    const byModel = usage.byModel(USER, now - 60_000, now + 60_000);
    expect(byModel).toHaveLength(3);
    const buckets = new Map(byModel.map((row) => [row.modelId, row.totals.totalTokens]));
    expect(buckets.get(modelA.id)).toBe(15);
    expect(buckets.get(modelB.id)).toBe(21);
    expect(buckets.get('(未记录)')).toBe(6);
  });
});
