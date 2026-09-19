/**
 * DrilldownPanel（T9-02 / FR-WSP-06）：指标下钻明细面板。
 *
 * 明细行可带 refId——点击后交给外层跳转（如"记忆条目数"下钻到记忆中心对应筛选）。
 */

import { Button } from '@ec/ui';

import type { MetricDetail } from './workspace-api';

export interface DrilldownPanelProps {
  detail: MetricDetail | null;
  loading: boolean;
  onClose: () => void;
  /** 点击明细行跳转到对应视图（refId 为关联对象 id） */
  onOpenRow?:
    ((key: MetricDetail['key'], refId: string | undefined, label: string) => void) | undefined;
}

export function DrilldownPanel({
  detail,
  loading,
  onClose,
  onOpenRow,
}: DrilldownPanelProps): JSX.Element | null {
  if (!detail && !loading) return null;

  return (
    <aside className="ec-ws__drill" aria-label="指标明细">
      <header className="ec-ws__drill-head">
        <h3>{detail ? detail.title : '正在加载明细…'}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </header>

      {detail ? (
        <ul className="ec-ws__drill-list">
          {detail.rows.map((row) => (
            <li key={`${row.label}-${row.refId ?? ''}`}>
              {row.refId ? (
                <button type="button" onClick={() => onOpenRow?.(detail.key, row.refId, row.label)}>
                  {row.label}
                </button>
              ) : (
                <span>{row.label}</span>
              )}
              <span className="ec-ws__drill-value">{row.value}</span>
            </li>
          ))}
          {detail.rows.length === 0 ? <li className="ec-ws__hint">暂无明细数据。</li> : null}
        </ul>
      ) : null}
    </aside>
  );
}
