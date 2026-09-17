/**
 * 更新策略（T10-04 / FR-SET-05）：什么时候检查、发现新版本后做什么。
 *
 * 全纯函数 + 显式时间注入（`now` 由调用方给），便于单测与跨会话复现：
 * 静默检查节奏、延迟更新（稍后提醒）冷却、渠道过滤、自动下载判定都在这里，
 * 外壳（Tauri / Electron）只负责把系统时钟与用户设置喂进来、把结论执行掉。
 */

import type { UpdateInfo } from '@ec/shell-api';

import { isNewerVersion, parseVersion } from './update-types';

/** 默认检查间隔：24 小时。 */
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 点"稍后提醒"后的冷却：24 小时。 */
export const DEFAULT_SNOOZE_MS = 24 * 60 * 60 * 1000;

export type UpdateChannel = 'stable' | 'beta';

export interface UpdateSettings {
  /** 是否自动检查更新（默认开） */
  autoCheck: boolean;
  /** 检查间隔（毫秒） */
  checkIntervalMs: number;
  /** 更新渠道 */
  channel: UpdateChannel;
  /** 发现新版本后是否静默下载（默认关，只提示） */
  autoDownload: boolean;
  /** 是否允许"稍后提醒"（关闭时新版本必须立即处理） */
  allowDeferred: boolean;
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  autoCheck: true,
  checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
  channel: 'stable',
  autoDownload: false,
  allowDeferred: true,
};

export type CheckDecisionReason =
  | 'first-run'
  | 'interval-due'
  | 'too-soon'
  | 'disabled'
  | 'offline';

export interface CheckDecision {
  shouldCheck: boolean;
  reason: CheckDecisionReason;
  /** 距下次可检查的剩余毫秒（too-soon 时有意义） */
  nextCheckInMs: number;
}

/**
 * 决定"这次启动要不要静默检查更新"。
 *
 * 离线时**不检查也不报错**（NFR-U-02：启动不被网络问题阻塞，E2E-11 同口径）。
 */
export function decideCheck(input: {
  settings: UpdateSettings;
  /** 上次检查时间；null = 从未检查过 */
  lastCheckAt: number | null;
  now: number;
  online: boolean;
}): CheckDecision {
  const { settings, lastCheckAt, now, online } = input;
  if (!settings.autoCheck) return { shouldCheck: false, reason: 'disabled', nextCheckInMs: 0 };
  if (!online) return { shouldCheck: false, reason: 'offline', nextCheckInMs: 0 };
  if (lastCheckAt === null) return { shouldCheck: true, reason: 'first-run', nextCheckInMs: 0 };
  const elapsed = now - lastCheckAt;
  if (elapsed >= settings.checkIntervalMs) {
    return { shouldCheck: true, reason: 'interval-due', nextCheckInMs: 0 };
  }
  return { shouldCheck: false, reason: 'too-soon', nextCheckInMs: settings.checkIntervalMs - elapsed };
}

/** 延迟提醒状态（落设置/本地状态，跨会话保留）。 */
export interface ReminderState {
  /** 被推迟的版本号 */
  deferredVersion: string | null;
  /** 到此刻之前不再提醒 */
  deferredUntil: number | null;
  /** 累计推迟次数（用于 UI 上第 N 次推迟后的措辞加重） */
  snoozeCount: number;
}

export const EMPTY_REMINDER: ReminderState = { deferredVersion: null, deferredUntil: null, snoozeCount: 0 };

export type UpdateAction =
  /** 没有更新，或该版本已被用户永久忽略 */
  | { action: 'none'; reason: 'no-update' | 'not-newer' | 'channel-filtered' | 'invalid-version' }
  /** 提示用户有新版本 */
  | { action: 'remind'; version: string; notes?: string }
  /** 静默下载并安装（用户已开启自动下载） */
  | { action: 'silent-install'; version: string }
  /** 仍在推迟窗口内，不打扰用户 */
  | { action: 'defer'; version: string; until: number };

/**
 * 渠道过滤：beta 版只在 beta 渠道可见；stable 渠道永不接收预发布版本。
 * 这样做是为了避免把预发布包推给只收稳定版的用户（NFR-C-04 兼容性口径）。
 */
export function isChannelAcceptable(version: string, channel: UpdateChannel): boolean {
  const parsed = parseVersion(version);
  if (parsed === null) return false;
  const isPrerelease = parsed.prerelease.length > 0;
  return channel === 'beta' ? true : !isPrerelease;
}

/**
 * 决定"发现新版本后做什么"。
 *
 * 判定顺序（先排除再提示）：
 * 1. 版本非法 / 不比当前新 → 无动作
 * 2. 渠道不接受该版本 → 无动作
 * 3. 仍在延迟窗口内 → defer（不打扰）
 * 4. 用户开了自动下载 → silent-install
 * 5. 否则 → remind
 */
export function decideAction(input: {
  currentVersion: string;
  info: UpdateInfo | null;
  reminder: ReminderState;
  settings: UpdateSettings;
  now: number;
}): UpdateAction {
  const { currentVersion, info, reminder, settings, now } = input;
  if (info === null) return { action: 'none', reason: 'no-update' };

  const parsedCandidate = parseVersion(info.version);
  const parsedCurrent = parseVersion(currentVersion);
  if (parsedCandidate === null || parsedCurrent === null) {
    return { action: 'none', reason: 'invalid-version' };
  }
  if (!isNewerVersion(info.version, currentVersion)) {
    return { action: 'none', reason: 'not-newer' };
  }
  if (!isChannelAcceptable(info.version, settings.channel)) {
    return { action: 'none', reason: 'channel-filtered' };
  }

  if (
    settings.allowDeferred &&
    reminder.deferredVersion === info.version &&
    reminder.deferredUntil !== null &&
    now < reminder.deferredUntil
  ) {
    return { action: 'defer', version: info.version, until: reminder.deferredUntil };
  }

  if (settings.autoDownload) {
    return { action: 'silent-install', version: info.version };
  }

  return {
    action: 'remind',
    version: info.version,
    ...(info.notes !== undefined ? { notes: info.notes } : {}),
  };
}

/** 用户点"稍后提醒"：记录版本与冷却截止时间。 */
export function snooze(
  reminder: ReminderState,
  version: string,
  now: number,
  snoozeMs: number = DEFAULT_SNOOZE_MS,
): ReminderState {
  const sameVersion = reminder.deferredVersion === version;
  return {
    deferredVersion: version,
    deferredUntil: now + snoozeMs,
    snoozeCount: sameVersion ? reminder.snoozeCount + 1 : 1,
  };
}

/** 用户下线某版本（不再提示）或更新已完成后清空推迟状态。 */
export function clearReminder(): ReminderState {
  return { ...EMPTY_REMINDER };
}
