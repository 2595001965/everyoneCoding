/**
 * T7-01 验收测试：统一标识注册表与命名规则引擎。
 *
 * 覆盖：
 * - 八类投影从「用户登录按钮」正确派生（与 PRD §15.1 表格逐字对齐）
 * - 七端预设可切换 + 项目级覆盖生效
 * - 四类非法检测（保留字 / 冲突 / 超长 / 非法字符）均阻断并给出 3 个建议名
 * - 中文三种解析模式（英文优先 / 强制拼音 / 保留原文）+ 自定义映射表
 * - 投影一致性校验（drift 检测）
 */

import { describe, expect, it } from 'vitest';

import {
  PLATFORM_PRESETS,
  diffProjections,
  PROJECTION_KINDS,
  allReservedWords,
  checkName,
  createRegistryEntry,
  deriveProjections,
  englishTermCount,
  findPreset,
  inferScope,
  mergePreset,
  parseProjections,
  pinyinTableSize,
  projectOne,
  reproject,
  resourceReferenceOf,
  resolveNamingRule,
  segmentWords,
  serializeProjections,
  toIdentifier,
  uniqueIdentifier,
  validateProjections,
  validateProjectionFormat,
  type ProjectionSet,
} from '../index';

const WEB = resolveNamingRule({ platform: 'web' });

describe('T7-01 命名引擎：八类投影派生', () => {
  it('「用户登录按钮」派生 PRD §15.1 表格的八类投影', () => {
    const derived = deriveProjections('用户登录按钮', { entityType: 'element', rule: WEB });
    expect(derived.scope).toBe('login');
    expect(derived.projections).toEqual<ProjectionSet>({
      component: 'UserLoginButton',
      variable: 'userLoginButton',
      cssClass: 'user-login-button',
      i18nKey: 'page.login.userLoginButton.label',
      apiField: 'user_login_button',
      methodName: 'handleUserLoginButton',
      routeSegment: '/user-login-button',
      testName: 'should render UserLoginButton',
    });
  });

  it('元素级投影会提示路由片段仅页面 / 功能级生效；页面级不提示', () => {
    const element = deriveProjections('用户登录按钮', { entityType: 'element', rule: WEB });
    const page = deriveProjections('用户登录页', { entityType: 'page', rule: WEB });
    expect(element.warnings).toHaveLength(1);
    expect(element.warnings[0]).toContain('仅页面 / 功能级');
    expect(page.warnings).toEqual([]);
    expect(page.projections.component).toBe('UserLoginPage');
  });

  it('八类投影可逐类重算（一键规范化只对齐漂移项）', () => {
    const only = reproject('用户登录按钮', ['component', 'apiField'], { entityType: 'element', rule: WEB });
    expect(Object.keys(only).sort()).toEqual(['apiField', 'component']);
    expect(only.component).toBe('UserLoginButton');
    expect(projectOne('methodName', '用户登录按钮', { entityType: 'element', rule: WEB })).toBe(
      'handleUserLoginButton',
    );
  });

  it('scope 可被显式指定（i18n / 路由不走推断）', () => {
    const derived = deriveProjections('提交按钮', {
      entityType: 'element',
      rule: WEB,
      scope: 'checkout',
    });
    expect(derived.projections.i18nKey).toBe('page.checkout.submitButton.label');
    expect(derived.projections.routeSegment).toBe('/submit-button');
  });

  it('scope 推断命中关键字，未命中回落 common', () => {
    expect(inferScope('用户登录按钮')).toBe('login');
    expect(inferScope('商品列表')).toBe('list');
    expect(inferScope('某某控件')).toBe('common');
  });
});

