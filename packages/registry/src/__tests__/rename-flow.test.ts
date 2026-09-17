/**
 * T7-03 验收测试：重命名触发（300ms 防抖 + 四触发点 + 前置校验）与影响面分析。
 *
 * 覆盖：
 * - 四个触发点（画布属性面板 / 图层树 / 页面名 / 功能名）均可用
 * - **300ms 防抖**（用注入的假调度器断言延迟值，不等真实时间）
 * - 非法名**同步阻断**：不给影响面、直接回调 3 个建议名
 * - 三级分组、warn 默认不勾选、预计耗时/总计
 * - 边界：跨项目条目被剔除（D-07）、长期记忆提及被排除（FR-UNI-13）
 */

import { describe, expect, it } from 'vitest';

import {
  ESTIMATE_MS_PER_CHANGE,
  IMPACT_BUDGET_MS,
  LONGTERM_MEMORY_NOTICE,
  PROJECT_SCOPE_NOTICE,
  RENAME_DEBOUNCE_MS,
  RENAME_TRIGGER_SOURCES,
  TRIGGER_SOURCE_LABELS,
  analyzeImpact,
  createRegistryEntry,
  createRenameTrigger,
  defaultSelection,
  diffProjections,
  partitionScope,
  resolveNamingRule,
  selectedItems,
  summarizeImpact,
  type ConflictCheckResult,
  type Occurrence,
  type RenameIntent,
  type RiskLevel,
} from '../index';

const WEB = resolveNamingRule({ platform: 'web' });

function makeEntry(name = '登录按钮', scope = 'login') {
  return createRegistryEntry({
    projectId: 'p1',
    entityType: 'element',
    canonicalName: name,
    rule: WEB,
    entityId: 'el-1',
    id: 'reg-1',
    scope,
    now: 1_700_000_000_000,
    random: () => 0.5,
  }).entry;
}

