import { useCallback, useEffect, useState } from 'react';

import type { AiEventRecord, AiReadiness, FailoverPolicy } from '@ec/ai';

import { useAiSettings } from '../ai-settings-context';

/**
 * 可用性自检 + 容灾策略 + 运维事件（FR-MDL-10 / T12-08）。
 *
 * - 自检：没有配置时列出可执行的下一步，而不是等用户点「生成」才报错；
 * - 容灾：开关与连续失败阈值，与网关读的是同一份配置（主进程落库、重启后生效不丢）；
 * - 事件：最近的切换 / 重试 / 预算拒绝，文本在主进程已脱敏。
 *
 * 端口方法是可选的：测试替身或旧外壳未实现时整块不渲染。
 */

const EVENT_LABEL: Record<AiEventRecord['kind'], string> = {
  failover: '切换备用',
  degraded: '标记降级',
  recovered: '恢复',
  retry: '重试',
  'budget-exceeded': '预算拒绝',
  'budget-warning': '预算告警',
  error: '失败',
};

export function ReliabilityPanel(): JSX.Element | null {
  const api = useAiSettings();
  const [readiness, setReadiness] = useState<AiReadiness | null>(null);
  const [policy, setPolicy] = useState<FailoverPolicy | null>(null);
  const [events, setEvents] = useState<AiEventRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const supported = api.failoverPolicy !== undefined || api.readiness !== undefined;

  const reload = useCallback(async () => {
    try {
      const [nextReadiness, nextPolicy, nextEvents] = await Promise.all([
        api.readiness?.() ?? Promise.resolve(null),
        api.failoverPolicy?.() ?? Promise.resolve(null),
        api.recentEvents?.(20) ?? Promise.resolve([]),
      ]);
      setReadiness(nextReadiness);
      setPolicy(nextPolicy);
      setEvents(nextEvents);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  useEffect(() => {
    if (supported) void reload();
  }, [supported, reload]);

  if (!supported) return null;

  const patchPolicy = (patch: Partial<FailoverPolicy>): void => {
    if (api.setFailoverPolicy === undefined) return;
    void api
      .setFailoverPolicy(patch)
      .then((next) => setPolicy(next))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <section className="ec-ai__section" aria-label="可用性与容灾">
      <h2 className="ec-ai__section-title">可用性与容灾</h2>
      {error !== null ? <p className="ec-ai__error">{error}</p> : null}

      {readiness !== null && !readiness.ready ? (
        <div className="ec-ai__notice" role="status" data-testid="ec-ai-readiness-guide">
          <strong>还不能调用模型，按下面步骤完成配置：</strong>
          <ol>
            {readiness.steps.map((step) => (
              <li key={step.id}>
                {step.done ? '✓ ' : ''}
                {step.label}
                {step.done ? null : <span className="ec-ai__hint">（{step.action}）</span>}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {readiness !== null && readiness.ready ? (
        <p className="ec-ai__hint" data-testid="ec-ai-readiness-ok">
          {readiness.purposes
            .map((item) => `${item.label}：${item.modelName ?? '未绑定'}`)
            .join(' · ')}
        </p>
      ) : null}

      {policy !== null ? (
        <p className="ec-ai__hint">
          <label>
            <input
              type="checkbox"
              aria-label="启用多服务容灾"
              checked={policy.enabled}
              onChange={(event) => patchPolicy({ enabled: event.target.checked })}
            />{' '}
            主服务连续失败时自动切换到备用服务（按列表顺序）
          </label>{' '}
          <label>
            连续失败
            <input
              type="number"
              aria-label="切换阈值"
              min={1}
              max={20}
              value={policy.failureThreshold}
              style={{ width: 56, margin: '0 4px' }}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 1) patchPolicy({ failureThreshold: value });
              }}
            />
            次后切换
          </label>
        </p>
      ) : null}

      {events.length > 0 ? (
        <ul className="ec-ai__hint" data-testid="ec-ai-recent-events">
          {events.map((event, index) => (
            <li key={`${event.at}-${index}`}>
              {new Date(event.at).toLocaleTimeString()} · {EVENT_LABEL[event.kind]} ·{' '}
              {event.message}
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="ec-ai__btn-ghost" onClick={() => void reload()}>
        刷新
      </button>
    </section>
  );
}
