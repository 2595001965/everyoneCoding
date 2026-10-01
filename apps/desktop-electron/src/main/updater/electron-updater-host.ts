/**
 * Electron 形态的更新宿主（FR-SET-05）：把 electron-updater 的 `NsisUpdater` 收成 `UpdaterLike`
 * （check / download / installAndRestart），供 updater IPC 暴露给渲染层的 `UpdateService`。
 *
 * 这里只依赖一个**结构化的最小接口**（{@link NsisUpdaterLike}），不直接 import electron-updater：
 * - 生产装配（`main/index.ts`）传入真实 `NsisUpdater`；
 * - 测试传入同一个真实 `NsisUpdater`，只把 HTTP 执行器换成 Node 实现
 *   （见 `__tests__/electron-updater-host.test.ts`，对本机静态源跑真实的下载 / 差分 / sha512 校验）。
 *
 * 行为约定：
 * - **不自动下载、不在退出时自动安装**（`autoDownload=false` / `autoInstallOnAppQuit=false`）：
 *   安装时机只能由编排层决定 —— 它要先把"待确认"台账落盘，否则崩溃后无从回滚；
 * - 增量：electron-builder 为 NSIS 产出 `.blockmap`，本机已装版本的安装包由 NSIS 留在
 *   `%LOCALAPPDATA%\@ecdesktop-electron-updater\installer.exe`，electron-updater 据两份 blockmap 只拉变化的块，
 *   拿不到旧 blockmap 时自动回退整包（日志里如实记录，进度文案里写明实际下载量）；
 * - 差分走**单区间请求**（`useMultipleRangeRequest: false`）：多区间请求时 electron-updater 不报进度，
 *   面板会停在 0%，停滞看门狗也无从判断；GitHub Releases 的 CDN 本来也不支持多区间；
 * - **停滞看门狗**：连续 {@link ElectronUpdaterHostOptions.stallTimeoutMs} 没有任何进度即取消下载并报 network
 *   （实测：连接在传输中途被掐断时，electron-updater 的管道既不报错也不结束，会永远挂住）；
 * - 错误一律打 `UPDATE_<KIND>:` 标记（见 `@ec/core` 的 `classifyUpdateError`），穿过 IPC 后仍可归类。
 */

import type { UpdaterLike } from '../types';

export interface UpdateInfoLike {
  version: string;
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null;
  releaseDate?: string;
}

export interface ProgressInfoLike {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdaterLoggerLike {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug?(message: string): void;
}

/** electron-updater `NsisUpdater` 的最小结构子集（真实对象天然满足）。 */
export interface NsisUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  disableWebInstaller: boolean;
  logger: UpdaterLoggerLike | null;
  setFeedURL(options: {
    provider: 'generic';
    url: string;
    channel?: string;
    useMultipleRangeRequest?: boolean;
  }): void;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: UpdateInfoLike } | null>;
  downloadUpdate(cancellationToken?: CancellationTokenLike): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', listener: (info: ProgressInfoLike) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

/** electron-updater 导出的 `CancellationToken` 的最小子集。 */
export interface CancellationTokenLike {
  cancel(): void;
}

export interface ElectronUpdaterHostOptions {
  updater: NsisUpdaterLike;
  /**
   * 运行时覆盖更新源（`EC_UPDATE_URL`，generic provider）。
   * 为 null 时用打包时写进 `resources/app-update.yml` 的发布配置（electron-builder `publish`）。
   */
  feedUrl: string | null;
  /** 更新源是否可用：未打包且没有覆盖源时为 false（开发期如实报"未配置"）。 */
  enabled: boolean;
  log?: (line: string) => void;
  /** 等待安装器启动失败事件的窗口（毫秒）；成功时应用在此期间退出。 */
  installGraceMs?: number;
  /** 下载停滞多久（毫秒，无任何进度）判定连接已断并中止；缺省 60s。 */
  stallTimeoutMs?: number;
  /** 生产传 `() => new CancellationToken()`（electron-updater 导出）；缺省不启用看门狗。 */
  createCancellationToken?: () => CancellationTokenLike;
}

