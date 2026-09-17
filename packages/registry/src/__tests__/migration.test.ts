/**
 * T7-05 验收测试：数据库字段改名迁移、别名兼容期与批处理。
 *
 * 覆盖：
 * - E2E-20：SQL 预览（前向 + 回滚）→ 影响行数 → 二次确认 → 执行成功 → 记录 rename 事件与提交
 * - 高危 SQL（DROP / 类型变更 / NOT NULL 收紧）强制二次确认 + 建议备份，且**默认只生成不执行**（D-08）
 * - 迁移生成只走 AI（D-08）：无模型 / 输出缺回滚脚本时如实报错，不用模板顶替
 * - 执行失败自动回滚脚本并告警
 * - 三类别名（代码 / API / i18n）产物 + 待清理清单 + 一键清理
 * - 批量重命名与全项目规范化：diff 预览、非法名整批阻断、失败整体回滚
 */

import { describe, expect, it } from 'vitest';

import {
  ALIAS_KIND_LABELS,
  ESTIMATE_MS_PER_CHANGE,
  aliasStatus,
  analyzeSql,
  buildAliasArtifacts,
  buildDdlPrompt,
  buildMigrationPreview,
  classifyStatement,
  cleanAliases,
  createAliasEntry,
  createInMemoryRenameEventStore,
  createRegistryEntry,
  deprecateAlias,
  estimateAffectedRows,
  executeBatchRename,
  executeMigration,
  generateMigration,
  isCleanupDue,
  isGenerationError,
  lockRiskOf,
  parseGeneratedMigration,
  pendingCleanup,
  planBatchRename,
  planNormalization,
  requiresSecondConfirm,
  resolveNamingRule,
  splitStatements,
  suggestsBackup,
  type GeneratedMigration,
  type MigrationModelPort,
  type Occurrence,
  type RegistryEntry,
} from '../index';

const NOW = 1_700_000_000_000;
const WEB = resolveNamingRule({ platform: 'web' });

const FORWARD = 'ALTER TABLE users RENAME COLUMN login_button TO login_submit;';
const ROLLBACK = 'ALTER TABLE users RENAME COLUMN login_submit TO login_button;';
/* 执行器按语句逐条下发，`splitStatements` 会剥掉结尾分号，因此比对与判定都用去分号版本 */
const FORWARD_STMT = FORWARD.replace(/;$/, '');
const ROLLBACK_STMT = ROLLBACK.replace(/;$/, '');

const MODEL_OUTPUT = ['说明文字', '', '```sql', FORWARD, '```', '', '```sql', ROLLBACK, '```'].join('\n');

function fakeModel(output = MODEL_OUTPUT): MigrationModelPort {
  return { modelId: 'fake-model', complete: async () => output };
}

function entryOf(name = '登录按钮', id = 'reg-1', scope = 'login'): RegistryEntry {
  return createRegistryEntry({
    projectId: 'p1',
    entityType: 'element',
    canonicalName: name,
    rule: WEB,
    entityId: `el-${id}`,
    id,
    scope,
    now: NOW,
    random: () => 0.5,
  }).entry;
}

/* ------------------------------- 迁移 ------------------------------- */

