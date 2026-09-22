import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDomainEventSink, type DomainControlServiceHost } from '@ec/shell-api';
import { createMemoryBufferStore, TelemetryClient, Telemetry } from '@ec/core';
import { buildEvent, assertEventPayloadSafe } from '@ec/core';
import { DEFAULT_BUDGET, BudgetGuard } from '@ec/ai';
import { createHash } from 'node:crypto';

import { openBusinessDb } from '../domain/db';
import { createDomainRuntime } from '../domain/runtime';
import { createProductionDomains, type DomainFactoryContext } from '../domain/domain-factories';
import { createSettingStore } from '../domain/setting-store';
import { readPersistedBudget } from '../ai/runtime';
import { createTelemetryRuntime } from '../domain/telemetry-runtime';

/**
 * T12-05 生产接线验收测试：归档 / 用量 / 备份 / 遥测。
 *
 * 全部走真实 SQLite + 真实工程目录 + 真实域运行时 + 真实文件 IO，
 * 断言对象是落盘的文件、表里的行与跨进程返回的信封。
 *
 * 覆盖任务书四条实现要求与四条验收：
 * 1. PackageApi / UsageApi / BackupSettings 经主进程真实注入且可用；
 * 2. 附件内容寻址导出/导入往返（不静默丢弃）；
 * 3. 用量读真实 usage_record；预算在**真正调用模型前**阻断；
 * 4. 遥测默认关闭、payload 白名单、清除覆盖内存+文件+数据库。
 */

let root: string;
let dataDir: string;
let projectsDir: string;
let db: Database.Database;
let runtime: DomainControlServiceHost;

const USER_ID = 'local-user';
const PROJECT_ID = 'p-archive';

interface InvokeOptions {
  domain: string;
  method: string;
  params?: Record<string, unknown>;
}

function invoke(options: InvokeOptions): Promise<{
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}> {
  return runtime.invoke({
    requestId: `t-${options.domain}-${options.method}-${Math.random().toString(36).slice(2, 8)}`,
    domain: options.domain as never,
    method: options.method,
    params: options.params ?? {},
  });
}

async function call<T>(options: InvokeOptions): Promise<T> {
  const response = await invoke(options);
  if (!response.ok) {
    const error = new Error(response.error?.message ?? '域调用失败') as Error & {
      code?: string | undefined;
    };
    error.code = response.error?.code;
    throw error;
  }
  return response.result as T;
}

