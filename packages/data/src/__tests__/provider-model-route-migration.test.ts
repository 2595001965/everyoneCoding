import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { DataClient, Migrator, loadMigrations } from '../index';

/**
 * V2-T02 迁移 0008（provider_model_route）验收：
 * - 历史真实数据迁移：provider.source 回填、model.provider_model_id 回填、canonical 列就位
 * - 跨 Provider 同名模型绝不合并；同 Provider 内同一路由的重复行合并且引用精确改指
 * - 唯一约束在数据库层把关；迁移可回退（down 后 schema 回到 0007，数据不丢）
 */

const USER = 'USER0000000000000000000000';
const PROVIDER_A = 'PRV-A00000000000000000000000';
const PROVIDER_B = 'PRV-B00000000000000000000000';
const PROVIDER_C = 'PRV-C00000000000000000000000';
const MODEL_A = 'MDL-A000000000000000000000000';
const MODEL_B = 'MDL-B000000000000000000000000';
/** 与 MODEL_A 同 Provider 同名的历史重复行（旧 addManualModel 缺陷可能产生） */
const MODEL_A_DUP = 'MDL-A2000000000000000000000000';
const USAGE_DUP = 'USG-DUP00000000000000000000000';
const USAGE_NULL = 'USG-NUL00000000000000000000000';
const CONFIG_ID = 'CFG-0000000000000000000000000';

let client: DataClient;
let db: Database.Database;

function migrateTo7(): void {
  new Migrator(db, loadMigrations()).up(7);
}