let seq = 0;
function occurrence(input: {
  kind: Occurrence['kind'];
  refPath: string;
  locator: string | null;
  symbol: string;
  riskLevel: RiskLevel;
  matchedSymbol?: Occurrence['matchedSymbol'];
  registryId?: string;
  confidence?: number;
  scopeLayer?: string | null;
  carrierId?: string | null;
  carrierField?: string | null;
}): Occurrence {
  seq += 1;
  return {
    id: `occ-${seq}`,
    registryId: input.registryId ?? 'reg-1',
    kind: input.kind,
    refPath: input.refPath,
    locator: input.locator,
    matchedSymbol: input.matchedSymbol ?? null,
    symbol: input.symbol,
    confidence: input.confidence ?? 1,
    riskLevel: input.riskLevel,
    status: 'active',
    role: input.kind === 'code' ? 'call' : null,
    context: null,
    detail: null,
    scopeLayer: input.scopeLayer ?? null,
    carrierId: input.carrierId ?? null,
    carrierField: input.carrierField ?? null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const OCCURRENCES: readonly Occurrence[] = [
  occurrence({
    kind: 'code',
    refPath: 'src/Login.tsx',
    locator: 'src/Login.tsx:3:11',
    symbol: 'LoginButton',
    matchedSymbol: 'component',
    riskLevel: 'auto',
  }),
  occurrence({
    kind: 'code',
    refPath: 'src/LoginService.ts',
    locator: 'src/LoginService.ts:2:3',
    symbol: 'handleLoginButton',
    matchedSymbol: 'methodName',
    riskLevel: 'confirm',
  }),
  occurrence({
    kind: 'code',
    refPath: 'migrations/0002.sql',
    locator: 'migrations/0002.sql:3:12',
    symbol: 'login_button',
    matchedSymbol: 'apiField',
    riskLevel: 'warn',
  }),
  occurrence({
    kind: 'doc',
    refPath: 'doc-1',
    locator: '#login:p1',
    symbol: '登录按钮',
    riskLevel: 'auto',
  }),
  occurrence({
    kind: 'memory',
    refPath: 'mem-1',
    locator: 'mem-1#content',
    symbol: '登录按钮',
    riskLevel: 'auto',
    scopeLayer: 'page',
  }),
  occurrence({
    kind: 'logic',
    refPath: 'page-login',
    locator: 'Container:root/Button:btn-1',
    symbol: '登录按钮',
    riskLevel: 'auto',
    carrierId: 'btn-1',
    carrierField: 'name',
  }),
];

describe('T7-03 触发点与防抖（FR-UNI-03）', () => {
  function setup() {
    const scheduled: { delayMs: number; run: () => void }[] = [];
    const intents: RenameIntent[] = [];
    const blocked: { intent: RenameIntent; result: ConflictCheckResult }[] = [];
    let cancelled = 0;
    const trigger = createRenameTrigger({
      rule: WEB,
      debounceMs: RENAME_DEBOUNCE_MS,
      scheduler: {
        schedule: (callback, delayMs) => {
          const handle = { callback };
          scheduled.push({ delayMs, run: callback });
          return handle;
        },
        cancel: () => {
          cancelled += 1;
        },
      },
      clock: () => 1_700_000_000_000,
      onIntent: (intent) => intents.push(intent),
      onBlocked: (intent, result) => blocked.push({ intent, result }),
    });
    return { trigger, scheduled, intents, blocked, cancelled: () => cancelled };
  }

  it('四个触发点均可提交改名意图，且 300ms 后才真正触发分析', () => {
    expect(RENAME_DEBOUNCE_MS).toBe(300);
    expect([...RENAME_TRIGGER_SOURCES]).toEqual(['inspector', 'layers', 'page', 'feature']);
    expect(TRIGGER_SOURCE_LABELS.layers).toBe('图层树重命名');

    for (const source of RENAME_TRIGGER_SOURCES) {
      const { trigger, scheduled, intents } = setup();
      trigger.trigger({
        registryId: 'reg-1',
        projectId: 'p1',
        entityType: 'element',
        entityId: 'el-1',
        oldName: '登录按钮',
        newName: '登录提交',
        source,
      });
      expect(scheduled, source).toHaveLength(1);
      expect(scheduled[0]?.delayMs, source).toBe(300);
      expect(intents, source).toHaveLength(0); // 未到点不触发
      scheduled[0]?.run();
      expect(intents, source).toHaveLength(1);
      expect(intents[0]?.source).toBe(source);
    }
  });

  it('连续输入合并为一次触发（只保留最后一次名称）', () => {
    const { trigger, scheduled, intents, cancelled } = setup();
    const base = {
      registryId: 'reg-1',
      projectId: 'p1',
      entityType: 'element' as const,
      entityId: 'el-1',
      oldName: '登录按钮',
      source: 'inspector' as const,
    };
    trigger.trigger({ ...base, newName: '登录提交' });
    trigger.trigger({ ...base, newName: '登录提交按钮' });
    trigger.trigger({ ...base, newName: '登录提交A' });
    expect(scheduled).toHaveLength(3);
    expect(cancelled()).toBe(2);
    scheduled[2]?.run();
    expect(intents.map((intent) => intent.newName)).toEqual(['登录提交A']);
  });

  it('非法名同步阻断：不排期、不给影响面，直接回传 3 个建议名', () => {
    const { trigger, scheduled, intents, blocked } = setup();
    trigger.trigger({
      registryId: 'reg-1',
      projectId: 'p1',
      entityType: 'element',
      entityId: 'el-1',
      oldName: '登录按钮',
      newName: 'for',
      source: 'feature',
    });
    expect(scheduled).toHaveLength(0);
    expect(intents).toHaveLength(0);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.result.ok).toBe(false);
    expect(blocked[0]?.result.suggestions).toHaveLength(3);
    expect(trigger.lastBlocked()?.intent.newName).toBe('for');
  });

  it('与旧名相同不触发；flush 立即执行；cancel / dispose 清空挂起意图', () => {
    const { trigger, intents } = setup();
    const base = {
      registryId: 'reg-1',
      projectId: 'p1',
      entityType: 'element' as const,
      entityId: 'el-1',
      source: 'inspector' as const,
    };
    trigger.trigger({ ...base, oldName: '登录按钮', newName: '登录按钮' });
    expect(trigger.pending()).toBeNull();

    trigger.trigger({ ...base, oldName: '登录按钮', newName: '登录提交' });
    expect(trigger.pending()?.newName).toBe('登录提交');
    trigger.flush();
    expect(intents).toHaveLength(1);

    trigger.trigger({ ...base, oldName: '登录按钮', newName: '登录提交A' });
    trigger.cancel();
    expect(trigger.pending()).toBeNull();
    trigger.dispose();
    expect(intents).toHaveLength(1);
  });

  it('校验上下文可注入符号表与排除项（避免与自身旧投影冲突）', () => {
    const blockedNames: string[] = [];
    const trigger = createRenameTrigger({
      rule: WEB,
      scheduler: { schedule: () => null, cancel: () => undefined },
      onIntent: () => undefined,
      onBlocked: (intent) => blockedNames.push(intent.newName),
      checkContext: () => ({ symbols: { frontend: ['RegisterButton'] } }),
    });
    trigger.trigger({
      registryId: 'reg-1',
      projectId: 'p1',
      entityType: 'element',
      entityId: 'el-1',
      oldName: '登录按钮',
      newName: '注册按钮',
      source: 'inspector',
    });
    expect(blockedNames).toEqual(['注册按钮']);
  });
});

describe('T7-03 影响面分析（FR-UNI-04 / FR-UNI-13）', () => {
  const entry = makeEntry();
  const report = analyzeImpact({
    registry: entry,
    newCanonicalName: '登录提交',
    rule: WEB,
    occurrences: OCCURRENCES,
    timer: () => 12.5,
  });

  it('三级分组齐备，warn 默认不勾选、auto / confirm 默认勾选', () => {
    expect(report.groups.map((group) => group.level)).toEqual(['auto', 'confirm', 'warn']);
    const auto = report.groups[0]!;
    const confirm = report.groups[1]!;
    const warn = report.groups[2]!;
    expect(auto.items.every((item) => item.selected)).toBe(true);
    expect(confirm.items.every((item) => item.selected)).toBe(true);
    expect(warn.items.every((item) => item.selected)).toBe(false);
    expect(warn.selectedCount).toBe(0);
    expect(report.totals).toMatchObject({ total: 6, auto: 4, confirm: 1, warn: 1, selected: 5 });
  });

  it('每条给出 旧值 → 新值（按命中投影取值）与位置', () => {
    const component = report.groups[0]!.items.find((item) => item.matchedSymbol === 'component');
    expect(component?.oldText).toBe('LoginButton');
    expect(component?.newText).toBe('LoginSubmit');
    expect(component?.refPath).toBe('src/Login.tsx');
    const method = report.groups[1]!.items[0]!;
    expect(method.oldText).toBe('handleLoginButton');
    expect(method.newText).toBe('handleLoginSubmit');
  });

  it('项目内边界提示原样返回（D-07）', () => {
    expect(report.scopeNotice).toBe(PROJECT_SCOPE_NOTICE);
    expect(report.scopeNotice).toContain('仅影响当前项目');
    expect(report.scopeNotice).toContain('跨项目复用请手动导入 .ecpkg');
    expect(report.projectId).toBe('p1');
  });

  it('预计耗时按条目数换算，实测耗时独立上报', () => {
    expect(report.totals.estimatedMs).toBe(report.totals.total * ESTIMATE_MS_PER_CHANGE);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(IMPACT_BUDGET_MS).toBe(1500);
    expect(summarizeImpact(report)).toContain('将修改 5 处');
    expect(summarizeImpact(report)).toContain('确认区 1 处');
    expect(summarizeImpact(report)).toContain('警告区 1 处');
  });

  it('跨项目条目被剔除并计入 warnings（D-07：结果集不存在跨项目条目）', () => {
    const withForeign = [
      ...OCCURRENCES,
      occurrence({
        kind: 'code',
        refPath: 'other-project/src/x.ts',
        locator: 'other-project/src/x.ts:1:1',
        symbol: 'LoginButton',
        matchedSymbol: 'component',
        riskLevel: 'auto',
        registryId: 'reg-OTHER',
      }),
    ];
    const mixed = analyzeImpact({
      registry: entry,
      newCanonicalName: '登录提交',
      rule: WEB,
      occurrences: withForeign,
      timer: () => 0,
    });
    expect(mixed.excluded.crossProject).toBe(1);
    expect(mixed.totals.total).toBe(6);
    expect(mixed.warnings.some((warning) => warning.includes('非本项目'))).toBe(true);
    const all = mixed.groups.flatMap((group) => group.items);
    expect(all.every((item) => item.refPath !== 'other-project/src/x.ts')).toBe(true);
  });

  it('长期记忆（longterm）提及被排除并给出提示（FR-UNI-13）', () => {
    const withLongterm = [
      ...OCCURRENCES,
      occurrence({
        kind: 'memory',
        refPath: 'mem-longterm',
        locator: 'mem-longterm#content',
        symbol: '登录按钮',
        riskLevel: 'auto',
        scopeLayer: 'longterm',
      }),
    ];
    const mixed = analyzeImpact({
      registry: entry,
      newCanonicalName: '登录提交',
      rule: WEB,
      occurrences: withLongterm,
      timer: () => 0,
    });
    expect(mixed.excluded.longtermMemory).toBe(1);
    expect(mixed.warnings.some((warning) => warning.includes(LONGTERM_MEMORY_NOTICE))).toBe(true);
  });

  it('partitionScope / defaultSelection / selectedItems / diffProjections 语义一致', () => {
    const partitioned = partitionScope(entry, OCCURRENCES);
    expect(partitioned.inScope).toHaveLength(6);
    expect(partitioned.crossProject).toBe(0);
    expect(partitioned.longtermMemory).toBe(0);

    const selection = defaultSelection(report);
    expect(selection.size).toBe(5);
    expect(selectedItems(report, selection)).toHaveLength(5);

    const changes = diffProjections(entry.projections, report.newProjections);
    expect(changes).toHaveLength(8);
    expect(changes.filter((change) => change.changed).length).toBeGreaterThan(0);
  });

  it('投影变化表按命中风险分组一致（同一投影的多处命中同组）', () => {
    for (const group of report.groups) {
      for (const item of group.items) {
        expect(item.riskLevel).toBe(group.level);
      }
    }
  });
});
