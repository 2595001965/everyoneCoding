/**
 * 自愈报告视图（T8-04 / FR-PKG-10：自愈报告可查看与导出）。
 *
 * 纯展示组件 + 锚点候选采纳：三段式（锚点 / 关联 / 附件）+ 建议操作，
 * 导出与重跑由调用方回调；ambiguous 锚点的候选采纳直接走
 * `usePackageApi().adoptAnchorCandidate`。
 */
import { useState } from 'react';
import { Button, EmptyState, Tag } from '@ec/ui';

import type {
  HealingAnchorOutcome,
  HealingAttachmentIssue,
  HealingLinkOutcome,
  HealingReportData,
} from './package-api';
import { usePackageApi } from './package-api';

const ANCHOR_STATUS_LABELS: Record<HealingAnchorOutcome['status'], string> = {
  relocated: '已重定位',
  unchanged: '位置未变',
  ambiguous: '需确认',
  missing: '已丢失',
};

const ANCHOR_STATUS_VARIANTS: Record<HealingAnchorOutcome['status'], 'success' | 'neutral' | 'warning' | 'danger'> = {
  relocated: 'success',
  unchanged: 'neutral',
  ambiguous: 'warning',
  missing: 'danger',
};

const LINK_STATUS_LABELS: Record<HealingLinkOutcome['status'], string> = {
  ok: '有效',
  fixed: '已修复',
  unresolvable: '未修复',
};

export interface HealingReportViewProps {
  report: HealingReportData | null;
  /** 报告导出回调（由外壳写盘） */
  onExport?: (() => void) | undefined;
  /** 重新自愈回调 */
  onRerun?: (() => void) | undefined;
  loading?: boolean | undefined;
}

export function HealingReportView(props: HealingReportViewProps): JSX.Element {
  const { report, onExport, onRerun, loading = false } = props;
  const [adoptedAnchors, setAdoptedAnchors] = useState<string[]>([]);

  if (loading) {
    return <EmptyState title="自愈进行中" description="正在重定位锚点、修复关联并清点附件…" />;
  }
  if (report === null) {
    return (
      <EmptyState
        title="尚无自愈报告"
        description="导入 .ecpkg 后自动运行自愈；也可以点击「重新自愈」对当前工作区手动执行。"
      />
    );
  }

  const successPercent = (report.anchors.successRate * 100).toFixed(1);
  const problematicLinks = report.links.outcomes.filter((outcome) => outcome.status !== 'ok');

  return (
    <div className="ec-healing-report" aria-label="导入自愈报告">
      <div className="ec-healing-report__header">
        <h3>导入自愈报告</h3>
        <div className="ec-healing-report__actions">
          <Button size="sm" onClick={onRerun}>
            重新自愈
          </Button>
          <Button size="sm" variant="primary" onClick={onExport}>
            导出报告
          </Button>
        </div>
      </div>

      <section aria-label="锚点重定位">
        <h4>
          锚点重定位（成功率 {successPercent}%，目标 ≥90%）
        </h4>
        <ul>
          {report.anchors.outcomes.map((outcome) => (
            <HealingAnchorRow
              key={outcome.anchorId}
              outcome={outcome}
              adopted={adoptedAnchors.includes(outcome.anchorId)}
              onAdopted={(anchorId) => setAdoptedAnchors((prev) => [...prev, anchorId])}
            />
          ))}
        </ul>
      </section>

      <section aria-label="关联修复">
        <h4>关联修复（自动修复 {report.links.fixedCount}，未修复 {report.links.unresolvableCount}）</h4>
        {problematicLinks.length === 0 ? (
          <p>全部关联有效，无需修复。</p>
        ) : (
          <ul>
            {problematicLinks.map((outcome) => (
              <li key={outcome.linkId}>
                <Tag color={outcome.status === 'fixed' ? 'success' : 'danger'}>
                  {LINK_STATUS_LABELS[outcome.status]}
                </Tag>{' '}
                {outcome.sourceType}/{outcome.sourceId} → {outcome.targetType}/{outcome.targetId}：{outcome.detail}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="附件清点">
        <h4>附件清点（检查 {report.attachments.checked} 个，问题 {report.attachments.issues.length} 个）</h4>
        {report.attachments.issues.length === 0 ? (
          <p>附件完整，无缺失或损坏。</p>
        ) : (
          <ul>
            {report.attachments.issues.map((issue: HealingAttachmentIssue) => (
              <li key={issue.hashName}>
                <Tag color={issue.status === 'missing' ? 'warning' : 'danger'}>
                  {issue.status === 'missing' ? '缺失' : '损坏'}
                </Tag>{' '}
                <code>{issue.hashName}</code>：{issue.detail}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="建议操作">
        <h4>建议操作</h4>
        <ul>
          {report.suggestions.map((suggestion) => (
            <li key={suggestion}>{suggestion}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function HealingAnchorRow(props: {
  outcome: HealingAnchorOutcome;
  adopted: boolean;
  onAdopted: (anchorId: string) => void;
}): JSX.Element {
  const { outcome, adopted, onAdopted } = props;
  const api = usePackageApi();
  const [adopting, setAdopting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAmbiguous = outcome.status === 'ambiguous';

  const adopt = async (filePath: string, symbol: string): Promise<void> => {
    if (api === null) {
      setError('端口未注入，无法采纳候选');
      return;
    }
    setAdopting(true);
    setError(null);
    try {
      const ok = await api.adoptAnchorCandidate(outcome.anchorId, filePath, symbol);
      if (ok) onAdopted(outcome.anchorId);
      else setError('采纳失败：目标位置已变化，请重新自愈');
    } finally {
      setAdopting(false);
    }
  };

  const location =
    outcome.status === 'relocated' && outcome.newFilePath !== null
      ? `${outcome.oldFilePath} → ${outcome.newFilePath}`
      : outcome.oldFilePath;

  const candidates = outcome.candidates ?? [];

  return (
    <li>
      <Tag color={ANCHOR_STATUS_VARIANTS[outcome.status]}>{ANCHOR_STATUS_LABELS[outcome.status]}</Tag>{' '}
      <code>{outcome.symbol ?? '(无符号)'}</code> @ <code>{location}</code> — {outcome.reason}
      {isAmbiguous && !adopted && (
        <span className="ec-healing-report__candidates">
          {candidates.length === 0 ? (
            <em>（无候选，请在锚点面板处理）</em>
          ) : (
            candidates.map((candidate) => (
              <Button
                key={`${candidate.filePath}:${candidate.startLine}:${candidate.symbol}`}
                size="sm"
                disabled={adopting}
                onClick={() => void adopt(candidate.filePath, candidate.symbol)}
              >
                采纳 {candidate.symbol}@{candidate.filePath}:{candidate.startLine}
              </Button>
            ))
          )}
        </span>
      )}
      {adopted && <Tag color="success">已采纳</Tag>}
      {error !== null && (
        <span role="alert" style={{ color: 'var(--ec-color-danger, #c0392b)' }}>
          {error}
        </span>
      )}
    </li>
  );
}
