import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';

import { ApiKeyStore } from '../../secure/api-key-store';
import { ProviderRepo } from '../../repo/provider-repo';
import { ModelRepo } from '../../repo/model-repo';
import { PurposeBindingRepo } from '../../repo/purpose-binding-repo';
import { UsageRepo } from '../../repo/usage-repo';
import { RemoteConfigRepo } from '../../repo/remote-config-repo';
import { BudgetGuard } from '../../gateway/budget';
import { UsageTracker } from '../../gateway/usage-tracker';
import { withBinding, resolveModelId } from '../../domain/purpose-binding';
import { openTestDb, testSecureStore, insertUser } from '../../__tests__/helpers';

/**
 * T1-01 验收：Provider CRUD、Key 只存引用、能力矩阵可修正、用途绑定、非法 baseUrl 被拒。
 */

const USER = 'USER0000000000000000000000';

let db: Database;
let providers: ProviderRepo;
let models: ModelRepo;
let bindings: PurposeBindingRepo;
let keys: ApiKeyStore;

beforeEach(() => {
  db = openTestDb();
  insertUser(db, USER);
  keys = new ApiKeyStore(testSecureStore());
  providers = new ProviderRepo(db, keys);
  models = new ModelRepo(db);
  bindings = new PurposeBindingRepo(db);
});

describe('Provider 仓库', () => {
  it('新建后 Key 在 DB 中只留引用，明文只在密钥环', async () => {
    const created = await providers.create({
      userId: USER,
      name: '我的中转',
      protocol: 'openai',
      baseUrl: 'https://relay.example.com/v1',
      // 模拟渲染层流程：先写密钥环拿引用名，再交引用名入库
      keyRef: await keys.saveRef('temp-draft-1', 'sk-super-secret-key-000000000000'),
    });

    const row = db.prepare('SELECT * FROM provider WHERE id = ?').get(created.id) as Record<
      string,
      unknown
    >;
    const dump = JSON.stringify(row);
    expect(dump).not.toContain('sk-super-secret-key-000000000000');
    // api_key_ref 指向 secure_ref 的一条引用记录，本身不含明文
    expect(typeof row['api_key_ref']).toBe('string');
    const ref = db.prepare('SELECT * FROM secure_ref WHERE id = ?').get(row['api_key_ref']) as
      Record<string, unknown> | undefined;
    expect(ref).toBeDefined();
    expect(JSON.stringify(ref ?? {})).not.toContain('sk-super-secret-key-000000000000');
    expect(String(ref?.['ref_path'])).toContain(created.id);

    // 明文可经密钥环取回
    expect(await providers.getApiKey(created.id)).toBe('sk-super-secret-key-000000000000');
  });

  it('非法 baseUrl 被 zod 拦截（非 http/https 直接拒绝）', async () => {
    await expect(
      providers.create({
        userId: USER,
        name: 'x',
        protocol: 'openai',
        baseUrl: 'ftp://bad.example.com',
      }),
    ).rejects.toThrow();
    await expect(
      providers.create({ userId: USER, name: 'x', protocol: 'openai', baseUrl: 'not-a-url' }),
    ).rejects.toThrow();
  });

  it('超时必须落在 1~600 秒区间', async () => {
    await expect(
      providers.create({
        userId: USER,
        name: 'x',
        protocol: 'openai',
        baseUrl: 'https://a.com',
        timeoutMs: 100,
      }),
    ).rejects.toThrow();
    await expect(
      providers.create({
        userId: USER,
        name: 'x',
        protocol: 'openai',
        baseUrl: 'https://a.com',
        timeoutMs: 900_000,
      }),
    ).rejects.toThrow();
  });

  it('更新走乐观锁：版本不符抛 ConflictError', async () => {
    const created = await providers.create({
      userId: USER,
      name: 'p',
      protocol: 'openai',
      baseUrl: 'https://a.com',
    });
    await providers.update(created.id, { name: 'p2' }, created.version);
    await expect(providers.update(created.id, { name: 'p3' }, created.version)).rejects.toThrow();
  });

  it('删除 Provider 同时清掉密钥环中的 Key', async () => {
    const created = await providers.create({
      userId: USER,
      name: 'p',
      protocol: 'openai',
      baseUrl: 'https://a.com',
      keyRef: await keys.saveRef('temp-draft-2', 'sk-to-be-removed'),
    });
    expect(await keys.has(created.id)).toBe(true);
    await providers.remove(created.id);
    expect(await keys.has(created.id)).toBe(false);
    expect(providers.findById(created.id)).toBeNull();
  });

  it('列表按 sort_order 升序，reorder 可重排', async () => {
    const a = await providers.create({
      userId: USER,
      name: 'A',
      protocol: 'openai',
      baseUrl: 'https://a.com',
    });
    const b = await providers.create({
      userId: USER,
      name: 'B',
      protocol: 'openai',
      baseUrl: 'https://b.com',
    });
    providers.reorder([b.id, a.id]);
    expect(providers.list(USER).map((item) => item.name)).toEqual(['B', 'A']);
  });

  it('停用后 enabledOnly 查询不再返回', async () => {
    const created = await providers.create({
      userId: USER,
      name: 'A',
      protocol: 'openai',
      baseUrl: 'https://a.com',
    });
    providers.setEnabled(created.id, false);
    expect(providers.list(USER, { enabledOnly: true })).toHaveLength(0);
    expect(providers.list(USER)).toHaveLength(1);
  });

  it('凭据类自定义请求头被拒绝（不得明文落库）', async () => {
    for (const name of ['Authorization', 'x-api-key', 'api-key', 'access_token', 'cookie']) {
      await expect(
        providers.create({
          userId: USER,
          name: 'A',
          protocol: 'openai',
          baseUrl: 'https://a.com',
          headers: { [name]: 'Bearer sk-leak' },
        }),
      ).rejects.toThrow();
    }
    // 非凭据头照常放行
    const ok = await providers.create({
      userId: USER,
      name: 'A',
      protocol: 'openai',
      baseUrl: 'https://a.com',
      headers: { 'HTTP-Referer': 'https://example.com' },
    });
    expect(ok.headers['HTTP-Referer']).toBe('https://example.com');
  });

  it('历史脏数据里的凭据头在读取时被过滤', async () => {
    const created = await providers.create({
      userId: USER,
      name: 'A',
      protocol: 'openai',
      baseUrl: 'https://a.com',
    });
    db.prepare('UPDATE provider SET headers_json = ? WHERE id = ?').run(
      JSON.stringify({ Authorization: 'Bearer sk-old-leak', 'X-Title': 'keep' }),
      created.id,
    );
    const reloaded = providers.findById(created.id);
    expect(reloaded?.headers['Authorization']).toBeUndefined();
    expect(reloaded?.headers['X-Title']).toBe('keep');
  });

  it('Key 引用失效时保存被拒，不写半截记录', async () => {
    await expect(
      providers.create({
        userId: USER,
        name: 'A',
        protocol: 'openai',
        baseUrl: 'https://a.com',
        keyRef: 'temp-missing',
      }),
    ).rejects.toThrow('Key 引用已失效');
    expect(providers.list(USER)).toHaveLength(0);
  });
});