describe('T7-05 SQL 安全检测（D-08 / FR-UNI-07）', () => {
  it('按 `;` 切分语句，跳过字符串与注释', () => {
    const statements = splitStatements(
      "-- 注释里;不该切\nALTER TABLE t ADD COLUMN c TEXT DEFAULT 'a;b';\n/* 块注释; */\nDROP INDEX idx;",
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("DEFAULT 'a;b'");
  });

  it('四类高危识别：DROP / 类型变更 / NOT NULL 收紧 / 列改名', () => {
    expect(classifyStatement('DROP COLUMN legacy')?.kind).toBe('drop');
    expect(classifyStatement('ALTER TABLE t ALTER COLUMN c TYPE text')?.kind).toBe('type_change');
    expect(classifyStatement('ALTER TABLE t ALTER COLUMN c SET NOT NULL')?.kind).toBe('not_null_tighten');
    expect(classifyStatement('ALTER TABLE t ADD COLUMN c TEXT NOT NULL')?.kind).toBe('not_null_tighten');
    expect(classifyStatement('ALTER TABLE t RENAME COLUMN a TO b')?.kind).toBe('rename_column');
    expect(classifyStatement('ALTER TABLE t ADD COLUMN c TEXT DEFAULT \'\'')?.kind).toBe('add_column');
    expect(classifyStatement('CREATE INDEX idx ON t (c)')?.kind).toBe('index');
    expect(classifyStatement('SELECT 1')).toBeNull();
  });

  it('高危 → 二次确认 + 建议备份；低保真操作不触发', () => {
    const renameRisks = analyzeSql(FORWARD);
    expect(requiresSecondConfirm(renameRisks)).toBe(false);
    expect(suggestsBackup(renameRisks)).toBe(false);

    const dropRisks = analyzeSql('DROP TABLE users;');
    expect(requiresSecondConfirm(dropRisks)).toBe(true);
    expect(suggestsBackup(dropRisks)).toBe(true);

    const both = analyzeSql(`${FORWARD}\nALTER TABLE t ALTER COLUMN c TYPE int;`);
    expect(requiresSecondConfirm(both)).toBe(true);
    expect(lockRiskOf(both).level).toBe('high');
    expect(lockRiskOf(both).detail).toContain('类型变更');
  });
});

describe('T7-05 迁移生成：只能由 AI 生成（D-08）', () => {
  const request = {
    dialect: 'sqlite' as const,
    table: 'users',
    oldColumn: 'login_button',
    newColumn: 'login_submit',
    columnType: 'TEXT',
    nullable: false,
    dependents: ['idx_users_login_button'],
    estimatedRows: 12_000,
  };

  it('提示词包含目标方言要点、表结构上下文与依赖对象', () => {
    const prompt = buildDdlPrompt(request);
    expect(prompt).toContain('sqlite');
    expect(prompt).toContain('RENAME COLUMN');
    expect(prompt).toContain('users');
    expect(prompt).toContain('login_button');
    expect(prompt).toContain('login_submit');
    expect(prompt).toContain('idx_users_login_button');
    expect(prompt).toContain('12000');
    expect(prompt).toContain('回滚脚本');
  });

  it('从 AI 输出中提取前向与回滚脚本', () => {
    const parsed = parseGeneratedMigration(MODEL_OUTPUT);
    expect(parsed?.forward).toBe(FORWARD);
    expect(parsed?.rollback).toBe(ROLLBACK);
    expect(parseGeneratedMigration('没有代码块')).toBeNull();
  });

  it('正常生成：标记 AI 产物、禁止用户编辑、风险已分析', async () => {
    const generated = await generateMigration({ request, model: fakeModel(), id: 'mig-1' });
    expect(isGenerationError(generated)).toBe(false);
    const migration = generated as GeneratedMigration;
    expect(migration.generatedBy).toBe('ai');
    expect(migration.editable).toBe(false);
    expect(migration.forward).toBe(FORWARD);
    expect(migration.rollback).toBe(ROLLBACK);
    expect(migration.modelId).toBe('fake-model');
    expect(migration.risks.length).toBeGreaterThan(0);
  });

  it('无模型 / 缺回滚脚本 / 无 SQL 均如实报错并给引导（不套模板）', async () => {
    const noModel = await generateMigration({ request, model: null, id: 'mig-2' });
    expect(isGenerationError(noModel)).toBe(true);
    expect((noModel as { guidance: string }).guidance).toContain('设置');

    const noRollback = await generateMigration({
      request,
      model: fakeModel(`\`\`\`sql\n${FORWARD}\n\`\`\``),
      id: 'mig-3',
    });
    expect(isGenerationError(noRollback)).toBe(true);
    expect((noRollback as { reason: string }).reason).toContain('回滚脚本');

    const noSql = await generateMigration({ request, model: fakeModel('纯文字回答'), id: 'mig-4' });
    expect(isGenerationError(noSql)).toBe(true);

    const failing: MigrationModelPort = {
      complete: async () => {
        throw new Error('模型不可用');
      },
    };
    const broken = await generateMigration({ request, model: failing, id: 'mig-5' });
    expect(isGenerationError(broken)).toBe(true);
    expect((broken as { reason: string }).reason).toContain('模型调用失败');
  });
});

describe('T7-05 迁移预览与执行（E2E-20）', () => {
  async function makeMigration(): Promise<GeneratedMigration> {
    const generated = await generateMigration({
      request: {
        dialect: 'mysql',
        table: 'users',
        oldColumn: 'login_button',
        newColumn: 'login_submit',
        columnType: 'VARCHAR(64)',
        nullable: false,
        dependents: [],
        estimatedRows: 12_345,
      },
      model: fakeModel(),
      id: 'mig-e2e',
    });
    if (isGenerationError(generated)) throw new Error('夹具异常');
    return generated;
  }

  it('预览：SQL 两栏 + 影响行数（精确优先）+ 锁表风险 + 默认只生成不执行', async () => {
    const preview = await buildMigrationPreview({
      migration: await makeMigration(),
      stats: { countRows: async () => 12_345, estimateRows: async () => 12_000 },
    });
    expect(preview.defaultAction).toBe('generate_only');
    expect(preview.guidance).toContain('默认只生成脚本不自动执行');
    expect(preview.statements).toHaveLength(1);
    expect(preview.rollbackStatements).toHaveLength(1);
    expect(preview.affectedRows).toMatchObject({ estimate: 12_345, method: 'exact' });
    expect(preview.estimatedMs).toBeGreaterThan(0);
  });

  it('影响行数估算：精确 → 统计 → unknown 三级降级', async () => {
    const exact = await estimateAffectedRows('users', { countRows: async () => 10, estimateRows: async () => 8 });
    expect(exact.method).toBe('exact');
    const statistics = await estimateAffectedRows('users', {
      countRows: async () => null,
      estimateRows: async () => 8,
    });
    expect(statistics.method).toBe('statistics');
    const unknown = await estimateAffectedRows('users', null);
    expect(unknown.method).toBe('unknown');
    expect(unknown.estimate).toBeNull();
  });

  it('E2E-20：未确认不执行 → 确认后执行成功 → 记录 rename 事件与提交', async () => {
    const migration = await makeMigration();
    const preview = await buildMigrationPreview({
      migration,
      stats: { countRows: async () => 12_345, estimateRows: async () => 12_000 },
    });
    expect(preview.requiresSecondConfirm).toBe(false);

    const executed: string[] = [];
    const events = createInMemoryRenameEventStore();
    const log: string[] = [];

    const refused = await executeMigration({
      migration,
      connection: { execute: async (statement) => void executed.push(statement) },
      events,
      projectId: 'p1',
      registryId: 'reg-1',
      onLog: (line) => log.push(line.message),
    });
    expect(refused.ok).toBe(false);
    expect(refused.refused).toContain('默认只生成脚本不执行');
    expect(executed).toHaveLength(0);
    expect(events.list('p1')).toHaveLength(0);

    const result = await executeMigration({
      migration,
      connection: { execute: async (statement) => void executed.push(statement) },
      confirmed: true,
      events,
      git: { commit: () => 'sha-mig-0001' },
      projectId: 'p1',
      registryId: 'reg-1',
      onLog: (line) => log.push(line.message),
    });
    expect(result.ok).toBe(true);
    expect(executed).toEqual([FORWARD_STMT]);
    expect(result.commitSha).toBe('sha-mig-0001');
    expect(log.some((line) => line.includes('执行第 1/1 条'))).toBe(true);
    expect(log.some((line) => line.includes('迁移完成'))).toBe(true);
    expect(events.list('p1')).toHaveLength(1);
    expect(events.list('p1')[0]?.oldName).toBe('users.login_button');
    expect(events.list('p1')[0]?.newName).toBe('users.login_submit');
  });

  it('高危操作缺二次确认时拒绝执行；补上确认后放行', async () => {
    const dropSql = 'ALTER TABLE users DROP COLUMN legacy;';
    const dangerous: GeneratedMigration = {
      id: 'mig-danger',
      dialect: 'sqlite',
      table: 'users',
      oldColumn: 'legacy',
      newColumn: 'legacy2',
      forward: dropSql,
      rollback: 'ALTER TABLE users ADD COLUMN legacy TEXT;',
      generatedBy: 'ai',
      editable: false,
      prompt: 'p',
      risks: analyzeSql(dropSql),
      modelId: 'fake',
    };
    const preview = await buildMigrationPreview({ migration: dangerous, stats: null });
    expect(preview.requiresSecondConfirm).toBe(true);
    expect(preview.backupRecommended).toBe(true);

    const executed: string[] = [];
    const refused = await executeMigration({
      migration: dangerous,
      connection: { execute: async (s) => void executed.push(s) },
      confirmed: true,
      requiresSecondConfirm: true,
    });
    expect(refused.ok).toBe(false);
    expect(refused.refused).toContain('二次确认');
    expect(executed).toHaveLength(0);

    const ok = await executeMigration({
      migration: dangerous,
      connection: { execute: async (s) => void executed.push(s) },
      confirmed: true,
      secondConfirmed: true,
      requiresSecondConfirm: true,
    });
    expect(ok.ok).toBe(true);
  });

  it('执行失败自动执行回滚脚本；回滚也失败则如实告警', async () => {
    const migration = await makeMigration();
    const rollbackLog: string[] = [];
    const failed = await executeMigration({
      migration,
      connection: {
        execute: async (statement) => {
          if (statement === FORWARD_STMT) throw new Error('语法错误');
          rollbackLog.push(statement);
        },
      },
      confirmed: true,
      onLog: () => undefined,
    });
    expect(failed.ok).toBe(false);
    expect(failed.failure).toContain('语法错误');
    expect(failed.rolledBack).toBe(true);
    expect(rollbackLog).toEqual([ROLLBACK_STMT]);

    const bothFailed = await executeMigration({
      migration,
      connection: {
        execute: async () => {
          throw new Error('数据库不可用');
        },
      },
      confirmed: true,
    });
    expect(bothFailed.ok).toBe(false);
    expect(bothFailed.rolledBack).toBe(false);
    expect(bothFailed.rollbackFailure).toContain('数据库不可用');
    expect(bothFailed.log.some((line) => line.message.includes('回滚未完全成功'))).toBe(true);
  });
});

/* ------------------------------- 别名 ------------------------------- */

describe('T7-05 别名与兼容期（FR-UNI-10）', () => {
  const before = entryOf().projections;
  const after = createRegistryEntry({
    projectId: 'p1',
    entityType: 'element',
    canonicalName: '登录提交',
    rule: WEB,
    scope: 'login',
    now: NOW,
    random: () => 0.5,
  }).entry.projections;

  it('三类别名各自产出可落地的兼容产物', () => {
    const code = buildAliasArtifacts({
      kind: 'code',
      oldName: '登录按钮',
      newName: '登录提交',
      before,
      after,
      cleanupDueAt: NOW + 30 * 24 * 3600 * 1000,
      now: NOW,
    });
    expect(code[0]?.refPath).toContain('compat');
    expect(code[0]?.content).toContain(`export { ${after.component} as ${before.component} }`);
    expect(code[0]?.content).toContain(`export const ${before.variable} = ${after.variable};`);
    expect(code[0]?.content).toContain('兼容期别名');

    const api = buildAliasArtifacts({
      kind: 'api',
      oldName: '登录按钮',
      newName: '登录提交',
      before,
      after,
      cleanupDueAt: null,
      now: NOW,
    });
    expect(api[0]?.content).toContain(before.apiField);
    expect(api[0]?.content).toContain(after.apiField);
    expect(api[0]?.content).toContain('长期保留');

    const i18n = buildAliasArtifacts({
      kind: 'i18n',
      oldName: '登录按钮',
      newName: '登录提交',
      before,
      after,
      cleanupDueAt: NOW,
      now: NOW,
    });
    expect(i18n[0]?.refPath).toBe('i18n/compat.json');
    expect(JSON.parse(i18n[0]!.content) as Record<string, string>).toMatchObject({
      [before.i18nKey]: after.i18nKey,
    });
    expect(ALIAS_KIND_LABELS.api).toBe('API 旧字段兼容');
  });

  it('待清理清单：剩余天数 / 已过期 / 长期保留，按到期时间排序', () => {
    const entry = entryOf();
    const withAliases: RegistryEntry = {
      ...entry,
      aliases: [
        createAliasEntry({ kind: 'code', oldName: '旧名A', cleanupDueAt: NOW + 2 * 24 * 3600 * 1000, now: NOW }),
        createAliasEntry({ kind: 'api', oldName: '旧名B', cleanupDueAt: NOW - 24 * 3600 * 1000, now: NOW }),
        createAliasEntry({ kind: 'i18n', oldName: '旧名C', cleanupDueAt: null, now: NOW }),
      ],
    };
    const items = pendingCleanup([withAliases], NOW);
    expect(items).toHaveLength(3);
    expect(items[0]?.alias.name).toBe('旧名B');
    expect(items[0]?.status).toBe('due');
    expect(items[0]?.daysLeft).toBeLessThan(0);
    expect(items[2]?.daysLeft).toBeNull();
    expect(isCleanupDue(withAliases.aliases[1]!, NOW)).toBe(true);
    expect(aliasStatus(withAliases.aliases[0]!, NOW)).toBe('active');
    expect(aliasStatus(withAliases.aliases[1]!, NOW, new Set(['api|旧名B']))).toBe('cleaned');
  });

  it('标记废弃 → 一键清理 → 别名从注册表项移除', () => {
    const entry = entryOf();
    const alias = deprecateAlias(
      createAliasEntry({ kind: 'code', oldName: '旧名A', cleanupDueAt: null, now: NOW }),
      NOW,
      NOW + 7 * 24 * 3600 * 1000,
    );
    expect(alias.deprecatedAt).toBe(NOW);
    expect(alias.cleanupDueAt).toBe(NOW + 7 * 24 * 3600 * 1000);

    const withAlias = { ...entry, aliases: [alias] };
    const result = cleanAliases([withAlias], [{ registryId: entry.id, kind: 'code', name: '旧名A' }], NOW + 1);
    expect(result.cleaned).toHaveLength(1);
    expect(result.cleanedKeys).toEqual(['code|旧名A']);
    expect(result.entries[0]?.aliases).toEqual([]);
    expect(pendingCleanup(result.entries, NOW + 1)).toEqual([]);
  });
});

/* ------------------------------- 批处理 ------------------------------- */

const FILE_A = 'const x = <LoginButton />;\n';
const FILE_B = 'const y = <RegisterButton />;\n';

describe('T7-05 批处理与命名规范化（FR-UNI-14）', () => {
  /** 代码命中：行列号由真实内容现算，执行器才能复核通过 */
  const codeHit = (registryId: string, symbol: string, refPath: string, content: string): Occurrence => {
    const cursor = content.indexOf(symbol);
    const line = cursor < 0 ? 1 : content.slice(0, cursor).split('\n').length;
    const column = cursor < 0 ? 1 : cursor - content.slice(0, cursor).lastIndexOf('\n');
    return {
      id: `occ-${refPath}`,
      registryId,
      kind: 'code',
      refPath,
      locator: `${refPath}:${line}:${column}`,
      matchedSymbol: 'component',
      symbol,
      confidence: 1,
      riskLevel: 'auto',
      status: 'active',
      role: 'jsx-tag',
      context: null,
      detail: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
  };

  it('规划阶段：逐项校验 + 影响面 + 默认勾选 + 总计', () => {
    const a = entryOf('登录按钮', 'reg-1', 'login');
    const b = entryOf('注册按钮', 'reg-2', 'register');
    const plan = planBatchRename({
      projectId: 'p1',
      rule: WEB,
      now: NOW,
      timer: () => NOW,
      symbols: { frontend: ['RegisterButton'] },
      items: [
        {
          registry: a,
          newCanonicalName: '登录提交',
          occurrences: [codeHit('reg-1', a.projections.component, 'src/a.tsx', FILE_A)],
        },
        {
          registry: b,
          newCanonicalName: '注册提交',
          occurrences: [codeHit('reg-2', b.projections.component, 'src/b.tsx', FILE_B)],
        },
      ],
    });
    expect(plan.normalize).toBe(false);
    expect(plan.steps).toHaveLength(2);
    expect(plan.totals.items).toBe(2);
    expect(plan.totals.selectedChanges).toBeGreaterThan(0);
    expect(plan.totals.estimatedMs).toBe(plan.totals.totalChanges * ESTIMATE_MS_PER_CHANGE);
    expect(plan.scopeNotice).toContain('仅影响当前项目');
    expect(plan.steps[0]?.check.ok).toBe(true);
  });

  it('非法名整批阻断（不部分执行）', () => {
    const a = entryOf('登录按钮', 'reg-1', 'login');
    const plan = planBatchRename({
      projectId: 'p1',
      rule: WEB,
      now: NOW,
      items: [{ registry: a, newCanonicalName: 'for', occurrences: [] }],
    });
    expect(plan.steps).toHaveLength(0);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]?.violations.some((violation) => violation.kind === 'reserved_word')).toBe(true);

    const executed = executeBatchRename({ plan, deps: dummyDeps() });
    expect(executed.ok).toBe(false);
    expect(executed.failures[0]).toContain('整批阻断');
  });

  it('一键全项目命名规范化：只收录存在投影漂移的对象', () => {
    const drifted = entryOf('登录按钮', 'reg-1', 'login');
    // 人为把投影改脏（模拟历史遗留的拼音投影）
    const dirty: RegistryEntry = {
      ...drifted,
      projections: { ...drifted.projections, component: 'DengLuAnNiu', cssClass: 'deng-lu-an-niu' },
    };
    const clean = entryOf('注册按钮', 'reg-2', 'register');
    const plan = planNormalization({
      projectId: 'p1',
      entries: [dirty, clean],
      occurrencesOf: (registryId) => [
        codeHit(registryId, 'DengLuAnNiu', `src/${registryId}.tsx`, 'const x = <DengLuAnNiu />;\n'),
      ],
      rule: WEB,
      now: NOW,
    });
    expect(plan.normalize).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.registryId).toBe('reg-1');
    expect(plan.steps[0]?.newName).toBe('登录按钮');
    expect(plan.steps[0]?.projectionChanged).toBe(true);
    // 规范化不改规范名，但把旧投影作为"旧值"参与 diff
    const componentItem = plan.steps[0]?.report.groups
      .flatMap((group) => group.items)
      .find((item) => item.matchedSymbol === 'component');
    expect(componentItem?.oldText).toBe('DengLuAnNiu');
    expect(componentItem?.newText).toBe('LoginButton');
  });

  it('纯已规范项目 → 空计划（不产生无意义提交）', () => {
    const plan = planNormalization({
      projectId: 'p1',
      entries: [entryOf('登录按钮', 'reg-1', 'login')],
      occurrencesOf: () => [],
      rule: WEB,
      now: NOW,
    });
    expect(plan.steps).toHaveLength(0);
    expect(plan.totals.selectedChanges).toBe(0);
  });

  it('批量执行 + 失败整体回滚：已完成项被撤销', () => {
    const a = entryOf('登录按钮', 'reg-1', 'login');
    const b = entryOf('注册按钮', 'reg-2', 'register');
    const harness = batchHarness();
    const plan = planBatchRename({
      projectId: 'p1',
      rule: WEB,
      now: NOW,
      timer: () => NOW,
      items: [
        {
          registry: a,
          newCanonicalName: '登录提交',
          occurrences: [codeHit('reg-1', a.projections.component, 'src/a.tsx', FILE_A)],
        },
        {
          registry: b,
          newCanonicalName: '注册提交',
          occurrences: [codeHit('reg-2', b.projections.component, 'src/b.tsx', FILE_B)],
        },
      ],
    });
    harness.files.set('src/a.tsx', FILE_A);
    harness.files.set('src/b.tsx', FILE_B);

    const result = executeBatchRename({ plan, deps: harness.deps });
    expect(result.ok).toBe(true);
    expect(result.applied).toBeGreaterThan(0);
    expect(harness.files.get('src/a.tsx')).toContain('<LoginSubmit />');
    expect(harness.files.get('src/b.tsx')).toContain('<RegisterSubmit />');
    expect(harness.saved.map((entry) => entry.canonicalName)).toEqual(['登录提交', '注册提交']);
    // 每个对象都产生了独立的 rename 事件（可分别撤销）
    expect(harness.eventsCount()).toBe(2);
  });

  function dummyDeps(): Parameters<typeof executeBatchRename>[0]['deps'] {
    return batchHarness().deps;
  }

  function batchHarness() {
    const files = new Map<string, string>();
    const saved: RegistryEntry[] = [];
    const events = createInMemoryRenameEventStore();
    const anchors = new Map<string, string>();
    return {
      files,
      saved,
      eventsCount: () => events.list('p1').length,
      deps: {
        context: {
          projectId: 'p1',
          showRevisionMarks: false,
          backupDir: null,
          now: NOW,
          files: {
            read: (path: string) => files.get(path) ?? null,
            write: (path: string, content: string) => {
              files.set(path, content);
            },
            exists: (path: string) => files.has(path),
          },
          docs: { read: () => null, write: () => undefined },
          memory: {
            read: () => null,
            setStructured: () => undefined,
            replaceInContent: () => undefined,
            restore: () => undefined,
          },
          logic: {
            readDocument: () => null,
            rename: () => undefined,
            recalcSummary: () => undefined,
            restore: () => undefined,
          },
          anchors: {
            read: (id: string) => anchors.get(id) ?? null,
            update: (id: string, to: string) => {
              anchors.set(id, to);
            },
            restore: (id: string, from: string) => {
              anchors.set(id, from);
            },
            findBySymbol: () => [],
          },
        },
        rule: WEB,
        registry: {
          save: (entry: RegistryEntry) => {
            saved.push(entry);
          },
        },
        git: { commit: () => 'sha-batch-0001' },
        events,
        now: NOW,
        timer: () => NOW,
      },
    };
  }
});