/** electron-updater 的错误码 / 报文 → 更新失败类别（与 `@ec/core` 的 UpdateErrorKind 同名）。 */
export function tagElectronUpdaterError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (/\bUPDATE_[A-Z_]+:/.test(message)) return error instanceof Error ? error : new Error(message);
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  let kind = 'UNKNOWN';
  if (
    code === 'ERR_UPDATER_INVALID_SIGNATURE' ||
    /not signed by the application owner/i.test(message)
  ) {
    kind = 'SIGNATURE';
  } else if (
    /sha512 checksum mismatch|ERR_CHECKSUM_MISMATCH|ERR_UPDATER_INVALID_CHECKSUM/i.test(message)
  ) {
    kind = 'INTEGRITY';
  } else if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    kind = 'OFFLINE';
  } else if (typeof statusCode === 'number' && statusCode >= 400) {
    // 更新源回 4xx/5xx（清单或安装包不在 / 服务端故障）
    kind = 'NETWORK';
  } else if (
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|net::ERR_|HttpError|status code|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|aborted|premature close/i.test(
      message,
    )
  ) {
    kind = 'NETWORK';
  }
  return new Error(`UPDATE_${kind}: ${message}`);
}

function notesOf(info: UpdateInfoLike): string | undefined {
  const notes = info.releaseNotes;
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((item) => item.note ?? '')
      .filter((note) => note !== '')
      .join('\n');
  }
  return undefined;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 从 electron-updater 的差分日志里取"整包大小 / 实际下载量"。 */
const DIFF_LINE_RE = /Full:\s*([\d,.]+)\s*KB,\s*To download:\s*([\d,.]+)\s*KB/;

export interface DownloadStats {
  /** 是否走了 blockmap 差分 */
  differential: boolean;
  /** 差分时整包与实际下载量（KB，取自 electron-updater 日志） */
  fullKb?: number;
  downloadKb?: number;
  /** 差分失败回退整包的原因 */
  fallbackReason?: string;
}

export interface ElectronUpdaterHost extends UpdaterLike {
  /** 最近一次下载的差分统计（供诊断与测试断言）。 */
  lastDownloadStats(): DownloadStats | null;
}