describe('模型能力矩阵', () => {
  it('能力修正可持久化并打上 manualOverride', async () => {
    const provider = await providers.create({
      userId: USER,
      name: 'A',
      protocol: 'openai',
      baseUrl: 'https://a.com',
    });
    const model = models.create(provider.id, 'gpt-4o');

    models.updateCapability(model.id, {
      contextWindow: 128_000,
      inputPricePerMTok: 2.5,
      outputPricePerMTok: 10,
    });

    const reloaded = models.findById(model.id);
    expect(reloaded?.capability.contextWindow).toBe(128_000);
    expect(reloaded?.capability.inputPricePerMTok).toBe(2.5);
    expect(reloaded?.capability.manualOverride).toBe(true);
  });

  it('远程拉取不覆盖人工修正项', async () => {
    const provider = await providers.create({
      userId: USER,
      name: 'A',
      protocol: 'openai',
      baseUrl: 'https://a.com',
    });
    const model = models.create(provider.id, 'gpt-4o');
    models.updateCapability(model.id, { contextWindow: 200_000 });

    models.upsertDiscovered(provider.id, {
      source: 'remote',
      models: [
        {
          ...models.findById(model.id)!,
          capability: { ...models.findById(model.id)!.capability, contextWindow: 8_000 },
        },
      ],
    });

    expect(models.findById(model.id)?.capability.contextWindow).toBe(200_000);
  });

  it('远程拉取新增模型中未修正过的项', async () => {
    const provider = await providers.create({
      userId: USER,
      name: 'A',
      protocol: 'openai',
      baseUrl: 'https://a.com',
    });
    const base = models.create(provider.id, 'gpt-4o');
    const result = models.upsertDiscovered(provider.id, {
      source: 'remote',
      models: [{ ...base, id: 'new', name: 'gpt-4o-mini' }],
    });
    expect(result.created).toBe(1);
    expect(models.list(provider.id).map((item) => item.name)).toContain('gpt-4o-mini');
  });
});

