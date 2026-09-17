import * as React from 'react';

import { EmptyState, Tag } from '@ec/ui';

import type { PageDsl, Platform } from '../dsl/types';
import { PLATFORMS } from '../dsl/types';
import { checkConsistency, groupByFeature, workbenchHint, type ConsistencyIssueCode } from './consistency-check';

/**
 * 多端一致性面板（T3-11 要点 5）。
 *
 * 展示「缺失端 / 缺失页面 / 结构差异 / 命名差异」四类提示，并在顶部给出工作台级汇总文案；
 * 支持按功能分组查看，方便逐个功能补齐。
 */

export const CONSISTENCY_CODE_LABELS: Record<ConsistencyIssueCode, string> = {
  MISSING_PLATFORM: '缺失端',
  MISSING_PAGE: '缺失页面',
  STRUCTURE_DIFF: '结构差异',
  NAMING_DIFF: '命名差异',
};

export interface ConsistencyPanelProps {
  pages: readonly PageDsl[];
  /** 项目所选目标端；缺省视为七端全选 */
  targetPlatforms?: readonly Platform[];
  className?: string;
}

export function ConsistencyPanel({ pages, targetPlatforms = PLATFORMS, className }: ConsistencyPanelProps): React.ReactElement {
  const report = React.useMemo(() => checkConsistency({ pages, targetPlatforms }), [pages, targetPlatforms]);
  const hint = workbenchHint(report);
  const grouped = React.useMemo(() => groupByFeature(report), [report]);

  return (
    <div className={className} data-testid="consistency-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>多端一致性校验</strong>
        <Tag color="info">{`目标端 ${report.summary.targetPlatforms.length} 个`}</Tag>
        <Tag color={report.summary.missingPlatforms.length === 0 ? 'success' : 'warning'}>
          {`已覆盖 ${report.summary.coveredPlatforms.length} 个`}
        </Tag>
        {report.summary.missingPlatforms.length > 0 && (
          <Tag color="warning" data-testid="missing-platforms">{`缺失端：${report.summary.missingPlatforms.join('、')}`}</Tag>
        )}
      </header>

      <p data-testid="consistency-hint" role={report.issues.length > 0 ? 'status' : undefined} style={{ fontSize: 12, margin: 0 }}>
        {hint ?? '多端一致性：全部通过，没有发现缺失或差异'}
      </p>

      {report.issues.length === 0 ? (
        <EmptyState title="一致" description="所选目标端的设计结构、页面与命名均一致。" />
      ) : (
        <>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
            {(Object.keys(CONSISTENCY_CODE_LABELS) as ConsistencyIssueCode[]).map((code) => (
              <li key={code} data-testid={`consistency-count-${code}`}>
                <Tag color={report.summary.counts[code] > 0 ? 'warning' : 'info'}>{`${CONSISTENCY_CODE_LABELS[code]} ${report.summary.counts[code]}`}</Tag>
              </li>
            ))}
          </ul>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {grouped.map((group) => (
              <section key={group.featureId ?? '__project__'} data-testid={`consistency-group-${group.featureId ?? 'project'}`} style={{ border: '1px solid #e9ecef', borderRadius: 6, padding: 8 }}>
                <header style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
                  {group.featureId === null ? '项目级' : `功能 ${group.featureId}`}
                </header>
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {group.issues.map((issue, index) => (
                    <li key={`${issue.code}-${index}`} data-issue-code={issue.code}>
                      <Tag color={issue.severity === 'warning' ? 'warning' : 'info'}>{CONSISTENCY_CODE_LABELS[issue.code]}</Tag>
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
