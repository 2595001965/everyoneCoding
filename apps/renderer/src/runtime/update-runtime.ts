/**
 * 自动更新运行时装配（FR-SET-05 / T10-04）：把 `@ec/core` 的 `UpdateService` 接到真实外壳，
 * 并注入 `globalThis.__EC_UPDATE__` 供设置页「更新」类目使用。**双形态共用这一份**。
 *
 * 启动时序（与回滚台账的前提绑定，顺序不能改）：
 * 1. **首屏渲染之前** `bootstrap({ skipCheck: true })`：先核对上一轮收尾（安装是否生效 /
 *    回滚是否落定），再计一次启动并判定是否回滚 —— 崩溃循环场景下，首屏本身就可能是崩的那一步；
 * 2. 首屏渲染之后才发起网络检查（离线 / 慢网都不拖首屏，NFR-U-02）；
 * 3. 应用稳定运行 {@link HEALTHY_AFTER_MS} 后 `markHealthy()` 落定，此后不再计入崩溃次数。
 *
 * 演练钩子（`<dataDir>/update-e2e.json`，仅本地静态源演练用，文件不存在时零影响）：
 * - `autoInstall: true`   —— 启动后自动检查并"立即更新"（一次性：执行前先从文件里摘掉）；
 * - `unhealthyVersions`   —— 运行到这些版本时不落定健康、直接关窗，模拟"新版本启动即崩"；
 * - `healthyAfterMs`      —— 缩短落定健康的等待。
 * 过程逐行写进 `<dataDir>/update-e2e.log`（JSON Lines），供 `e2e/update/` 的演练脚本判定。
 */

import { UpdateService, updateSettingsSchema, type UpdateSettings } from '@ec/core';
import type { ShellHost } from '@ec/shell-api';

import type { UpdateApi } from '../features/settings/update-api';
import { createUpdateApi } from '../features/settings/update-service-host';
import { createShellUpdatePorts } from '../features/settings/update-shell-ports';

/** 应用稳定运行多久算"启动成功"（毫秒）。 */
export const HEALTHY_AFTER_MS = 15_000;
export const UPDATE_SETTINGS_FILE = 'update-settings.json';
export const UPDATE_E2E_FILE = 'update-e2e.json';
export const UPDATE_E2E_LOG = 'update-e2e.log';

interface UpdateE2eDirective {
  autoInstall?: boolean;
  unhealthyVersions?: string[];
  healthyAfterMs?: number;
}

export interface InstalledUpdateRuntime {
  api: UpdateApi;
  service: UpdateService;
  /** 首屏渲染后调用：发起网络检查、安排健康落定、执行演练指令。 */
  afterFirstRender(): void;
}

export interface InstallUpdateRuntimeOptions {
  isOnline?: () => boolean;
  /** 监听联网恢复（缺省用 window 'online' 事件） */
  onOnline?: (listener: () => void) => void;
  setTimer?: (fn: () => void, ms: number) => void;
}

async function readJson(shell: ShellHost, file: string): Promise<unknown> {
  if (!(await shell.fs.exists(file))) return null;
  try {
    return JSON.parse(await shell.fs.readText(file)) as unknown;
  } catch {
    return null;
  }
}

export async function installUpdateRuntime(
  shell: ShellHost,
  options: InstallUpdateRuntimeOptions = {},
): Promise<InstalledUpdateRuntime> {
  const isOnline =
    options.isOnline ??
    ((): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const setTimer = options.setTimer ?? ((fn, ms) => void setTimeout(fn, ms));
  const dataDir = await shell.appInfo.getDataDir();
  const info = await shell.appInfo.get();
  const settingsFile = shell.path.join(dataDir, UPDATE_SETTINGS_FILE);
  const e2eFile = shell.path.join(dataDir, UPDATE_E2E_FILE);
  const e2eLog = shell.path.join(dataDir, UPDATE_E2E_LOG);

  const storedSettings = updateSettingsSchema.safeParse(
    (await readJson(shell, settingsFile)) ?? {},
  );
  const settings: UpdateSettings = storedSettings.success
    ? storedSettings.data
    : updateSettingsSchema.parse({});

  const e2eRaw = (await readJson(shell, e2eFile)) as UpdateE2eDirective | null;
  const e2e: UpdateE2eDirective | null =
    e2eRaw !== null && typeof e2eRaw === 'object' ? e2eRaw : null;
  // 外壳只有原子写、没有追加：启动时读一次旧日志，本会话的行在内存累积后整份重写（串行）
  const previousLog =
    e2e !== null && (await shell.fs.exists(e2eLog)) ? await shell.fs.readText(e2eLog) : '';
  const e2eLines: string[] = [];
  let logQueue: Promise<void> = Promise.resolve();
  const logE2e = (entry: Record<string, unknown>): Promise<void> => {
    if (e2e === null) return Promise.resolve();
    e2eLines.push(
      JSON.stringify({
        at: new Date().toISOString(),
        version: info.version,
        shell: info.kind,
        ...entry,
      }),
    );
    const content = `${previousLog}${e2eLines.join('\n')}\n`;
    logQueue = logQueue.then(() => shell.fs.writeAtomic(e2eLog, content)).catch(() => undefined);
    return logQueue;
  };

  const { ports } = await createShellUpdatePorts({ shell, dataDir, isOnline });
  const service = new UpdateService({ ports, settings });
  service.subscribeEvents((event) => void logE2e({ event }));

  const api = createUpdateApi({
    service,
    currentVersion: info.version,
    isOnline,
    persistSettings: async () => {
      await shell.fs.writeAtomic(
        settingsFile,
        `${JSON.stringify(service.getSettings(), null, 2)}\n`,
      );
    },
  });
  (globalThis as unknown as { __EC_UPDATE__?: UpdateApi }).__EC_UPDATE__ = api;

  const decision = await service.bootstrap({ skipCheck: true });
  await logE2e({ boot: decision });

  const afterFirstRender = (): void => {
    // 回滚已交给留档安装包：它会结束本进程，别再发起任何网络动作
    if (decision.decision === 'rollback') return;

    if (e2e?.unhealthyVersions?.includes(info.version) === true) {
      void logE2e({ simulate: 'crash' }).then(() => shell.window.close());
      return;
    }
    setTimer(() => void service.markHealthy(), e2e?.healthyAfterMs ?? HEALTHY_AFTER_MS);

    if (e2e?.autoInstall === true) {
      void (async () => {
        // 一次性指令：先摘掉再执行，否则回滚后的旧版本会再次自动更新，演练变成死循环
        await shell.fs.writeAtomic(
          e2eFile,
          `${JSON.stringify({ ...e2e, autoInstall: false }, null, 2)}\n`,
        );
        await service.checkNow(true);
        await service.install();
      })();
      return;
    }
    void service.checkNow(false);
  };

  const onOnline =
    options.onOnline ??
    ((listener: () => void): void => {
      if (typeof window !== 'undefined') window.addEventListener('online', listener);
    });
  onOnline(() => void service.checkNow(false));

  return { api, service, afterFirstRender };
}
