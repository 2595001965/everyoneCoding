import * as React from 'react';
import { Button } from '@ec/ui';

import { usePreviewApi, type RuntimeStateSnapshot, type RunPlanSuggestion } from './preview-api';

/**
 * V2-D02 运行计划面板：识别 → 确认 → 启动 → 精准停止。
 *
 * 信任确认（V2-SRC-05）在这里落地：识别结果先展示命令与子工程，用户点「确认并启动」
 * 才会执行安装/启动；运行实例按 runtimeId 精准停止，不碰其它工程的进程。
 * Mock 不在这里回退——真实后端失败时接口如实报错，模拟数据由工具栏显式切换。
 */
function statusLabel(status: RuntimeStateSnapshot['status']): string {
  const labels: Record<RuntimeStateSnapshot['status'], string> = {
    preparing: '准备中（安装依赖）',
    starting: '启动中',
    ready: '就绪',
    degraded: '降级（部分服务退出）',
    stopping: '停止中',
    stopped: '已停止',
    failed: '失败',
  };
  return labels[status];
}

export function RunPlanPanel(): JSX.Element {
  const api = usePreviewApi();
  const [suggestion, setSuggestion] = React.useState<RunPlanSuggestion | null>(null);
  const [runtime, setRuntime] = React.useState<RuntimeStateSnapshot | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const supported = typeof api.runPlan === 'function' && typeof api.startRun === 'function';

  const reloadRuntime = React.useCallback(() => {
    void api.state().then((s) => setRuntime(s.runtime ?? null));
  }, [api]);

  const detect = React.useCallback(() => {
    if (!supported) return;
    void api
      .runPlan()
      .then(setSuggestion)
      .catch((cause: unknown) => setMessage(`识别失败：${String(cause)}`));
  }, [api, supported]);

  React.useEffect(() => {
    detect();
    reloadRuntime();
    const timer = window.setInterval(reloadRuntime, 1000);
    return () => window.clearInterval(timer);
  }, [detect, reloadRuntime]);

  if (!supported) {
    return (
      <section className="ec-runplan-panel" aria-label="运行计划">
        <h3>运行计划</h3>
        <p className="ec-runplan-panel__empty" role="status">
          当前外壳未提供运行计划能力（需受控进程端口）。
        </p>
      </section>
    );
  }

  const run = (fn: () => Promise<unknown>, okMessage: string): void => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    void fn()
      .then(() => {
        setMessage(okMessage);
        reloadRuntime();
      })
      .catch((cause: unknown) => setMessage(String(cause)))
      .finally(() => setBusy(false));
  };

  const plan = suggestion?.plan ?? null;
  const confirmable =
    (suggestion?.subProjects.map((sub) => sub.suggestedRunPlan).filter((p) => p !== null).length ??
      0) > 0;
  const runnable =
    runtime !== null && ['ready', 'starting', 'preparing', 'degraded'].includes(runtime.status);

  return (
    <section className="ec-runplan-panel" aria-label="运行计划">
      <header className="ec-runplan-panel__header">
        <h3>运行计划</h3>
        {runtime !== null && (
          <span
            className="ec-runplan-panel__status"
            data-status={runtime.status}
            data-testid="runtime-status"
            role="status"
          >
            {statusLabel(runtime.status)} · {runtime.runtimeId.slice(-6)}
          </span>
        )}
      </header>

      {suggestion === null ? (
        <p className="ec-runplan-panel__empty" role="status">
          尚未识别：点击「识别运行计划」扫描工程（只读，不执行脚本）。
        </p>
      ) : (
        <>
          {suggestion.subProjects.length > 0 && (
            <ul className="ec-runplan-panel__subs" data-testid="runplan-subprojects">
              {suggestion.subProjects.map((sub) => (
                <li key={sub.subProjectId}>
                  {sub.framework ?? sub.language ?? 'unknown'}（{sub.role}
                  {sub.packageManager !== null ? ` · ${sub.packageManager}` : ''}）
                </li>
              ))}
            </ul>
          )}
          {plan !== null && (
            <dl className="ec-runplan-panel__steps" data-testid="runplan-steps">
              {plan.services.map((svc) => (
                <div key={svc.serviceId}>
                  <dt>{svc.role}</dt>
                  <dd>
                    {svc.command}
                    {svc.args.length > 0 ? ` ${svc.args.join(' ')}` : ''}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {suggestion.notes.length > 0 && (
            <ul className="ec-runplan-panel__notes">
              {suggestion.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="ec-runplan-panel__actions">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const next = await api.runPlan();
              setSuggestion(next);
            }, '识别完成（执行前仍需确认）')
          }
        >
          识别运行计划
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !confirmable}
          data-testid="confirm-and-run"
          onClick={() =>
            run(async () => {
              if (suggestion === null) return;
              // 契约：RunPlan 按子工程一份（各自携带 cwd）；确认载荷是计划数组
              const plans = suggestion.subProjects
                .map((sub) => sub.suggestedRunPlan)
                .filter((plan) => plan !== null);
              if (plans.length === 0) return;
              await api.confirmRunPlan(plans, suggestion.plannerVersion);
              await api.startRun();
            }, '运行实例已按确认计划启动')
          }
        >
          确认并启动
        </Button>
        <Button
          size="sm"
          disabled={busy || runtime === null || !runnable}
          data-testid="stop-runtime"
          onClick={() => run(() => api.stopRuntime(runtime?.runtimeId), '运行实例已停止')}
        >
          停止
        </Button>
      </div>

      {runtime !== null && runtime.services.length > 0 && (
        <ul className="ec-runplan-panel__services" data-testid="runtime-services">
          {runtime.services.map((svc) => (
            <li key={svc.serviceId}>
              <span>{svc.kind === 'frontend' ? '前端' : '后端'}</span>
              <span>{svc.serviceId}</span>
              <span>{svc.baseUrl ?? '未监听'}</span>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(
                    () => api.restartService(runtime.runtimeId, svc.serviceId),
                    `服务 ${svc.serviceId} 已重启`,
                  )
                }
              >
                重启
              </Button>
            </li>
          ))}
        </ul>
      )}

      {message !== null && (
        <p className="ec-runplan-panel__message" role="status" data-testid="runplan-message">
          {message}
        </p>
      )}
    </section>
  );
}
