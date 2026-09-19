/**
 * 自动更新面板（T10-04 / FR-SET-05）。
 *
 * 覆盖验收项：
 * - 静默检查 → 发现新版本提示（含更新说明）
 * - 增量下载进度（百分比 + 阶段文案）
 * - 重启后应用（阶段 done 时明确告知"重启后生效"）
 * - 支持"稍后提醒"（冷却内不再打扰）
 * - 更新失败回滚到上一版本（显示已回滚版本与失败原因）
 * - 全程无命令行（FR-SET-08）
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Switch } from '@ec/ui';

import {
  UpdateUnavailable,
  useUpdateOptional,
  type UpdateApi,
  type UpdateViewState,
} from './update-api';

const PHASE_TEXT: Record<UpdateViewState['phase'], string> = {
  idle: '未检查',
  checking: '正在检查更新…',
  available: '发现新版本',
  downloading: '正在下载…',
  installing: '正在安装…',
  // 状态短标签与下方 message 分开措辞：两者都写"重启后生效"会让界面与测试都出现重复文本
  done: '更新完成',
  error: '更新失败',
};

function formatTime(value: number | null): string {
  if (value === null) return '从未检查';
  const date = new Date(value);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function UpdatePanel({ api }: { api?: UpdateApi | null }): JSX.Element {
  const injected = useUpdateOptional();
  const client = api ?? injected;
  const [state, setState] = useState<UpdateViewState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.getState().then((next) => {
      if (!cancelled) setState(next);
    });
    const unsubscribe = client.onProgress(() => {
      void client.getState().then((latest) => {
        if (!cancelled) setState(latest);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  const run = useCallback(
    async (action: (target: UpdateApi) => Promise<UpdateViewState>) => {
      if (!client) return;
      setBusy(true);
      try {
        setState(await action(client));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  if (!client) return <UpdateUnavailable />;
  if (state === null) return <p className="ec-settings__hint">正在读取更新状态…</p>;

  const settled = state.lastSettled;
  const rolledBack = settled !== null && settled.stage === 'rolled-back';
  const rollbackFailed = settled !== null && settled.stage === 'rollback-failed';

  return (
    <div className="ec-update">
      <section className="ec-update__block">
        <h3>版本信息</h3>
        <dl className="ec-update__facts">
          <dt>当前版本</dt>
          <dd>{state.currentVersion}</dd>
          <dt>更新通道</dt>
          <dd>{state.channel === 'beta' ? 'beta（含预发布）' : 'stable（仅正式版）'}</dd>
          <dt>上次检查</dt>
          <dd>{formatTime(state.lastCheckAt)}</dd>
          <dt>状态</dt>
          <dd aria-live="polite">{PHASE_TEXT[state.phase]}</dd>
        </dl>
        {state.phase === 'downloading' && state.percent !== undefined ? (
          <div
            className="ec-update__progress"
            role="progressbar"
            aria-valuenow={state.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="下载进度"
          >
            <div className="ec-update__progress-bar" style={{ width: `${state.percent}%` }} />
            <span>{state.percent}%</span>
          </div>
        ) : null}
        {state.message !== null ? <p className="ec-update__message">{state.message}</p> : null}
      </section>

      <section className="ec-update__block">
        <h3>检查与安装</h3>
        <div className="ec-update__actions">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void run((target) => target.check())}
          >
            检查更新
          </Button>
          {state.available !== null ? (
            <>
              <Button disabled={busy} onClick={() => void run((target) => target.install())}>
                立即更新
              </Button>
              {state.allowDeferred ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run((target) => target.defer(state.available!.version))}
                >
                  稍后提醒
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
        {state.available !== null ? (
          <div className="ec-update__available">
            <p>{`新版本 ${state.available.version}`}</p>
            {state.available.notes !== undefined && state.available.notes !== '' ? (
              <p className="ec-update__notes">{state.available.notes}</p>
            ) : null}
          </div>
        ) : (
          <p className="ec-settings__hint">当前已是最新版本。</p>
        )}
      </section>

      <section className="ec-update__block">
        <h3>更新偏好</h3>
        <label className="ec-update__switch">
          <Switch
            checked={state.autoCheck}
            onChange={(next) => void run((target) => target.saveSettings({ autoCheck: next }))}
            label="自动检查更新"
          />
          <span>自动检查更新</span>
        </label>
        <label className="ec-update__switch">
          <Switch
            checked={state.autoDownload}
            onChange={(next) => void run((target) => target.saveSettings({ autoDownload: next }))}
            label="自动下载更新"
          />
          <span>发现新版本后自动下载（仅提示重启）</span>
        </label>
        <label className="ec-update__switch">
          <Switch
            checked={state.allowDeferred}
            onChange={(next) => void run((target) => target.saveSettings({ allowDeferred: next }))}
            label="允许稍后提醒"
          />
          <span>允许「稍后提醒」（关闭后新版本必须立即处理）</span>
        </label>
      </section>

      {settled !== null ? (
        <section className="ec-update__block ec-update__history">
          <h3>上次更新</h3>
          {rolledBack ? (
            <p className="ec-update__rolled-back">
              {`${settled.toVersion} 启动失败，已自动回滚到 ${settled.fromVersion}。`}
              {settled.lastError !== null ? `原因：${settled.lastError}` : ''}
            </p>
          ) : rollbackFailed ? (
            <p className="ec-update__rollback-failed">
              {`${settled.toVersion} 启动失败且自动回滚未成功${settled.lastError !== null ? `（${settled.lastError}）` : ''}，请重新安装 ${settled.fromVersion} 安装包。`}
            </p>
          ) : (
            <p>{`已更新到 ${settled.toVersion}（${formatTime(settled.updatedAt)}）`}</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
