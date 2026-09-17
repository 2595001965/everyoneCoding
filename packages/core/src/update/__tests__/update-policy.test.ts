import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  isNewerVersion,
  isValidVersion,
  parseVersion,
} from '../update-types';
import {
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_SNOOZE_MS,
  DEFAULT_UPDATE_SETTINGS,
  EMPTY_REMINDER,
  clearReminder,
  decideAction,
  decideCheck,
  isChannelAcceptable,
  snooze,
  type UpdateSettings,
} from '../update-policy';

const settings = (patch: Partial<UpdateSettings> = {}): UpdateSettings => ({
  ...DEFAULT_UPDATE_SETTINGS,
  ...patch,
});

describe('版本号解析与比较（T10-04）', () => {
  it('解析三段数字与预发布标识', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('v0.9.0')).toMatchObject({ major: 0, minor: 9, patch: 0 });
    expect(parseVersion('1.0.0-beta.1')).toMatchObject({ prerelease: ['beta', '1'] });
  });

  it('非法版本号返回 null / 抛错（不静默当相等）', () => {
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('a.b.c')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(isValidVersion('1.2.3')).toBe(true);
    expect(isValidVersion('1.2.3.4')).toBe(false);
    expect(() => compareVersions('1.2', '1.2.3')).toThrow(/非法版本号/);
  });

  it('数字段按数值比较而非字典序', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
  });

  it('预发布版本小于同号正式版（语义化版本 §11）', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBe(1);
    // 数字标识 < 字母标识
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  it('isNewerVersion 只认严格更新', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
  });
});

describe('自动检查节奏（NFR-U-02：启动不被网络阻塞）', () => {
  const now = 1_700_000_000_000;

  it('首次启动检查一次', () => {
    expect(decideCheck({ settings: settings(), lastCheckAt: null, now, online: true })).toMatchObject({
      shouldCheck: true,
      reason: 'first-run',
    });
  });

  it('距上次检查不足间隔时跳过，并给出剩余时间', () => {
    const decision = decideCheck({ settings: settings(), lastCheckAt: now - 1000, now, online: true });
    expect(decision.shouldCheck).toBe(false);
    expect(decision.reason).toBe('too-soon');
    expect(decision.nextCheckInMs).toBe(DEFAULT_CHECK_INTERVAL_MS - 1000);
  });

  it('间隔到期后再次检查', () => {
    const lastCheckAt = now - DEFAULT_CHECK_INTERVAL_MS;
    expect(decideCheck({ settings: settings(), lastCheckAt, now, online: true }).reason).toBe('interval-due');
  });

  it('关闭自动检查 / 离线时都不检查，且离线不是错误', () => {
    expect(decideCheck({ settings: settings({ autoCheck: false }), lastCheckAt: null, now, online: true })).toMatchObject({
      shouldCheck: false,
      reason: 'disabled',
    });
    expect(decideCheck({ settings: settings(), lastCheckAt: null, now, online: false })).toMatchObject({
      shouldCheck: false,
      reason: 'offline',
    });
  });
});

describe('渠道过滤（预发布不外溢到 stable）', () => {
  it('stable 渠道拒绝预发布，beta 渠道全收', () => {
    expect(isChannelAcceptable('1.0.0', 'stable')).toBe(true);
    expect(isChannelAcceptable('1.0.0-beta.1', 'stable')).toBe(false);
    expect(isChannelAcceptable('1.0.0-beta.1', 'beta')).toBe(true);
    expect(isChannelAcceptable('1.0.0', 'beta')).toBe(true);
    expect(isChannelAcceptable('bad', 'beta')).toBe(false);
  });
});

describe('发现新版本后的动作决策', () => {
  const now = 1_700_000_000_000;
  const info = { version: '0.2.0', notes: '修了几个问题' };

  it('版本不比当前新 → 无动作', () => {
    expect(decideAction({ currentVersion: '0.2.0', info, reminder: EMPTY_REMINDER, settings: settings(), now })).toMatchObject({
      action: 'none',
      reason: 'not-newer',
    });
    expect(decideAction({ currentVersion: '0.1.0', info: null, reminder: EMPTY_REMINDER, settings: settings(), now })).toMatchObject({
      action: 'none',
      reason: 'no-update',
    });
  });

  it('stable 渠道下预发布版本被过滤掉', () => {
    expect(
      decideAction({
        currentVersion: '0.1.0',
        info: { version: '0.2.0-beta.1' },
        reminder: EMPTY_REMINDER,
        settings: settings({ channel: 'stable' }),
        now,
      }),
    ).toMatchObject({ action: 'none', reason: 'channel-filtered' });
  });

  it('默认提示用户（remind），并带上更新说明', () => {
    expect(decideAction({ currentVersion: '0.1.0', info, reminder: EMPTY_REMINDER, settings: settings(), now })).toEqual({
      action: 'remind',
      version: '0.2.0',
      notes: '修了几个问题',
    });
  });

  it('开启自动下载 → silent-install', () => {
    expect(
      decideAction({
        currentVersion: '0.1.0',
        info,
        reminder: EMPTY_REMINDER,
        settings: settings({ autoDownload: true }),
        now,
      }),
    ).toMatchObject({ action: 'silent-install', version: '0.2.0' });
  });

  it('推迟窗口内不打扰用户；窗口过期后重新提示', () => {
    const deferred = snooze(EMPTY_REMINDER, '0.2.0', now);
    expect(deferred.deferredUntil).toBe(now + DEFAULT_SNOOZE_MS);
    expect(
      decideAction({ currentVersion: '0.1.0', info, reminder: deferred, settings: settings(), now: now + 1000 }),
    ).toMatchObject({ action: 'defer', version: '0.2.0' });
    expect(
      decideAction({
        currentVersion: '0.1.0',
        info,
        reminder: deferred,
        settings: settings(),
        now: now + DEFAULT_SNOOZE_MS + 1,
      }),
    ).toMatchObject({ action: 'remind' });
  });

  it('推迟状态只对同一版本生效（换了版本号立刻提示）', () => {
    const deferred = snooze(EMPTY_REMINDER, '0.2.0', now);
    expect(
      decideAction({
        currentVersion: '0.1.0',
        info: { version: '0.3.0' },
        reminder: deferred,
        settings: settings(),
        now: now + 1000,
      }),
    ).toMatchObject({ action: 'remind', version: '0.3.0' });
  });

  it('禁止推迟时（allowDeferred=false）推迟状态被忽略', () => {
    const deferred = snooze(EMPTY_REMINDER, '0.2.0', now);
    expect(
      decideAction({
        currentVersion: '0.1.0',
        info,
        reminder: deferred,
        settings: settings({ allowDeferred: false }),
        now: now + 1000,
      }),
    ).toMatchObject({ action: 'remind' });
  });

  it('snooze 累计次数：同版本 +1，换版本重置为 1', () => {
    const once = snooze(EMPTY_REMINDER, '0.2.0', now);
    expect(once.snoozeCount).toBe(1);
    expect(snooze(once, '0.2.0', now).snoozeCount).toBe(2);
    expect(snooze(once, '0.3.0', now).snoozeCount).toBe(1);
  });

  it('clearReminder 重置全部推迟字段', () => {
    expect(clearReminder()).toEqual({ deferredVersion: null, deferredUntil: null, snoozeCount: 0 });
  });
});