describe('T7-01 命名引擎：中文解析三模式与自定义映射', () => {
  it('默认英文优先：命中词表而非逐字拼音', () => {
    expect(toIdentifier('用户登录按钮', { style: 'pascal' })).toBe('UserLoginButton');
    expect(segmentWords('用户登录按钮')).toEqual(['user', 'login', 'button']);
  });

  it('pinyin 模式强制逐字拼音', () => {
    expect(toIdentifier('用户登录按钮', { mode: 'pinyin', style: 'pascal' })).toBe('YongHuDengLuAnNiu');
    expect(toIdentifier('登录页', { mode: 'pinyin', style: 'camel' })).toBe('dengLuYe');
  });

  it('preserve 模式保留原文（仅裁剪非法字符）', () => {
    expect(toIdentifier('用户登录按钮', { mode: 'preserve', style: 'pascal' })).toBe('用户登录按钮');
    expect(toIdentifier('提交(按钮)', { mode: 'preserve', style: 'camel' })).toBe('提交按钮');
  });

  it('自定义映射表优先级最高，可覆盖内置词表', () => {
    const derived = deriveProjections('用户登录按钮', {
      entityType: 'element',
      rule: { ...WEB, dictionary: { 用户: 'member' } },
    });
    expect(derived.projections.component).toBe('MemberLoginButton');
  });

  it('未收录汉字按 Unicode 降级；表规模可断言（词表 / 拼音表非空）', () => {
    expect(toIdentifier('龘', { style: 'camel' })).toMatch(/^u/);
    expect(englishTermCount()).toBeGreaterThan(150);
    expect(pinyinTableSize()).toBeGreaterThan(140);
  });

  it('标识符不得以数字开头，且提供不冲突的后缀生成', () => {
    expect(toIdentifier('123abc', { style: 'camel' })).toBe('_123abc');
    expect(uniqueIdentifier('userLoginButton', ['userLoginButton', 'userLoginButton_2'])).toBe(
      'userLoginButton_3',
    );
  });
});

describe('T7-01 命名引擎：七端预设与项目级覆盖', () => {
  it('七端预设齐备且 id 唯一', () => {
    const ids = Object.values(PLATFORM_PRESETS).map((preset) => preset.id);
    expect(new Set(ids).size).toBe(7);
    expect(Object.keys(PLATFORM_PRESETS).sort()).toEqual(
      ['android', 'harmonyos', 'ios', 'linux', 'macos', 'web', 'windows'].sort(),
    );
  });

  it('i18n 前缀与路由风格随端切换', () => {
    const name = '用户登录按钮';
    const web = deriveProjections(name, { entityType: 'element', rule: resolveNamingRule({ platform: 'web' }) });
    const harmonyRule = resolveNamingRule({ platform: 'harmonyos' });
    const harmony = deriveProjections(name, { entityType: 'element', rule: harmonyRule });
    const android = deriveProjections(name, {
      entityType: 'element',
      rule: resolveNamingRule({ platform: 'android' }),
    });
    const ios = deriveProjections(name, { entityType: 'element', rule: resolveNamingRule({ platform: 'ios' }) });

    expect(web.projections.i18nKey).toBe('page.login.userLoginButton.label');
    expect(web.projections.routeSegment).toBe('/user-login-button');

    // 鸿蒙：ArkTS 资源引用 + pages/<Pascal> 路由（方法名仍是 camelCase：handleUserLoginButton）
    expect(harmony.projections.i18nKey).toBe('app.string.login_user_login_button');
    expect(harmony.projections.component).toBe('UserLoginButton');
    expect(harmony.projections.methodName).toBe('handleUserLoginButton');
    expect(harmony.projections.routeSegment).toBe('pages/UserLoginButton');
    expect(resourceReferenceOf(harmonyRule.preset.resourceReference, harmony.projections.i18nKey)).toBe(
      "$r('app.string.login_user_login_button')",
    );

    // Android：strings.xml snake key + 无前导斜杠的 snake 路由
    expect(android.projections.i18nKey).toBe('login_user_login_button');
    expect(android.projections.routeSegment).toBe('user_login_button');
    expect(android.projections.methodName).toBe('handleUserLoginButton');
    expect(android.projections.component).not.toContain('-');

    // iOS：Localizable 风格 + camel 路由
    expect(ios.projections.i18nKey).toBe('login.userLoginButton.label');
    expect(ios.projections.routeSegment).toBe('userLoginButton');
  });

  it('桌面三端与 Web 同风格（PRD FR-UNI-02 括注）', () => {
    const name = '用户登录按钮';
    const web = deriveProjections(name, { entityType: 'element', rule: resolveNamingRule({ platform: 'web' }) });
    for (const platform of ['windows', 'linux', 'macos'] as const) {
      const desktop = deriveProjections(name, { entityType: 'element', rule: resolveNamingRule({ platform }) });
      expect(desktop.projections).toEqual(web.projections);
    }
  });

  it('项目级覆盖：可改模式 / 词汇 / 逐投影规则 / 长度上限 / 资源引用', () => {
    const overridden = resolveNamingRule({
      platform: 'web',
      override: {
        mode: 'pinyin',
        dictionary: { 按钮: 'ctrl' },
        rules: { component: { prefix: 'Ui' } },
        maxLength: { cssClass: 8 },
        extraForbiddenChars: '$',
      },
    });
    expect(overridden.overridden).toBe(true);
    expect(overridden.ruleId).toBe('project:web-default');
    const derived = deriveProjections('用户登录按钮', { entityType: 'element', rule: overridden });
    expect(derived.projections.component).toBe('UiYongHuDengLuCtrl');
    const issues = validateProjectionFormat(derived.projections, overridden);
    expect(issues.some((issue) => issue.kind === 'cssClass' && issue.reason === 'too_long')).toBe(true);
  });

  it('预设可按 id / 平台名 / project: 前缀查询，未知 id 回落 Web', () => {
    expect(findPreset('harmonyos')?.platform).toBe('harmonyos');
    expect(findPreset('web-default')?.platform).toBe('web');
    expect(findPreset('project:android-default')?.platform).toBe('android');
    expect(findPreset('nope')).toBeNull();
    expect(resolveNamingRule({ override: { presetId: 'nope' } }).preset.platform).toBe('web');
  });

  it('mergePreset 不修改基座且逐投影可局部覆盖', () => {
    const base = PLATFORM_PRESETS.web;
    const merged = mergePreset(base, { rules: { cssClass: { style: 'snake' } } });
    expect(base.rules.cssClass.style).toBe('kebab');
    expect(merged.rules.cssClass.style).toBe('snake');
    expect(merged.rules.component.style).toBe('pascal');
  });
});

