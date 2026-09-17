import * as React from 'react';
import { Button } from '@ec/ui';
import { DATA_SOURCE_LABELS, PREVIEW_MODES } from '@ec/preview';

import { usePreviewApi, type DeviceChannel, type PreviewState } from './preview-api';

/**
 * T6-05 预览工具栏：三种模式一键切换 + 服务地址 + 服务状态 + 数据来源标记
 * + 端口顺延提示 + 刷新耗时。
 */
export function PreviewToolbar(): JSX.Element {
  const api = usePreviewApi();
  const [state, setState] = React.useState<PreviewState | null>(null);
  const [devices, setDevices] = React.useState<readonly DeviceChannel[]>([]);
  const [elapsed, setElapsed] = React.useState<number | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // 稳定指纹：仅依赖 api 引用（不变），避免 useEffect 每帧重建对象导致死循环
  const apiKey = api.ready ? 'ready' : 'pending';

  const reload = React.useCallback(() => {
    void api.state().then(setState);
    void api.devices().then(setDevices);
  }, [api]);

  React.useEffect(() => {
    void apiKey;
    reload();
  }, [apiKey, reload]);

  const hasSelectedDevice = devices.some((d) => d.selected);
  const deviceBlocked = (state?.mode ?? 'static') === 'device' && !hasSelectedDevice;

  const handleMode = (mode: PreviewState['mode']): void => {
    if (busy) return;
    setBusy(true);
    void api
      .start(mode)
      .then(() => reload())
      .finally(() => setBusy(false));
  };

  const handleRefresh = (): void => {
    if (refreshing || deviceBlocked) return;
    setRefreshing(true);
    void api
      .refresh('手动刷新')
      .then((r) => {
        setElapsed(r.ok && r.data !== null ? r.data.elapsedMs : null);
        return reload();
      })
      .finally(() => setRefreshing(false));
  };

  const url = state?.url ?? null;
  const running = state?.running ?? false;
  const sourceLabel =
    state !== null && state.dataSource !== null ? DATA_SOURCE_LABELS[state.dataSource] : null;
  const notice = state !== null ? state.notice : null;

  return (
    <div className="ec-preview-toolbar" role="toolbar" aria-label="预览工具栏">
      <div className="ec-preview-toolbar__modes">
        {PREVIEW_MODES.map((m) => {
          const active = state?.mode === m.key;
          return (
            <button
              key={m.key}
              type="button"
              className={active ? 'ec-preview-toolbar__mode ec-preview-toolbar__mode--active' : 'ec-preview-toolbar__mode'}
              aria-pressed={active}
              title={m.description}
              disabled={busy}
              onClick={() => handleMode(m.key)}
            >
              <span className="ec-preview-toolbar__mode-label">{m.label}</span>
              <span className="ec-preview-toolbar__mode-desc">{m.description}</span>
            </button>
          );
        })}
      </div>

      <div className="ec-preview-toolbar__status">
        <span className={running ? 'ec-preview-toolbar__dot ec-preview-toolbar__dot--on' : 'ec-preview-toolbar__dot'}>
          {running ? '服务运行中' : '服务未运行'}
        </span>
        {url !== null && (
          <a className="ec-preview-toolbar__url" href={url} target="_blank" rel="noreferrer">
            {url}
          </a>
        )}
        {sourceLabel !== null && (
          <span className="ec-preview-toolbar__source" data-source={state?.dataSource ?? undefined}>
            数据来源：{sourceLabel}
          </span>
        )}
      </div>

      {notice !== null && notice.length > 0 && (
        <div className="ec-preview-toolbar__notice" role="status" data-testid="preview-notice">
          {notice}
        </div>
      )}

      <div className="ec-preview-toolbar__actions">
        <Button
          variant="primary"
          size="sm"
          loading={refreshing}
          disabled={deviceBlocked}
          onClick={handleRefresh}
        >
          刷新
        </Button>
        {elapsed !== null && (
          <span className="ec-preview-toolbar__elapsed" data-testid="refresh-elapsed">
            刷新耗时 {elapsed}ms
          </span>
        )}
        {deviceBlocked && (
          <span className="ec-preview-toolbar__hint" role="status">
            设备预览需先选择目标端
          </span>
        )}
      </div>
    </div>
  );
}
