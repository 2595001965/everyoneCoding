/**
 * 导出进度展示（T8-02）。
 *
 * 全部从 ExportProgressSnapshot 渲染：阶段中文标签、processed/total 进度条、
 * 当前文件、对象计数、排除统计（体积下降率）、脱敏命中数、失败清单。
 */

import { Progress } from '@ec/ui';

import type { ExportProgressSnapshot, ExportStage } from './package-api';

const STAGE_LABELS: Record<ExportStage, string> = {
  enumerating: '枚举中',
  excluding: '排除中',
  redacting: '脱敏中',
  writing: '写入中',
  encrypting: '加密中',
  done: '完成',
  failed: '失败',
};

export interface ExportProgressProps {
  snapshot: ExportProgressSnapshot | null;
}

export function ExportProgress({ snapshot }: ExportProgressProps): React.ReactElement {
  if (snapshot === null) {
    return <div className="ec-export-progress" data-testid="export-progress" data-state="idle" />;
  }

  const pct = snapshot.total > 0 ? Math.round((snapshot.processed / snapshot.total) * 100) : 0;
  const reductionPct =
    snapshot.excludeStats !== null ? Math.round(snapshot.excludeStats.reductionRatio * 1000) / 10 : 0;
  const redactionCount = snapshot.redactionFindings.length;

  return (
    <div className="ec-export-progress" data-testid="export-progress" data-state={snapshot.stage}>
      <div className="ec-export-progress__stage">阶段：{STAGE_LABELS[snapshot.stage]}</div>
      <Progress value={snapshot.processed} max={snapshot.total > 0 ? snapshot.total : 100} indeterminate={snapshot.total < 0} />
      <div className="ec-export-progress__meta">
        进度：{snapshot.processed}/{snapshot.total < 0 ? '?' : snapshot.total}（{pct}%）
      </div>
      {snapshot.currentFile !== null && (
        <div className="ec-export-progress__file">当前文件：{snapshot.currentFile}</div>
      )}
      <div className="ec-export-progress__counts">
        对象计数：项目 {snapshot.counts.projects} · 记忆 {snapshot.counts.memoryItems} · 文档{' '}
        {snapshot.counts.documents} · 页面 {snapshot.counts.pages} · 代码 {snapshot.counts.codeFiles} · 附件{' '}
        {snapshot.counts.attachments}
      </div>
      {snapshot.excludeStats !== null && (
        <div className="ec-export-progress__exclude">体积下降率：{reductionPct}%</div>
      )}
      <div className="ec-export-progress__redaction">脱敏命中：{redactionCount} 处</div>
      {snapshot.failures.length > 0 && (
        <div className="ec-export-progress__failures" data-testid="export-failures">
          失败 {snapshot.failures.length} 项：
          <ul>
            {snapshot.failures.map((failure, index) => (
              <li key={`${failure.path}-${index}`}>
                {failure.path}：{failure.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
