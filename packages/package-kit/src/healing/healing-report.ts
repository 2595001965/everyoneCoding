/**
 * 自愈报告（T8-04 要点 4 / FR-PKG-10：自愈报告可查看与导出）。
 *
 * 汇总锚点重定位 / 链接修复 / 附件清点三部分，生成建议操作（中文），
 * 支持 JSON 与 Markdown 两种导出格式。
 */
import type {
  AnchorRelocation,
  AttachmentIssue,
  HealingReport,
  LinkFixOutcome,
} from './healing-types';
import { relocationSuccessRate } from './anchor-relocator';

export interface HealingInputs {
  anchors: readonly AnchorRelocation[];
  links: readonly LinkFixOutcome[];
  attachmentIssues: readonly AttachmentIssue[];
  attachmentsChecked: number;
}

/** 汇总生成报告（含建议操作） */
export function buildHealingReport(inputs: HealingInputs): HealingReport {
  const anchorsAmbiguous = inputs.anchors.filter((a) => a.status === 'ambiguous').length;
  const anchorsMissing = inputs.anchors.filter((a) => a.status === 'missing').length;
  const fixedLinks = inputs.links.filter((l) => l.status === 'fixed').length;
  const unresolvableLinks = inputs.links.filter((l) => l.status === 'unresolvable').length;
  const missingAttachments = inputs.attachmentIssues.filter((i) => i.status === 'missing').length;
  const corruptedAttachments = inputs.attachmentIssues.filter(
    (i) => i.status === 'corrupted',
  ).length;

  const suggestions: string[] = [];
  if (anchorsAmbiguous > 0) {
    suggestions.push(`有 ${anchorsAmbiguous} 个锚点存在多个疑似位置，请在锚点面板逐一确认候选`);
  }
  if (anchorsMissing > 0) {
    suggestions.push(
      `有 ${anchorsMissing} 个锚点彻底丢失（符号与注释标记都不在），建议重新生成对应代码或删除失效锚点`,
    );
  }
  if (unresolvableLinks > 0) {
    suggestions.push(`有 ${unresolvableLinks} 条关联无法自动修复，请在记忆中心手动重新关联`);
  }
  if (missingAttachments > 0) {
    suggestions.push(
      `有 ${missingAttachments} 个附件缺失，可从原设备导出包或本地其他位置补齐后重新校验`,
    );
  }
  if (corruptedAttachments > 0) {
    suggestions.push(
      `有 ${corruptedAttachments} 个附件内容校验失败（哈希不符），建议删除后从可靠副本重新导入`,
    );
  }
  if (suggestions.length === 0) {
    suggestions.push('自愈完成：未发现需要人工处理的问题');
  }

  return {
    anchors: {
      outcomes: [...inputs.anchors],
      total: inputs.anchors.length,
      successRate: relocationSuccessRate(inputs.anchors),
    },
    links: {
      outcomes: [...inputs.links],
      fixedCount: fixedLinks,
      unresolvableCount: unresolvableLinks,
    },
    attachments: {
      issues: [...inputs.attachmentIssues],
      checked: inputs.attachmentsChecked,
    },
    suggestions,
  };
}

const STATUS_LABELS: Record<AnchorRelocation['status'], string> = {
  relocated: '已重定位',
  unchanged: '位置未变',
  ambiguous: '需人工确认',
  missing: '已丢失',
};

const LINK_STATUS_LABELS: Record<LinkFixOutcome['status'], string> = {
  ok: '有效',
  fixed: '已修复',
  unresolvable: '无法自动修复',
};

/** 导出为 JSON（机器可读，供审计） */
export function serializeHealingReport(report: HealingReport): string {
  return JSON.stringify(report, null, 2);
}

/** 导出为 Markdown（人类可读，供查看） */
export function healingReportToMarkdown(report: HealingReport): string {
  const lines: string[] = [];
  lines.push('# 导入自愈报告');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 锚点重定位');
  lines.push('');
  lines.push(
    `- 总数 ${report.anchors.total}，成功率 ${(report.anchors.successRate * 100).toFixed(1)}%（目标 ≥90%）`,
  );
  for (const outcome of report.anchors.outcomes) {
    const location =
      outcome.status === 'relocated' && outcome.newFilePath !== null
        ? `${outcome.oldFilePath} → ${outcome.newFilePath}:${outcome.newStartLine ?? '?'}`
        : outcome.oldFilePath;
    lines.push(
      `- [${STATUS_LABELS[outcome.status]}] ${outcome.symbol ?? '(无符号)'} @ ${location} — ${outcome.reason}`,
    );
  }
  lines.push('');
  lines.push('## 关联修复');
  lines.push('');
  lines.push(
    `- 自动修复 ${report.links.fixedCount} 条，无法自动修复 ${report.links.unresolvableCount} 条`,
  );
  for (const outcome of report.links.outcomes) {
    if (outcome.status === 'ok') continue;
    lines.push(
      `- [${LINK_STATUS_LABELS[outcome.status]}] ${outcome.sourceType}/${outcome.sourceId} → ${outcome.targetType}/${outcome.targetId}：${outcome.detail}`,
    );
  }
  lines.push('');
  lines.push('## 附件清点');
  lines.push('');
  lines.push(
    `- 检查 ${report.attachments.checked} 个，问题 ${report.attachments.issues.length} 个`,
  );
  for (const issue of report.attachments.issues) {
    lines.push(
      `- [${issue.status === 'missing' ? '缺失' : '损坏'}] ${issue.hashName}：${issue.detail}`,
    );
  }
  lines.push('');
  lines.push('## 建议操作');
  lines.push('');
  for (const suggestion of report.suggestions) {
    lines.push(`- ${suggestion}`);
  }
  lines.push('');
  return lines.join('\n');
}
