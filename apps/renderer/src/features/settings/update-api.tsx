/**
 * 自动更新端口（T10-04 / FR-SET-05）。
 *
 * 冻结契约：外壳注入 `globalThis.__EC_UPDATE__`。
 *
 * 分工：
 * - **决策与编排**在 `@ec/core` 的 `UpdateService`（纯逻辑 + 端口注入，已单测）；
 * - 本端口只暴露"设置页需要看到的状态 + 四个动作"，实现由
 *   `update-service-host.ts` 的 `createUpdateApi()` 适配（真实外壳装配时调用）。
 */

import { createContext, useContext, type ReactNode } from 'react';

import type { UpdateInfo, Unsubscribe } from '@ec/shell-api';

export type UpdateChannel = 'stable' | 'beta';

/**
 * 进度事件。比 `@ec/shell-api` 的 `UpdateProgress` 多一个 `idle` 阶段
 * （外壳只认"正在做某事"的阶段，设置页还需要表达"没有待处理更新"）。
 */
export interface UpdateProgressEvent {
  phase: UpdateViewState['phase'];
  percent?: number | undefined;
  message?: string | undefined;
}

/** 设置页展示用的完整状态（一次取全，避免面板里拼接多个异步源）。 */
export interface UpdateViewState {
  /** 当前已安装版本 */
  currentVersion: string;
  /** 更新渠道 */
  channel: UpdateChannel;
  autoCheck: boolean;
  autoDownload: boolean;
  allowDeferred: boolean;
  /** 上次检查时间；null = 从未检查 */
  lastCheckAt: number | null;
  /** 发现的新版本；null = 已是最新或尚未检查 */
  available: UpdateInfo | null;
  /** 当前阶段 */
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'done' | 'error';
  /** 0–100，仅下载阶段有意义 */
  percent: number | undefined;
  /** 失败 / 提示文案（含"更新失败已回滚到 x.y.z"） */
  message: string | null;
  /**
   * 最近一次已落定的更新记录（含回滚）。
   * `stage: 'rolled-back'` 时设置页必须显示"已回滚到上一版本"。
   */
  lastSettled: {
    toVersion: string;
    fromVersion: string;
    stage: string;
    updatedAt: number;
    lastError: string | null;
  } | null;
}

export interface UpdateSettingsPatch {
  autoCheck?: boolean;
  autoDownload?: boolean;
  allowDeferred?: boolean;
  channel?: UpdateChannel;
}

export interface UpdateApi {
  getState(): Promise<UpdateViewState>;
  /** 手动检查更新（忽略自动检查间隔） */
  check(): Promise<UpdateViewState>;
  /** 下载并安装 */
  install(): Promise<UpdateViewState>;
  /** 稍后提醒 */
  defer(version: string): Promise<UpdateViewState>;
  saveSettings(patch: UpdateSettingsPatch): Promise<UpdateViewState>;
  /** 订阅进度（阶段 / 百分比 / 文案） */
  onProgress(listener: (progress: UpdateProgressEvent) => void): Unsubscribe;
}

const UpdateContext = createContext<UpdateApi | null>(null);

export function UpdateApiProvider({
  api,
  children,
}: {
  api: UpdateApi | null;
  children: ReactNode;
}): JSX.Element {
  return <UpdateContext.Provider value={api}>{children}</UpdateContext.Provider>;
}

export function useUpdateOptional(): UpdateApi | null {
  return useContext(UpdateContext);
}

export function useUpdate(): UpdateApi {
  const api = useContext(UpdateContext);
  if (!api) throw new Error('更新端口未注入：请先在外壳中装配 globalThis.__EC_UPDATE__');
  return api;
}

export function UpdateUnavailable(): JSX.Element {
  return (
    <div className="ec-settings__hint">
      <p>
        自动更新尚未连接。由外壳装配更新通道后，这里可以检查新版本、查看下载进度，并在更新失败时回滚到上一版本。
      </p>
    </div>
  );
}

export function readInjectedUpdateApi(): UpdateApi | null {
  const injected = (globalThis as { __EC_UPDATE__?: UpdateApi }).__EC_UPDATE__;
  return injected ?? null;
}