describe('T7-01 冲突与非法检测（FR-UNI-11）', () => {
  const input = { entityType: 'element' as const, rule: WEB };

  it('合法名通过且不给建议名', () => {
    const result = checkName({ canonicalName: '用户登录按钮', ...input });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it('空名称阻断，并给出可读的占位建议名', () => {
    const result = checkName({ canonicalName: '   ', ...input });
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.kind).toBe('empty');
    expect(result.suggestions).toEqual(['未命名元素', '未命名元素_2', '未命名元素_3']);
  });

  it('保留字阻断（JS/TS / Java / Python / Dart / ArkTS 并集）', () => {
    const reserved = allReservedWords();
    expect(reserved.has('for')).toBe(true);
    expect(reserved.has('None')).toBe(true);
    expect(reserved.has('Builder')).toBe(true);
    const result = checkName({ canonicalName: 'for', ...input });
    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.kind === 'reserved_word')).toBe(true);
    expect(result.suggestions).toHaveLength(3);
  });

  it('与已有前端 / 后端标识符冲突时阻断并标注归属', () => {
    const result = checkName({
      canonicalName: '用户登录按钮',
      ...input,
      symbols: { frontend: ['UserLoginButton'], backend: ['handleUserLoginButton'] },
    });
    expect(result.ok).toBe(false);
    const conflicts = result.violations.filter((violation) => violation.kind === 'conflict');
    expect(conflicts).toHaveLength(2);
    expect(conflicts.some((violation) => violation.detail.includes('前端'))).toBe(true);
    expect(conflicts.some((violation) => violation.detail.includes('后端'))).toBe(true);
  });

  it('数据库列名命中属 warn 级提示（仍阻断命名，但说明走迁移脚本）', () => {
    const result = checkName({
      canonicalName: '用户登录按钮',
      ...input,
      symbols: { database: ['user_login_button'] },
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.detail.includes('数据库列名'))).toBe(true);
  });

  it('超长阻断并给出按词缩短的建议名（建议名本身合法）', () => {
    const rule = resolveNamingRule({ platform: 'web', override: { maxLength: { component: 12 } } });
    const result = checkName({ canonicalName: '用户登录按钮', entityType: 'element', rule });
    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.kind === 'too_long')).toBe(true);
    expect(result.suggestions).toHaveLength(3);
    const valid = result.suggestions.filter(
      (suggestion) => checkName({ canonicalName: suggestion, entityType: 'element', rule }).ok,
    );
    expect(valid.length).toBeGreaterThanOrEqual(1);
  });

  it('非法字符阻断（自定义映射引入空格等非法字符）', () => {
    const rule = resolveNamingRule({ platform: 'web', override: { dictionary: { 用户: 'us er' } } });
    const result = checkName({ canonicalName: '用户登录按钮', entityType: 'element', rule });
    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.kind === 'illegal_char')).toBe(true);
    expect(result.suggestions).toHaveLength(3);
  });

  it('四类违规均产出恰好 3 个建议名（可满足 UI 的三选一）', () => {
    const cases = [
      { canonicalName: '   ', entityType: 'element' as const, rule: WEB },
      { canonicalName: 'for', entityType: 'element' as const, rule: WEB },
      {
        canonicalName: '用户登录按钮',
        entityType: 'element' as const,
        rule: WEB,
        symbols: { frontend: ['UserLoginButton'] },
      },
      {
        canonicalName: '用户登录按钮',
        entityType: 'element' as const,
        rule: resolveNamingRule({ platform: 'web', override: { maxLength: { component: 10 } } }),
      },
      {
        canonicalName: '用户登录按钮',
        entityType: 'element' as const,
        rule: resolveNamingRule({ platform: 'web', override: { dictionary: { 用户: 'us er' } } }),
      },
    ];
    for (const item of cases) {
      const result = checkName(item);
      expect(result.ok).toBe(false);
      expect(result.suggestions).toHaveLength(3);
      expect(new Set(result.suggestions).size).toBe(3);
    }
  });
});

