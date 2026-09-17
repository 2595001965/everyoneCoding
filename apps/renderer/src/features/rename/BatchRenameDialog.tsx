/**
 * 批量重命名对话框（T7-05 要点 5，FR-UNI-14）。
 *
 * 两种模式（Tabs）：
 * - 「多选对象批量改名」：每行一个受控 Input 填新名，生成预览后逐对象展示 diff 摘要；
 * - 「一键全项目命名规范化」：无输入，说明"规范名不变，只按命名规则重新对齐八类投影"。
 * 生成预览调用 planBatch；被阻断（blocked 非空）时禁用「确认执行」；执行调用 runBatch。
 */
import { useCallback, useEffect, useState } from 'react';

import type { BatchPlan, BatchRenameResult } from '@ec/registry';
import { Button, EmptyState, Input, Spinner, Tabs, Tag } from '@ec/ui';

import { useRenameApi } from './rename-api';
import type { RenameApi, RenameTarget } from './rename-api';
import './components.css';

export interface BatchRenameDialogProps {
  api?: RenameApi;
  targets: readonly RenameTarget[];
  open: boolean;
  onClose: () => void;
}

type Mode = 'batch' | 'normalize';

export function BatchRenameDialog(props: BatchRenameDialogProps): JSX.Element {
  const { api, targets, open, onClose } = props;
  const injected = useRenameApi();
  const client = api ?? injected;

  const [mode, setMode] = useState<Mode>('batch');
  const [names, setNames] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const target of targets) initial[target.registryId] = target.canonicalName;
    return initial;
  });
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<BatchRenameResult | null>(null);

  useEffect(() => {
    if (!open) {
      setPlan(null);
      setExecResult(null);
    }
  }, [open]);

  const runPlan = useCallback(async (): Promise<void> => {
    setPlan(null);
    setExecResult(null);
    setPlanning(true);
    try {
      const next =
        mode === 'normalize'
          ? await client.planBatch({ normalize: true })
          : await client.planBatch({
              items: targets.map((target) => ({
                registryId: target.registryId,
                newName: names[target.registryId] ?? target.canonicalName,
              })),
            });
      setPlan(next);
    } finally {
      setPlanning(false);
    }
  }, [client, mode, names, targets]);

  const blocked = plan !== null && plan.blocked.length > 0;

  const runExec = useCallback(async (): Promise<void> => {
    if (plan === null) return;
    setExecuting(true);
    setExecResult(null);
    try {
      const result = await client.runBatch({ batchId: plan.batchId });
      setExecResult(result);
    } finally {
      setExecuting(false);
    }
  }, [client, plan]);

  const setName = (registryId: string, value: string): void => {
    setNames((prev) => ({ ...prev, [registryId]: value }));
  };

  const changedProjections = (step: BatchPlan['steps'][number]): number =>
    step.report.projectionChanges.filter((change) => change.changed).length;

  return (
    <div className="ec-rename-root" data-testid="batch-rename">
      {!open && <span className="ec-rename-muted">对话框未打开</span>}

      <Tabs
        items={[
          { key: 'batch', label: '多选对象批量改名' },
          { key: 'normalize', label: '一键全项目命名规范化' },
        ]}
        value={mode}
        onChange={(next) => setMode(next as Mode)}
      >
        {(active) => (
          <div className="ec-rename-block">
            {active === 'batch' &&
              targets.map((target) => (
                <div className="ec-rename-batch-row" key={target.registryId}>
                  <span>{target.canonicalName}</span>
                  <Input
                    value={names[target.registryId] ?? target.canonicalName}
                    aria-label={`${target.canonicalName} 的新名称`}
                    placeholder="请输入新名称"
                    onChange={(value) => setName(target.registryId, value)}
                  />
                </div>
              ))}
            {active === 'normalize' && (
              <p className="ec-rename-muted">
                规范名不变，只按当前命名规则重新对齐八类投影（如把历史遗留的拼音投影纠正为规范的 PascalCase）。
              </p>
            )}
          </div>
        )}
      </Tabs>

      <div className="ec-rename-actions">
        <Button onClick={() => void runPlan()} disabled={planning} data-testid="batch-plan">
          生成预览
        </Button>
        {plan !== null && (
          <Button
            variant="primary"
            disabled={executing || blocked}
            data-testid="batch-execute"
            onClick={() => void runExec()}
          >
            确认执行
          </Button>
        )}
        <Button onClick={onClose}>关闭</Button>
      </div>

      {planning && (
        <div className="ec-rename-inline">
          <Spinner size={18} />
          <span>正在生成预览…</span>
        </div>
      )}

      {plan !== null && (
        <div className="ec-rename-block">
          <div className="ec-rename-muted">
            共 {plan.steps.length} 个对象，计划修改 {plan.totals.totalChanges} 处（已选 {plan.totals.selectedChanges} 处）
            {plan.normalize && '，模式：全项目命名规范化'}
          </div>

          {plan.steps.map((step) => (
            <div className="ec-rename-batch-step" data-testid="batch-step" key={step.registryId}>
              <div className="ec-rename-inline">
                <strong>{step.oldName}</strong>
                <span className="ec-rename-muted">→</span>
                <strong>{step.newName}</strong>
              </div>
              <span className="ec-rename-muted">
                计划修改 {step.report.totals.total} 处 · 投影变更 {changedProjections(step)} 项
              </span>
            </div>
          ))}

          {blocked && (
            <div className="ec-rename-batch-step ec-rename-batch-step--blocked" data-testid="batch-blocked">
              <strong className="ec-rename-danger">
                存在 {plan.blocked.length} 个非法名称，已整批阻断（未执行任何变更）：
              </strong>
              <ul>
                {plan.blocked.map((item) => (
                  <li key={item.registryId} className="ec-rename-danger">
                    {item.registryId} → {item.newName}：
                    {item.violations.map((violation, index) => (
                      <span key={index}> {violation.detail}</span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {execResult !== null && (
            <div className="ec-rename-block" data-testid="batch-result">
              {execResult.ok ? (
                <Tag color="success">执行成功</Tag>
              ) : execResult.rolledBack ? (
                <Tag color="warning">已整体回滚，未产生部分修改</Tag>
              ) : (
                <Tag color="danger">执行失败</Tag>
              )}
              <span className="ec-rename-muted">成功修改 {execResult.applied} 处</span>
              {execResult.failures.length > 0 && (
                <span className="ec-rename-danger">{execResult.failures.join('；')}</span>
              )}
            </div>
          )}
        </div>
      )}

      {!planning && plan === null && targets.length === 0 && (
        <EmptyState title="暂无可重命名对象" description="请先在设计器中选择要批量改名的元素 / 页面 / 功能" />
      )}
    </div>
  );
}