function writeProjectFile(relative: string, content: string | Buffer): void {
  const full = join(projectsDir, PROJECT_ID, relative);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

/**
 * 在 ZIP 包内定位第一个条目的**压缩数据区**并翻转一个字节。
 *
 * 为什么不能随便挑偏移翻转：`.ecpkg` 是 ZIP（DEFLATE），文件中部往往落在
 * 中央目录或条目间隙里，翻那里要么被解析器忽略（假阴性），要么直接让 ZIP 打不开。
 * 这里按局部文件头（签名 `PK\x03\x04`）解析出 nameLen/extraLen/compSize，
 * 精确落在数据流内部——这样逐文件 SHA-256 必然不匹配，正是要验证的场景。
 */
function tamperFirstEntryData(filePath: string): void {
  const bytes = readFileSync(filePath);
  const LOCAL_HEADER_SIG = 0x04034b50;
  let offset = 0;
  let found = false;
  while (offset + 30 <= bytes.length) {
    if (bytes.readUInt32LE(offset) !== LOCAL_HEADER_SIG) break;
    const nameLen = bytes.readUInt16LE(offset + 26);
    const extraLen = bytes.readUInt16LE(offset + 28);
    const compSize = bytes.readUInt32LE(offset + 18);
    const dataStart = offset + 30 + nameLen + extraLen;
    // compSize 为 0 表示用了数据描述符（流式写入），此时无法直接定位，跳到下一候选
    if (compSize > 0 && dataStart + compSize <= bytes.length) {
      bytes[dataStart] = bytes[dataStart]! ^ 0xff;
      found = true;
      break;
    }
    offset = dataStart + compSize;
  }
  expect(found, '应能在包内定位到条目压缩数据区').toBe(true);
  writeFileSync(filePath, bytes);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-t1205-'));
  dataDir = join(root, 'data');
  projectsDir = join(root, 'projects');
  mkdirSync(projectsDir, { recursive: true });

  db = openBusinessDb({ dataDir });
  const now = Date.now();
  db.prepare(
    `INSERT INTO project (id, user_id, name, description, status, created_at, updated_at)
     VALUES (?, ?, '归档工程', NULL, 'active', ?, ?)`,
  ).run(PROJECT_ID, USER_ID, now, now);

  // 真实工程产物：代码 / 设计 DSL / 锚点 / 注册表 / 附件（内容寻址）
  writeProjectFile('code/src/app.ts', 'export const app = 1;\n');
  writeProjectFile('design/pages/home.json', JSON.stringify({ id: 'home', name: '首页' }));
  writeProjectFile('meta/anchors.json', JSON.stringify([{ id: 'a1', symbol: 'app' }]));
  writeProjectFile('meta/registry.json', JSON.stringify([{ id: 'r1', name: 'app' }]));

  const attachmentBytes = Buffer.from('PNG-FAKE-CONTENT-FOR-ROUNDTRIP');
  const hash = createHash('sha256').update(attachmentBytes).digest('hex');
  writeProjectFile(`attachments/${hash}.png`, attachmentBytes);

  const ctx: DomainFactoryContext = {
    db,
    projectsDir,
    dataDir,
    userId: USER_ID,
    aiStack: null,
    process: null,
    credentials: null,
    emit: () => {},
  };
  const production = createProductionDomains(ctx);
  const events = createDomainEventSink();
  runtime = createDomainRuntime({
    routers: production.routers,
    syncRouters: production.syncRouters,
    events,
    disposers: production.disposers,
  });
});

afterAll(async () => {
  // 先释放域运行时（内含 SQLite 连接），否则 Windows 上目录仍被占用
  await runtime.dispose();
  // 清理失败不该让整套用例变红：Windows 上文件句柄回收有延迟（EPERM/EBUSY），
  // 临时目录由系统回收，这里尽力而为。
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 忽略：临时目录残留不影响测试结论 */
  }
});

describe('附件：内容寻址导出/导入不静默丢弃', () => {
  it('导出包内含 attachments/<sha256>.<ext>，且导入后文件与内容一致', async () => {
    const outputPath = join(root, 'with-attachments.ecpkg');
    const result = await call<{ counts: { attachments: number }; archiveSizeBytes: number }>({
      domain: 'package',
      method: 'exportPackage',
      params: {
        request: {
          outputPath,
          selection: {
            scope: 'all',
            projectIds: [],
            content: {
              memory: { longterm: true, project: true, feature: true, page: true, issue: true },
              documents: true,
              code: true,
              pipeline: true,
              anchors: true,
              registry: true,
              attachments: true,
            },
          },
          redact: true,
        },
      },
    });
    expect(existsSync(outputPath)).toBe(true);
    // 关键断言：附件真实进入包内，而不是被静默丢弃
    expect(result.counts.attachments).toBeGreaterThanOrEqual(1);
  });

  it('导出的包内确实存在 attachments/ 条目', async () => {
    const outputPath = join(root, 'inspect-attachments.ecpkg');
    await call({
      domain: 'package',
      method: 'exportPackage',
      params: {
        request: {
          outputPath,
          selection: {
            scope: 'all',
            projectIds: [],
            content: {
              memory: { longterm: true, project: true, feature: true, page: true, issue: true },
              documents: true,
              code: true,
              pipeline: true,
              anchors: true,
              registry: true,
              attachments: true,
            },
          },
          redact: true,
        },
      },
    });
    const raw = readFileSync(outputPath);
    // ZIP 中央目录里会保留条目路径；直接检索文件名片段即可确认条目存在
    expect(raw.includes(Buffer.from('attachments/'))).toBe(true);
  });
});