describe('用途化模型绑定', () => {
  it('六类用途可分别绑定，默认开关生效', async () => {
    const provider = await providers.create({
      userId: USER,
      name: 'A',
      protocol: 'openai',
      baseUrl: 'https://a.com',
    });
    const defaultModel = models.create(provider.id, 'gpt-default');
    const codeModel = models.create(provider.id, 'gpt-code');

    const binding = bindings.get(USER);
    expect(binding.useDefaultForAll).toBe(true);

    const withCode = withBinding(
      { ...binding, defaultModelId: defaultModel.id },
      'code',
      codeModel.id,
    );
    const saved = bindings.save(USER, withCode);

    expect(saved.bindings['code']).toBe(codeModel.id);
    // 开关打开时全部用途走默认模型
    expect(resolveModelId(saved, 'code')).toBe(defaultModel.id);

    const off = bindings.setUseDefaultForAll(USER, false);
    expect(resolveModelId(off, 'code')).toBe(codeModel.id);
    expect(resolveModelId(off, 'techdoc')).toBe(defaultModel.id);
  });

  it('绑定持久化后可读回', async () => {
    const provider = await providers.create({
      userId: USER,
      name: 'A',
      protocol: 'openai',
      baseUrl: 'https://a.com',
    });
    const memModel = models.create(provider.id, 'gpt-mem');
    bindings.setBinding(USER, 'memory-extract', memModel.id);
    const reloaded = bindings.get(USER);
    expect(reloaded.bindings['memory-extract']).toBe(memModel.id);
  });
});

describe('用量与预算', () => {
  it('用量落库并按月汇总', () => {
    const usageRepo = new UsageRepo(db);
    const budget = new BudgetGuard(usageRepo, USER, { monthlyUsd: 1 });
    const tracker = new UsageTracker(usageRepo, budget);

    tracker.record({
      userId: USER,
      providerId: null,
      modelId: null,
      purpose: 'code',
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
      price: { inputPricePerMTok: 1, outputPricePerMTok: 1 },
      latencyMs: 123,
    });

    const monthly = tracker.monthly(USER);
    expect(monthly.totalTokens).toBe(2_000_000);
    expect(monthly.cost).toBeCloseTo(2, 6);
    expect(monthly.requests).toBe(1);
    expect(monthly.complete).toBe(true);
  });

  it('单价缺失时标记为不完整，费用按 0 累计', () => {
    const usageRepo = new UsageRepo(db);
    const tracker = new UsageTracker(usageRepo, new BudgetGuard(usageRepo, USER));
    tracker.record({
      userId: USER,
      providerId: null,
      modelId: null,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      price: { inputPricePerMTok: null, outputPricePerMTok: null },
      latencyMs: 1,
    });
    expect(tracker.monthly(USER).complete).toBe(false);
  });

  it('月度预算超限后拒绝并给出明确提示', () => {
    const usageRepo = new UsageRepo(db);
    const budget = new BudgetGuard(usageRepo, USER, { monthlyUsd: 0.5 });
    const tracker = new UsageTracker(usageRepo, budget);
    const events: string[] = [];
    tracker.onEvent((event) => events.push(event.type));

    tracker.record({
      userId: USER,
      providerId: null,
      modelId: null,
      usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
      price: { inputPricePerMTok: 1, outputPricePerMTok: 1 },
      latencyMs: 1,
    });

    const decision = budget.check();
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.message).toContain('本月预算已用尽');
    expect(events).toContain('budget-exceeded');
  });
});

describe('远程配置源仓库', () => {
  it('CRUD 与拉取结果记录', () => {
    const repo = new RemoteConfigRepo(db);
    const source = repo.create({
      userId: USER,
      name: '团队配置',
      url: 'https://cfg.example.com/ai.json',
    });
    expect(source.enabled).toBe(false);
    expect(repo.list(USER)).toHaveLength(1);

    repo.update(source.id, { enabled: true, publicKey: 'BASE64PUBKEY' });
    expect(repo.findById(source.id)?.enabled).toBe(true);

    repo.recordFetch(source.id, { status: 'success', payloadJson: '{"revision":"1"}' });
    expect(repo.findById(source.id)?.lastStatus).toBe('success');
    expect(repo.findById(source.id)?.lastPayloadJson).toBe('{"revision":"1"}');

    repo.recordFetch(source.id, { status: 'unreachable', error: '连接超时' });
    expect(repo.findById(source.id)?.lastError).toBe('连接超时');

    repo.ackRevision(source.id, '2');
    expect(repo.findById(source.id)?.ackedRevision).toBe('2');

    expect(repo.remove(source.id)).toBe(true);
    expect(repo.list(USER)).toHaveLength(0);
  });
});
