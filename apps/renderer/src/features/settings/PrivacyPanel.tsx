/**
 * PrivacyPanel（T9-03 / FR-SET-06）：遥测与隐私。
 *
 * 硬约束：
 * - 匿名使用数据**默认关闭**，开启需显式授权
 * - AI 请求内容默认不上传服务端统计
 * - 一键清除本地遥测与缓存数据，并提供"清除后残留自检"（可断言为 0）
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Switch } from '@ec/ui';

import { useSettings, type TelemetryInspection } from './settings-api';

export function PrivacyPanel(): JSX.Element {
  const api = useSettings();
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [inspection, setInspection] = useState<TelemetryInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInspection(await api.inspectLocalTelemetry());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleTelemetry = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        await api.setTelemetry(enabled);
        setTelemetryEnabled(enabled);
        setNotice(enabled ? '已开启匿名使用数据上报（可在下方随时关闭）' : '已关闭匿名使用数据上报');
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  const clear = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api.clearLocalTelemetry();
      setInspection(result);
      const clean = result.telemetryRecords === 0 && result.cacheBytes === 0;
      setNotice(clean ? '已清除本地遥测与缓存数据，自检无残留' : '清除后仍有残留，请重试或联系支持');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api]);

  return (
    <section className="ec-settings__panel" aria-label="隐私">
      <h2>隐私</h2>

      <label className="ec-settings__field">
        <span>发送匿名使用数据（默认关闭，需显式开启）</span>
        <Switch
          checked={telemetryEnabled}
          disabled={busy}
          onChange={(checked) => void toggleTelemetry(checked)}
          aria-label="匿名使用数据"
        />
      </label>

      <ul className="ec-settings__list">
        <li>AI 请求内容默认不上传服务端统计（仅可选上报 token 用量）。</li>
        <li>崩溃报告仅包含堆栈与版本号，不含项目内容。</li>
        <li>本产品不做云同步、不做远程配置下发、不生成分享链接。</li>
      </ul>

      <h3>本地数据自检</h3>
      <p className="ec-settings__hint" role="status">
        {inspection
          ? `遥测记录 ${inspection.telemetryRecords} 条，缓存 ${(inspection.cacheBytes / 1024).toFixed(1)} KB`
          : '正在自检…'}
      </p>

      <div className="ec-settings__actions">
        <Button variant="danger" loading={busy} onClick={() => void clear()}>
          一键清除本地数据
        </Button>
        <Button variant="ghost" onClick={() => void refresh()}>
          重新自检
        </Button>
      </div>

      {notice ? (
        <p className="ec-settings__notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <p className="ec-settings__error">{error}</p> : null}
    </section>
  );
}