describe('T7-01 投影前后对照表（机器生成，任务卡要求输出）', () => {
  it('「用户登录按钮」→「登录提交」的八类投影逐条对照', () => {
    const before = deriveProjections('用户登录按钮', { entityType: 'element', rule: WEB }).projections;
    const after = deriveProjections('登录提交', { entityType: 'element', rule: WEB }).projections;
    const changes = diffProjections(before, after);
    const table = [
      '| 投影 | 旧值（用户登录按钮） | 新值（登录提交） | 变更 |',
      '| --- | --- | --- | --- |',
      ...changes.map(
        (change) => `| ${change.kind} | \`${change.oldValue}\` | \`${change.newValue}\` | ${change.changed ? '是' : '否'} |`,
      ),
    ].join('\n');
    process.stdout.write(`\n[T7-01 投影对照表]\n${table}\n`);

    expect(changes.every((change) => change.changed)).toBe(true);
    expect(after.component).toBe('LoginSubmit');
    expect(before.component).toBe('UserLoginButton');
    expect(after.i18nKey).toBe('page.login.loginSubmit.label');
  });
});

describe('T7-01 注册表项与同步状态', () => {
  it('八类投影 serialize → parse 往返一致，且键序稳定', () => {
    const entry = createRegistryEntry({
      projectId: 'p1',
      entityType: 'element',
      canonicalName: '用户登录按钮',
      rule: WEB,
      now: 1_700_000_000_000,
      random: () => 0.5,
    }).entry;
    const json = serializeProjections(entry.projections);
    expect(Object.keys(JSON.parse(json) as Record<string, string>)).toEqual([...PROJECTION_KINDS]);
    expect(parseProjections(json)).toEqual(entry.projections);
    expect(parseProjections('{oops')).toBeNull();
    expect(parseProjections(null)).toBeNull();
  });

  it('稳定 ID 与规范名分离：entityId 为 26 位 ULID 且保持不变', () => {
    const entry = createRegistryEntry({
      projectId: 'p1',
      entityType: 'element',
      canonicalName: '用户登录按钮',
      rule: WEB,
      now: 1_700_000_000_000,
      random: () => 0.25,
    }).entry;
    expect(entry.entityId).toHaveLength(26);
    expect(entry.id).toHaveLength(26);
    expect(entry.nameHistory).toHaveLength(1);
    expect(entry.syncState).toBe('synced');
  });

  it('validateProjections：投影漂移 → drift_detected；格式违规 → conflict', () => {
    const entry = createRegistryEntry({
      projectId: 'p1',
      entityType: 'element',
      canonicalName: '用户登录按钮',
      rule: WEB,
      now: 1,
      random: () => 0,
    }).entry;

    const drifted = validateProjections({
      entry,
      rule: WEB,
      observed: { component: { value: 'LoginButtonOld', locator: 'src/x.tsx:1:1' } },
    });
    expect(drifted.state).toBe('drift_detected');
    expect(drifted.drift[0]?.expected).toBe('UserLoginButton');
    expect(drifted.drift[0]?.actual).toBe('LoginButtonOld');

    const consistent = validateProjections({
      entry,
      rule: WEB,
      observed: { component: { value: 'UserLoginButton' } },
    });
    expect(consistent.ok).toBe(true);
    expect(consistent.state).toBe('synced');
    expect(consistent.drift).toEqual([]);
  });
});
