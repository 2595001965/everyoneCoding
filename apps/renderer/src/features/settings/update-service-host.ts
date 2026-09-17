/**
 * 更新端口适配器（T10-04）：把 `@ec/core` 的 `UpdateService` 包装成设置页消费的
 * `UpdateApi`（状态快照 + 四个动作 + 进度订阅）。
 *
 * 为什么要有这一层：`UpdateService` 是"决策 + 台账"，不关心 UI 想看什么；
 * 面板需要的是**一次取全的视图状态**（当前版本 / 可用版本 / 阶段 / 百分比 / 上次回滚记录）。
 * 把这段映射单独放一个文件，就能用假端口在测试里跑通整条链路而不碰真实网络。
 */

import type { UpdateInfo, Unsubscribe } from '@ec/shell-api';
import type { UpdateFlowEvent, UpdateService } from '@ec/core';

import type { UpdateApi, UpdateProgressEvent, UpdateSettingsPatch, UpdateViewState } from './update-api';

export interface CreateUpdateApiOptions {
  service: UpdateService;
  /** 当前应用版本（外壳提供） */
  currentVersion: string;
  /** 把偏好写回全局设置（外壳写入 settings store），返回落定后的值 */
  persistSettings?: ((patch: UpdateSettingsPatch) => Promise<void>) | undefined;
}

/** 状态机构建器：把流程事件折叠成面板可读的阶段。 */
export function createUpdateApi(options: CreateUpdateApiOptions): UpdateApi {
  const { service, currentVersion, persistSettings } = options;
  const progressListeners = new Set<(progress: UpdateProgressEvent) => void>();
  let phase: UpdateViewState['phase'] = 'idle';
  let percent: number | undefined;
  let message: string | null = null;

  const notify = (progress: UpdateProgressEvent): void => {
    for (const listener of progressListeners) listener(progress);
  };

  const handleEvent = (event: UpdateFlowEvent): void => {
    switch (event.type) {
      case 'check-skipped':
        phase = 'idle';
        message =
          event.reason === 'offline'
            ? '当前离线，已跳过更新检查（不影响使用）'
            : event.reason === 'disabled'
              ? '已关闭自动检查更新'
              : null;
        break;
      case 'check-done':
        phase = event.info === null ? 'idle' : 'available';
        message = event.info === null ? null : `发现新版本 ${event.info.version}`;
        break;
      case 'remind':
        phase = 'available';
        message = `发现新版本 ${event.version}`;
        break;
      case 'defer':
        phase = 'idle';
        message = `${event.version} 已推迟提醒`;
        break;
      case 'install-started':
        phase = 'downloading';
        percent = 0;
        message = `开始下载 ${event.version}`;
        break;
      case 'install-applied':
        phase = 'done';
        percent = 100;
        message =
          event.backupPath === null
            ? '更新已应用，重启后生效（当前外壳未保留上一版本备份，更新失败需手动重装）'
            : '更新已应用，重启后生效';
        break;
      case 'install-failed':
        phase = 'error';
        percent = undefined;
        message = `更新失败：${event.error}`;
        break;
      case 'health-marked':
        phase = 'idle';
        message = null;
        break;
      case 'rollback-needed':
        message = `${event.toVersion} 启动失败，正在回滚到 ${event.fromVersion}…`;
        break;
      case 'rollback-done':
        phase = 'idle';
        message = `已回滚到上一版本 ${event.toVersion}`;
        break;
      case 'rollback-failed':
        phase = 'error';
        message = `回滚失败：${event.error}（请手动重新安装上一版本）`;
        break;
      case 'rollback-unavailable':
        phase = 'error';
        message = `${event.toVersion} 启动失败，且没有可用备份，无法自动回滚（请手动重装）`;
        break;
      default:
        break;
    }
    notify({
      phase,
      ...(percent === undefined ? {} : { percent }),
      ...(message === null ? {} : { message }),
    });
  };

  // 事件订阅与会话同生命周期（api 每次装配创建一次），无需在面板卸载时解绑
  service.subscribeEvents(handleEvent);

  const snapshot = async (): Promise<UpdateViewState> => {
    await service.init();
    const settings = service.getSettings();
    const available: UpdateInfo | null = service.availableInfo;
    const settled = service.lastSettled;
    return {
      currentVersion,
      channel: settings.channel,
      autoCheck: settings.autoCheck,
      autoDownload: settings.autoDownload,
      allowDeferred: settings.allowDeferred,
      lastCheckAt: await readLastCheckAt(service),
      available,
      phase,
      percent,
      message,
      lastSettled:
        settled === null
          ? null
          : {
              toVersion: settled.toVersion,
              fromVersion: settled.fromVersion,
              stage: settled.stage,
              updatedAt: settled.updatedAt,
              lastError: settled.lastError,
            },
    };
  };

  const api: UpdateApi = {
    getState: snapshot,
    async check() {
      phase = 'checking';
      message = '正在检查更新…';
      notify({ phase: 'checking' });
      await service.checkNow(true);
      return snapshot();
    },
    async install() {
      await service.install();
      return snapshot();
    },
    async defer(version) {
      await service.deferVersion(version);
      return snapshot();
    },
    async saveSettings(patch) {
      const current = service.getSettings();
      service.setSettings({
        ...current,
        ...(patch.autoCheck === undefined ? {} : { autoCheck: patch.autoCheck }),
        ...(patch.autoDownload === undefined ? {} : { autoDownload: patch.autoDownload }),
        ...(patch.allowDeferred === undefined ? {} : { allowDeferred: patch.allowDeferred }),
        ...(patch.channel === undefined ? {} : { channel: patch.channel }),
      });
      await persistSettings?.(patch);
      return snapshot();
    },
    onProgress(listener): Unsubscribe {
      progressListeners.add(listener);
      return () => {
        progressListeners.delete(listener);
      };
    },
  };

  return api;
}

/** 上次检查时间从服务内部状态读出（`UpdateService` 不直接暴露，走快照接口）。 */
async function readLastCheckAt(service: UpdateService): Promise<number | null> {
  const state = await service.exportRuntime();
  return state.lastCheckAt;
}