function seedLegacy(): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO user (id, login, display_name, role, created_at, updated_at)
     VALUES (?, 'legacy', '迁移用户', 'owner', ?, ?)`,
  ).run(USER, now, now);
  const provider = db.prepare(
    `INSERT INTO provider (id, user_id, name, protocol, base_url, created_at, updated_at)
     VALUES (?, ?, ?, 'openai', ?, ?, ?)`,
  );
  provider.run(PROVIDER_A, USER, '渠道A', 'https://a.example.com/v1', now, now);
  provider.run(PROVIDER_B, USER, '渠道B', 'https://b.example.com/v1', now, now);

  const model = db.prepare(
    `INSERT INTO model (id, provider_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  model.run(MODEL_A, PROVIDER_A, 'shared-model', now - 100, now - 100);
  // 同 Provider 同名重复行：created_at 更晚，迁移后应并入 MODEL_A
  model.run(MODEL_A_DUP, PROVIDER_A, 'shared-model', now - 50, now - 50);
  // 跨 Provider 同名模型：迁移后必须保留，绝不合并
  model.run(MODEL_B, PROVIDER_B, 'shared-model', now - 10, now - 10);

  const usage = db.prepare(
    `INSERT INTO usage_record (id, user_id, provider_id, model_id, prompt_tokens, completion_tokens, total_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  usage.run(USAGE_DUP, USER, PROVIDER_A, MODEL_A_DUP, 10, 5, 15, now);
  usage.run(USAGE_NULL, USER, PROVIDER_A, null, 7, 3, 10, now);

  db.prepare(
    `INSERT INTO ai_model_config (id, user_id, purpose_bindings_json, use_default_for_all, default_model_id, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    CONFIG_ID,
    USER,
    JSON.stringify({ code: MODEL_A_DUP, 'commit-msg': MODEL_B }),
    MODEL_A_DUP,
    now,
    now,
  );
}

beforeEach(() => {
  client = DataClient.open({ filePath: ':memory:' });
  db = client.raw;
  migrateTo7();
  seedLegacy();
});

describe('迁移 0008：Provider+Model 复合路由身份', () => {
  it('up：回填 source/provider_model_id，同名模型按 Provider 隔离，重复行合并且引用精确改指', () => {
    new Migrator(db, loadMigrations()).up();

    // 历史行如实回填 custom，不猜
    const sources = db.prepare('SELECT id, source FROM provider ORDER BY id').all() as Array<{
      id: string;
      source: string;
    }>;
    expect(sources).toEqual([
      { id: PROVIDER_A, source: 'custom' },
      { id: PROVIDER_B, source: 'custom' },
    ]);

    // 跨 Provider 同名模型全部保留，复合路由键互不相同
    const rows = db
      .prepare(
        'SELECT id, provider_id, name, provider_model_id, canonical_vendor FROM model ORDER BY id',
      )
      .all() as Array<{
      id: string;
      provider_id: string;
      name: string;
      provider_model_id: string;
      canonical_vendor: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id).sort()).toEqual([MODEL_A, MODEL_B].sort());
    expect(rows.find((row) => row.id === MODEL_A)?.provider_model_id).toBe(
      `${PROVIDER_A}:shared-model`,
    );
    expect(rows.find((row) => row.id === MODEL_B)?.provider_model_id).toBe(
      `${PROVIDER_B}:shared-model`,
    );
    expect(rows.every((row) => row.canonical_vendor === null)).toBe(true);

    // 重复行引用精确改指存活行；model_id 为 NULL 的历史保留 unknown，不猜
    const usage = db.prepare('SELECT id, model_id FROM usage_record ORDER BY id').all() as Array<{
      id: string;
      model_id: string | null;
    }>;
    expect(usage.find((row) => row.id === USAGE_DUP)?.model_id).toBe(MODEL_A);
    expect(usage.find((row) => row.id === USAGE_NULL)?.model_id).toBeNull();

    // 用途绑定与默认路由同样改指存活行，跨 Provider 的绑定不变
    const config = db
      .prepare('SELECT purpose_bindings_json, default_model_id FROM ai_model_config WHERE id = ?')
      .get(CONFIG_ID) as { purpose_bindings_json: string; default_model_id: string | null };
    expect(JSON.parse(config.purpose_bindings_json)).toEqual({
      code: MODEL_A,
      'commit-msg': MODEL_B,
    });
    expect(config.default_model_id).toBe(MODEL_A);
  });

  it('up：数据库唯一约束拒绝同 Provider 重复路由，仍允许跨 Provider 同名', () => {
    new Migrator(db, loadMigrations()).up();
    const now = Date.now();

    db.prepare(
      `INSERT INTO provider (id, user_id, name, protocol, base_url, created_at, updated_at)
       VALUES (?, ?, '渠道C', 'openai', 'https://c.example.com/v1', ?, ?)`,
    ).run(PROVIDER_C, USER, now, now);

    // 与渠道A同名同模型：违反 (provider_id, name) 唯一约束
    expect(() =>
      db
        .prepare(
          `INSERT INTO model (id, provider_id, name, created_at, updated_at) VALUES ('MDL-X000000000000000000000000', ?, 'shared-model', ?, ?)`,
        )
        .run(PROVIDER_A, now, now),
    ).toThrow();
    // 复合路由键唯一约束同样拒绝：名字不同但 provider_model_id 撞已有路由
    expect(() =>
      db
        .prepare(
          `INSERT INTO model (id, provider_id, name, provider_model_id, created_at, updated_at) VALUES ('MDL-Y000000000000000000000000', ?, 'other-model', ?, ?, ?)`,
        )
        .run(PROVIDER_C, `${PROVIDER_A}:shared-model`, now, now),
    ).toThrow();
    // 渠道C 建同名模型：合法（不同路由）
    expect(() =>
      db
        .prepare(
          `INSERT INTO model (id, provider_id, name, created_at, updated_at) VALUES ('MDL-Z000000000000000000000000', ?, 'shared-model', ?, ?)`,
        )
        .run(PROVIDER_C, now, now),
    ).not.toThrow();
  });

  it('down 后 schema 回到 0007，再 up 可重复应用（迁移可回滚）', () => {
    const migrator = new Migrator(
      db,
      loadMigrations().filter((migration) => migration.version <= 8),
    );
    migrator.up();
    migrator.down(1);

    const modelColumns = db.prepare('PRAGMA table_info(model)').all() as Array<{ name: string }>;
    const names = modelColumns.map((column) => column.name);
    expect(names).not.toContain('provider_model_id');
    expect(names).not.toContain('canonical_vendor');
    expect(names).not.toContain('canonical_model');
    const providerColumns = db.prepare('PRAGMA table_info(provider)').all() as Array<{
      name: string;
    }>;
    expect(providerColumns.map((column) => column.name)).not.toContain('source');

    // 数据仍在：跨 Provider 同名模型与改指后的引用不受回退影响
    const models = db.prepare('SELECT COUNT(*) AS n FROM model').get() as { n: number };
    expect(models.n).toBe(2);
    const config = db
      .prepare('SELECT purpose_bindings_json FROM ai_model_config WHERE id = ?')
      .get(CONFIG_ID) as { purpose_bindings_json: string };
    expect(JSON.parse(config.purpose_bindings_json)).toEqual({
      code: MODEL_A,
      'commit-msg': MODEL_B,
    });

    // 再次升级：幂等可重复应用
    migrator.up();
    const again = db
      .prepare('SELECT COUNT(*) AS n FROM model WHERE provider_model_id IS NOT NULL')
      .get() as { n: number };
    expect(again.n).toBe(2);
  });
});
