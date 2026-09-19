/**
 * 数据流链路浮层（T6-07 要点 3 / FR-PRV-07）：元素 → 事件 → 接口 → 后端处理 → 数据回写 → 元素渲染。
 *
 * - 环节顺序由 `DataFlowStep.kind` 的固定次序决定，不依赖端口返回顺序；
 * - 失败环节用错误色，并保留动画类名（`ec-dataflow__step` + CSS 过渡）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Modal } from '@ec/ui';

import { useNavApi, type DataFlowStep } from './nav-api';

export interface DataFlowOverlayProps {
  elementId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 环节固定次序（与验收口径一致） */
const KIND_ORDER: readonly DataFlowStep['kind'][] = [
  'element',
  'event',
  'api',
  'backend',
  'writeback',
  'render',
];

const KIND_LABELS: Record<DataFlowStep['kind'], string> = {
  element: '元素',
  event: '事件',
  api: '接口',
  backend: '后端处理',
  writeback: '数据回写',
  render: '元素渲染',
};

export function DataFlowOverlay({
  elementId,
  open,
  onOpenChange,
}: DataFlowOverlayProps): JSX.Element | null {
  const api = useNavApi();
  const [steps, setSteps] = useState<DataFlowStep[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (elementId === null) return;
    setLoading(true);
    setSteps([...(await api.dataFlow(elementId))]);
    setLoading(false);
  }, [api, elementId]);

  useEffect(() => {
    if (!open || elementId === null) return;
    void load();
  }, [open, elementId, load]);

  /** 按固定次序排列，缺失环节以占位展示（链路完整性一眼可见） */
  const ordered = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({
        kind,
        step: steps.find((item) => item.kind === kind) ?? null,
      })),
    [steps],
  );

  if (!open) return null;

  const failed = steps.filter((step) => !step.ok).length;

  return (
    <Modal open onOpenChange={onOpenChange} title={`数据流链路 · ${elementId ?? ''}`} size="lg">
      <div className="ec-dataflow" data-testid="dataflow-overlay">
        {loading && <span role="status">读取链路中…</span>}
        {!loading && steps.length === 0 && (
          <span role="status">该元素暂时没有可展示的数据流记录。</span>
        )}

        {!loading && steps.length > 0 && (
          <>
            <div className="ec-dataflow__summary" role="status" data-testid="dataflow-summary">
              共 {ordered.length} 个环节{failed > 0 ? `，其中 ${failed} 个失败` : '，链路完整'}
            </div>
            <ol
              className="ec-dataflow__steps"
              data-testid="dataflow-steps"
              style={{ listStyle: 'none', padding: 0, margin: 0 }}
            >
              {ordered.map(({ kind, step }, index) => (
                <li
                  key={kind}
                  className={
                    step !== null && !step.ok
                      ? 'ec-dataflow__step ec-dataflow__step--error'
                      : 'ec-dataflow__step'
                  }
                  data-testid={`dataflow-step-${kind}`}
                  data-order={index}
                  data-ok={step === null ? 'missing' : String(step.ok)}
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'baseline',
                    padding: '6px 8px',
                    marginBottom: 4,
                    borderRadius: 6,
                    background:
                      step !== null && !step.ok
                        ? 'var(--ec-color-danger-subtle, #ffebe9)'
                        : 'var(--ec-color-bg-subtle)',
                    borderLeft: `3px solid ${step !== null && !step.ok ? 'var(--ec-color-danger)' : 'var(--ec-color-success)'}`,
                    transition: 'background 120ms ease-in-out',
                  }}
                >
                  <span style={{ color: 'var(--ec-color-text-secondary)', minWidth: 64 }}>
                    {KIND_LABELS[kind]}
                  </span>
                  <span style={{ flex: 1 }} data-testid={`dataflow-label-${kind}`}>
                    {step?.label ?? '（该环节无记录）'}
                    {step?.detail !== null && step?.detail !== undefined && (
                      <span style={{ color: 'var(--ec-color-text-secondary)' }}>
                        {' '}
                        · {step.detail}
                      </span>
                    )}
                  </span>
                  {step?.at !== null && step?.at !== undefined && (
                    <span style={{ color: 'var(--ec-color-text-secondary)' }}>{step.at}ms</span>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </Modal>
  );
}