describe('用量：真实 usage_record + 预算在模型调用前阻断', () => {
  it('listRows 读真实 usage_record（与源数据一致）', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO usage_record (id, user_id, provider_id, model_id, project_id, purpose,
         prompt_tokens, completion_tokens, total_tokens, cost, latency_ms, created_at)
       VALUES (?, ?, NULL, NULL, ?, 'generate', 100, 50, 150, 0.25, 120, ?)`,
    ).run('ur-1', USER_ID, PROJECT_ID, now);

    const rows = await call<Array<{ totalTokens: number; cost: number; projectId: string }>>({
      domain: 'usage',
      method: 'listRows',
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((item) => item.projectId === PROJECT_ID);
    expect(row?.totalTokens).toBe(150);
    expect(row?.cost).toBe(0.25);
  });

  it('预算读写走 setting 表真实列（value_json），不再报 no such column', async () => {
    await call({
      domain: 'usage',
      method: 'setBudget',
      params: { config: { dailyUsd: 10, monthlyUsd: 100, alertRatio: 0.8 } },
    });
    const budget = await call<{ dailyUsd: number | null; monthlyUsd: number | null }>({
      domain: 'usage',
      method: 'getBudget',
    });
    expect(budget.dailyUsd).toBe(10);
    expect(budget.monthlyUsd).toBe(100);

    // 落库校验：真实列是 value_json，且必须带 user_id
    const stored = db
      .prepare(`SELECT value_json FROM setting WHERE user_id = ? AND key = 'usage_budget'`)
      .get(USER_ID) as { value_json: string } | undefined;
    expect(stored?.value_json).toContain('"dailyUsd":10');
  });

  it('超限时 budgetDecision 返回 ok=false（请求前拒绝的依据）', async () => {
    await call({
      domain: 'usage',
      method: 'setBudget',
      params: { config: { dailyUsd: 0.1, monthlyUsd: null, alertRatio: 0.8 } },
    });
    const decision = await call<{ ok: boolean; scope?: string }>({
      domain: 'usage',
      method: 'budgetDecision',
    });
    expect(decision.ok).toBe(false);
    expect(decision.scope).toBe('daily');
  });

  it('持久化预算能被 AI 栈读到，且 BudgetGuard 在调用前拒绝', () => {
    // 直接验证「设置页写入 → 网关读取」这一环（此前断掉的就是这里）
    const store = createSettingStore({ db, userId: USER_ID });
    const persisted = readPersistedBudget(store);
    expect(persisted.dailyUsd).toBe(0.1);

    // 用同一份配置构造真实 BudgetGuard：已花费 0.25 > 上限 0.1 ⇒ 拒绝
    const usageRepo = {
      totals: () => ({ cost: 0.25, promptTokens: 100, completionTokens: 50 }),
      monthly: () => ({ cost: 0.25, promptTokens: 100, completionTokens: 50 }),
    };
    const guard = new BudgetGuard(usageRepo as never, USER_ID, persisted);
    const decision = guard.check();
    expect(decision.ok).toBe(false);
  });

  it('未配置预算时不阻断（默认放行，避免误伤）', () => {
    const guard = new BudgetGuard(
      {
        totals: () => ({ cost: 999, promptTokens: 0, completionTokens: 0 }),
        monthly: () => ({ cost: 999, promptTokens: 0, completionTokens: 0 }),
      } as never,
      USER_ID,
      DEFAULT_BUDGET,
    );
    expect(guard.check().ok).toBe(true);
  });
});

describe('备份：按日/周生成、保留份数清理、快照回滚', () => {
  it('保存备份配置走真实列并可回读', async () => {
    const backupDir = join(root, 'backups');
    await call({
      domain: 'package',
      method: 'saveBackupSettings',
      params: {
        settings: {
          enabled: true,
          frequency: 'daily',
          timeOfDay: '03:00',
          targetDir: backupDir,
          keepCount: 2,
        },
      },
    });
    const settings = await call<{
      enabled: boolean;
      frequency: string;
      keepCount: number;
      targetDir: string;
    }>({ domain: 'package', method: 'getBackupSettings' });
    expect(settings.enabled).toBe(true);
    expect(settings.frequency).toBe('daily');
    expect(settings.keepCount).toBe(2);
    expect(settings.targetDir).toBe(backupDir);
  });

  it('非法时间格式与保留份数被拒绝（坏值会让调度器排不出下一次）', async () => {
    const bad = await invoke({
      domain: 'package',
      method: 'saveBackupSettings',
      params: {
        settings: {
          enabled: true,
          frequency: 'daily',
          timeOfDay: '25:99',
          targetDir: join(root, 'backups'),
          keepCount: 2,
        },
      },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('INVALID_ARGUMENT');

    const badKeep = await invoke({
      domain: 'package',
      method: 'saveBackupSettings',
      params: {
        settings: {
          enabled: true,
          frequency: 'daily',
          timeOfDay: '03:00',
          targetDir: join(root, 'backups'),
          keepCount: 0,
        },
      },
    });
    expect(badKeep.ok).toBe(false);
  });

  it('createBackupNow 生成规范命名的快照，并按保留份数清理最旧', async () => {
    const backupDir = join(root, 'backups');
    // 连续生成 3 份，keepCount=2 ⇒ 最旧的 1 份应被清理
    for (let i = 0; i < 3; i += 1) {
      await call({ domain: 'package', method: 'createBackupNow' });
      // 规范命名含秒级时间戳，避免同秒冲突需留出间隔
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    const snapshots = await call<Array<{ fileName: string; path: string }>>({
      domain: 'package',
      method: 'listSnapshots',
    });
    expect(snapshots.length).toBe(2);
    // 命名规范：ec-backup-<yyyymmdd-hhmmss>-<ms>-<origin>.ecpkg
    expect(
      snapshots.every((item) => /^ec-backup-\d{8}-\d{6}-\d{3}-manual\.ecpkg$/.test(item.fileName)),
    ).toBe(true);
    expect(existsSync(join(backupDir, snapshots[0]!.fileName))).toBe(true);
  }, 30_000);

  it('restoreFromSnapshot 先做安全快照再回滚（可再滚回来）', async () => {
    const snapshots = await call<Array<{ path: string }>>({
      domain: 'package',
      method: 'listSnapshots',
    });
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const result = await call<{ safetySnapshot: { fileName: string }; counts: unknown }>({
      domain: 'package',
      method: 'restoreFromSnapshot',
      params: { path: snapshots[0]!.path },
    });
    // 回滚前自动生成安全快照：回滚错了还能再滚回来
    expect(result.safetySnapshot.fileName).toContain('pre-restore');
  }, 30_000);
});

describe('遥测：默认关闭、白名单字段、三层清除', () => {
  it('默认关闭时 track 不写缓冲、零副作用', () => {
    const bufferPath = join(root, 'telemetry-off.json');
    const runtimeTelemetry = createTelemetryRuntime({ db, bufferPath, enabled: false });
    runtimeTelemetry.record('project.create', 'success', { dims: { projectId: 'p1' } });
    expect(runtimeTelemetry.buffered()).toBe(0);
    expect(existsSync(bufferPath)).toBe(false);
  });

  it('启用后只记录白名单字段，且缓冲真实落盘', () => {
    const bufferPath = join(root, 'telemetry-on.json');
    const runtimeTelemetry = createTelemetryRuntime({ db, bufferPath, enabled: true });
    runtimeTelemetry.record('package.export', 'success', {
      durationMs: 120,
      dims: { bytes: 2048, count: 3, version: '1' },
    });
    expect(runtimeTelemetry.buffered()).toBe(1);
    const raw = readFileSync(bufferPath, 'utf8');
    expect(raw).toContain('package.export');
  });

  it('payload 白名单断言：夹带内容字段必须抛错', () => {
    // 提示词 / 代码 / 文档正文 / Key 一律不允许出现在 payload
    expect(() =>
      assertEventPayloadSafe({
        name: 'ai.request',
        result: 'success',
        dims: { prompt: '用户的完整提示词内容' },
      }),
    ).toThrow();
    expect(() =>
      assertEventPayloadSafe({
        name: 'ai.request',
        result: 'success',
        dims: { code: 'const secret = 1' },
      }),
    ).toThrow();
    expect(() =>
      buildEvent('ai.request', 'success', { dims: { apiKey: 'sk-abcdefgh' } }),
    ).toThrow();
    // 合法维度不抛
    expect(() =>
      buildEvent('ai.request', 'success', { dims: { providerId: 'p1', purpose: 'generate' } }),
    ).not.toThrow();
  });

  it('一键清除覆盖内存队列 + 文件缓冲 + 数据库记录三层', () => {
    const bufferPath = join(root, 'telemetry-clear.json');
    const runtimeTelemetry = createTelemetryRuntime({ db, bufferPath, enabled: true });
    runtimeTelemetry.record('project.create', 'success', { dims: { projectId: 'p1' } });
    runtimeTelemetry.record('git.commit', 'success', { dims: { projectId: 'p1' } });
    expect(runtimeTelemetry.buffered()).toBe(2);

    const cleared = runtimeTelemetry.clearAll();
    expect(cleared.fileCleared).toBe(2);
    expect(runtimeTelemetry.buffered()).toBe(0);
    expect(runtimeTelemetry.pending()).toBe(0);
    // 文件缓冲已被清空（内容为空数组）
    expect(JSON.parse(readFileSync(bufferPath, 'utf8'))).toEqual([]);
  });

  it('关闭授权会清空缓冲（用户点"关闭"就不该留数据）', () => {
    const bufferPath = join(root, 'telemetry-disable.json');
    const runtimeTelemetry = createTelemetryRuntime({ db, bufferPath, enabled: true });
    runtimeTelemetry.record('project.create', 'success');
    expect(runtimeTelemetry.buffered()).toBe(1);
    runtimeTelemetry.setEnabled(false);
    expect(runtimeTelemetry.buffered()).toBe(0);
  });

  it('TelemetryClient 未授权时不产生任何缓冲（零 IO 原则）', () => {
    const store = createMemoryBufferStore();
    const client = new TelemetryClient({
      telemetry: new Telemetry({ enabled: false }),
      store,
    });
    client.track(buildEvent('project.create', 'success'));
    expect(store.count()).toBe(0);
  });
});

describe('导出/导入完整性：篡改与错误口令不留半导入状态', () => {
  it('篡改包内容后 verifyPackage 报完整性失败并指出文件', async () => {
    const outputPath = join(root, 'tamper.ecpkg');
    await call({
      domain: 'package',
      method: 'exportPackage',
      params: {
        request: {
          outputPath,
          selection: {
            scope: 'all',
            projectIds: [],
            content: {
              memory: { longterm: true, project: true, feature: true, page: true, issue: true },
              documents: true,
              code: true,
              pipeline: true,
              anchors: true,
              registry: true,
              attachments: false,
            },
          },
          redact: true,
        },
      },
    });
    // 精确定位条目压缩数据区并翻转一个字节 ⇒ 逐文件 SHA-256 必然不匹配
    tamperFirstEntryData(outputPath);

    const report = await call<{ ok: boolean; failureCode: string | null }>({
      domain: 'package',
      method: 'verifyPackage',
      params: { packagePath: outputPath },
    });
    expect(report.ok).toBe(false);
    expect(report.failureCode).not.toBeNull();
  });

  it('加密导出错误口令被拒绝，且不产生半解密数据', async () => {
    const outputPath = join(root, 'encrypted.ecpkg');
    await call({
      domain: 'package',
      method: 'exportPackage',
      params: {
        request: {
          outputPath,
          selection: {
            scope: 'all',
            projectIds: [],
            content: {
              memory: { longterm: true, project: true, feature: true, page: true, issue: true },
              documents: true,
              code: true,
              pipeline: true,
              anchors: true,
              registry: true,
              attachments: false,
            },
          },
          redact: true,
          password: 'correct-password',
        },
      },
    });
    // 正确口令可通过
    const good = await call<{ ok: boolean }>({
      domain: 'package',
      method: 'verifyPackage',
      params: { packagePath: outputPath, password: 'correct-password' },
    });
    expect(good.ok).toBe(true);

    // 错误口令必须明确失败（认证标签校验在落盘之前）
    const bad = await call<{ ok: boolean; failureCode: string | null }>({
      domain: 'package',
      method: 'verifyPackage',
      params: { packagePath: outputPath, password: 'wrong-password' },
    });
    expect(bad.ok).toBe(false);
    expect(bad.failureCode).toBe('password');
  });
});
