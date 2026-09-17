/**
 * 预算设置面板（T10-01）：月度/日预算配置 + 阈值告警 + 超限拒绝提示。
 * 面板状态文案由 `@ec/ai` 的 `budgetAlertView` 纯函数生成（含"本月至今日用量"）。
 */

import { useEffect, useState } from 'react';

import { budgetAlertView, budgetConfigFromInput, emptyBudgetView, validateBudgetInput, type BudgetDecision } from '@ec/ai';
import { Button, Input } from '@ec/ui';
import { useUsageOptional } from './usage-api';
import './usage.css';

export function BudgetSettings(): JSX.Element {
  const api = useUsageOptional();
  const [daily, setDaily] = useState('');
  const [monthly, setMonthly] = useState('');
  const [alertRatio, setAlertRatio] = useState('0.8');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<BudgetDecision | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!api) return;
      const current = await api.getBudget();
      if (cancelled) return;
      setDaily(current.dailyUsd === null ? '' : String(current.dailyUsd));
      setMonthly(current.monthlyUsd === null ? '' : String(current.monthlyUsd));
      setAlertRatio(String(current.alertRatio));
      setDecision(await api.budgetDecision());
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const save = async (): Promise<void> => {
    if (!api) return;
    const validation = validateBudgetInput({ dailyUsd: daily, monthlyUsd: monthly, alertRatio });
    if (validation) {
      setError(validation);
      setSaved(false);
      return;
    }
    setError(null);
    const next = budgetConfigFromInput({ dailyUsd: daily, monthlyUsd: monthly, alertRatio });
    await api.setBudget(next);
    setDecision(await api.budgetDecision());
    setSaved(true);
  };

  if (!api) {
    return (
      <div className="ec-budget">
        <p className="ec-usage__hint">预算端口未装配。初始化后可以在这里设置用量预算与告警阈值。</p>
      </div>
    );
  }

  const view = decision ? budgetAlertView(decision) : emptyBudgetView();

  return (
    <div className="ec-budget">
      <div className={`ec-budget__state ec-budget__state--${view.level}`} role="status">
        {view.message}
        {view.hint ? <span className="ec-budget__state-hint">{view.hint}</span> : null}
      </div>

      <div className="ec-budget__form">
        <label className="ec-budget__field">
          <span>日预算（美元，留空不限）</span>
          <Input aria-label="日预算" value={daily} onChange={setDaily} placeholder="如 5" />
        </label>
        <label className="ec-budget__field">
          <span>月预算（美元，留空不限）</span>
          <Input aria-label="月预算" value={monthly} onChange={setMonthly} placeholder="如 100" />
        </label>
        <label className="ec-budget__field">
          <span>告警阈值（0~1，默认 0.8）</span>
          <Input aria-label="告警阈值" value={alertRatio} onChange={setAlertRatio} placeholder="0.8" />
        </label>
        <Button onClick={() => void save()}>保存预算</Button>
        {saved ? <span className="ec-budget__saved">已保存</span> : null}
        {error ? <span className="ec-budget__error">{error}</span> : null}
      </div>
    </div>
  );
}