export function createElectronUpdaterHost(
  options: ElectronUpdaterHostOptions,
): ElectronUpdaterHost {
  const { updater, feedUrl, enabled } = options;
  const log = options.log ?? ((line: string) => console.info(line));
  const graceMs = options.installGraceMs ?? 3000;
  const stallMs = options.stallTimeoutMs ?? 60_000;
  let lastActivity = Date.now();
  const listeners = new Set<
    (progress: { phase: string; percent?: number; message?: string }) => void
  >();
  const emit = (progress: { phase: string; percent?: number; message?: string }): void => {
    for (const listener of listeners) listener(progress);
  };

  let stats: DownloadStats | null = null;
  let downloadedVersion: string | null = null;

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.logger = {
    info: (message?: unknown) => {
      const text = String(message);
      const diff = DIFF_LINE_RE.exec(text);
      if (diff !== null && stats !== null) {
        stats.differential = true;
        stats.fullKb = Number(diff[1]?.replace(/,/g, ''));
        stats.downloadKb = Number(diff[2]?.replace(/,/g, ''));
        emit({
          phase: 'downloading',
          percent: 0,
          message: `差分下载：仅需 ${mb(stats.downloadKb * 1024)}（整包 ${mb(stats.fullKb * 1024)}）`,
        });
      }
      lastActivity = Date.now();
      log(`[updater] ${text}`);
    },
    warn: (message?: unknown) => log(`[updater] WARN ${String(message)}`),
    error: (message?: unknown) => {
      const text = String(message);
      if (stats !== null && /Cannot download differentially/.test(text)) {
        stats.differential = false;
        stats.fallbackReason = text.split('\n')[0] ?? text;
      }
      log(`[updater] ERROR ${text}`);
    },
  };
  if (feedUrl !== null) {
    updater.setFeedURL({ provider: 'generic', url: feedUrl, useMultipleRangeRequest: false });
  }

  const onProgress = (info: ProgressInfoLike): void => {
    lastActivity = Date.now();
    const percent = Math.max(0, Math.min(100, Math.round(info.percent)));
    const message =
      stats?.differential === true && stats.downloadKb !== undefined && stats.fullKb !== undefined
        ? `差分下载：仅需 ${mb(stats.downloadKb * 1024)}（整包 ${mb(stats.fullKb * 1024)}）`
        : `下载中 ${mb(info.transferred)} / ${mb(info.total)}`;
    emit({ phase: 'downloading', percent, message });
  };
  updater.on('download-progress', onProgress);

  const ensureEnabled = (): void => {
    if (!enabled) {
      throw new Error('UPDATE_NOT_CONFIGURED: 开发环境未打包，且未设置 EC_UPDATE_URL 覆盖更新源');
    }
  };

  const check = async (): Promise<{
    version: string;
    notes?: string;
    releaseDate?: string;
  } | null> => {
    ensureEnabled();
    let result: Awaited<ReturnType<NsisUpdaterLike['checkForUpdates']>>;
    try {
      result = await updater.checkForUpdates();
    } catch (error) {
      throw tagElectronUpdaterError(error);
    }
    if (result === null || !result.isUpdateAvailable) return null;
    const info = result.updateInfo;
    const notes = notesOf(info);
    return {
      version: info.version,
      ...(notes === undefined || notes === '' ? {} : { notes }),
      ...(info.releaseDate === undefined ? {} : { releaseDate: info.releaseDate }),
    };
  };

  const download = async (): Promise<{
    version: string;
    notes?: string;
    releaseDate?: string;
  } | null> => {
    emit({ phase: 'checking' });
    const info = await check();
    if (info === null) return null;
    emit({ phase: 'available', message: `发现新版本 ${info.version}` });
    stats = { differential: false };
    const token = options.createCancellationToken?.() ?? null;
    let stalled = false;
    lastActivity = Date.now();
    const watchdog =
      token === null
        ? null
        : setInterval(
            () => {
              if (Date.now() - lastActivity < stallMs) return;
              stalled = true;
              token.cancel();
            },
            Math.max(50, Math.min(5000, Math.floor(stallMs / 4))),
          );
    try {
      // downloadUpdate 内部：差分（blockmap）或整包 → sha512 校验 → Authenticode 发布者校验（配置了 publisherName 时）
      await (token === null ? updater.downloadUpdate() : updater.downloadUpdate(token));
    } catch (error) {
      downloadedVersion = null;
      const tagged = stalled
        ? new Error(
            `UPDATE_NETWORK: 下载停滞 ${Math.round(stallMs / 1000)}s 无数据，已中止（连接可能已断开）`,
          )
        : tagElectronUpdaterError(error);
      emit({ phase: 'error', message: tagged.message });
      throw tagged;
    } finally {
      if (watchdog !== null) clearInterval(watchdog);
    }
    downloadedVersion = info.version;
    log(
      `[updater] ${info.version} 已下载并通过校验（${stats.differential ? `差分 ${stats.downloadKb ?? '?'}KB / 整包 ${stats.fullKb ?? '?'}KB` : `整包${stats.fallbackReason ? `，差分回退：${stats.fallbackReason}` : ''}`}）`,
    );
    emit({ phase: 'downloading', percent: 100, message: `${info.version} 已下载并通过校验` });
    return info;
  };

  const installAndRestart = async (): Promise<void> => {
    ensureEnabled();
    if (downloadedVersion === null) {
      throw new Error('UPDATE_INSTALL: 没有已下载并通过校验的更新');
    }
    emit({ phase: 'installing', percent: 100 });
    // quitAndInstall 同步拉起安装器，拉起失败经 'error' 事件异步回报；成功时应用随即退出。
    const failed = new Promise<Error | null>((resolve) => {
      const onError = (error: Error): void => resolve(error);
      updater.on('error', onError);
      setTimeout(() => {
        updater.removeListener('error', onError as (...args: never[]) => void);
        resolve(null);
      }, graceMs);
    });
    // isSilent=true：NSIS /S 静默安装；isForceRunAfter=true：装完拉起新版本（= 重启应用）
    updater.quitAndInstall(true, true);
    const error = await failed;
    if (error !== null) {
      emit({ phase: 'error', message: error.message });
      throw new Error(`UPDATE_INSTALL: ${error.message}`);
    }
  };

  return {
    check,
    download,
    installAndRestart,
    async downloadAndInstall() {
      if ((await download()) !== null) await installAndRestart();
    },
    onProgress(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    lastDownloadStats: () => (stats === null ? null : { ...stats }),
  };
}

/**
 * 解析运行时更新源覆盖：`EC_UPDATE_URL` 必须是 http(s) URL，否则忽略（并记日志）。
 * 用途：本地静态源演练、企业内网镜像。完整性仍由 sha512（+ 配置时的 Authenticode 发布者）兜底。
 */
export function resolveFeedOverride(
  raw: string | undefined,
  log: (line: string) => void,
): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(url.protocol);
    return url.toString().replace(/\/?$/, '/');
  } catch {
    log(`[updater] 忽略非法的 EC_UPDATE_URL：${raw}`);
    return null;
  }
}
