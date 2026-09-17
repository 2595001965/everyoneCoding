/**
 * 导入后自愈领域类型（T8-04 / FR-PKG-10）。
 *
 * 自愈三件事：① 重定位代码锚点（路径/行号漂移）② 修复文档与记忆的失效链接
 * ③ 清点缺失/损坏附件。结果统一进 `HealingReport`，可导出。
 */

import type { AnchorKind } from '@ec/ai';

/** 可重定位锚点的最小输入（对齐 @ec/ai 的 CodeAnchor 子集） */
export interface RelocatableAnchor {
  id: string;
  elementId: string | null;
  symbol: string | null;
  /** 包内/工程相对路径（相对项目代码根，正斜杠） */
  filePath: string;
  kind: AnchorKind;
  /** 原行号（对比是否变化用） */
  startLine: number | null;
  endLine: number | null;
}

export type AnchorRelocationStatus =
  /** 位置已更新（行号或路径变化且重新定位成功） */
  | 'relocated'
  /** 原位置仍然有效（未漂移） */
  | 'unchanged'
  /** 找不到唯一位置，给出了候选（需用户确认） */
  | 'ambiguous'
  /** 彻底丢失（文件与符号都不在） */
  | 'missing';

export interface AnchorRelocation {
  anchorId: string;
  symbol: string | null;
  oldFilePath: string;
  newFilePath: string | null;
  newStartLine: number | null;
  newEndLine: number | null;
  status: AnchorRelocationStatus;
  /** 定位依据 / 失败原因（展示用） */
  reason: string;
  /** ambiguous 时的候选（供 UI 逐条采纳） */
  candidates: Array<{ filePath: string; symbol: string; startLine: number; endLine: number }>;
}

/** 记忆 ↔ 文档 / 记忆 ↔ 记忆 关联（对齐包内 links.json 的条目） */
export interface HealingLink {
  /** 链接标识（links.json 内的 index 或 id） */
  linkId: string;
  sourceType: 'memory' | 'document';
  sourceId: string;
  targetType: 'memory' | 'document';
  targetId: string;
  /** 链接创建时的目标名（重定位的依据之一，可缺省） */
  targetName?: string | undefined;
}

export type LinkFixStatus = 'ok' | 'fixed' | 'unresolvable';

export interface LinkFixOutcome extends HealingLink {
  status: LinkFixStatus;
  /** fixed 时为重定向后的新目标 id */
  newTargetId: string | null;
  detail: string;
}

export interface AttachmentIssue {
  /** 内容寻址文件名：<sha256>.<ext> */
  hashName: string;
  status: 'missing' | 'corrupted';
  detail: string;
}

/** 自愈汇总报告（可导出） */
export interface HealingReport {
  anchors: {
    outcomes: AnchorRelocation[];
    total: number;
    /** (relocated + unchanged) / total，0–1 */
    successRate: number;
  };
  links: {
    outcomes: LinkFixOutcome[];
    fixedCount: number;
    unresolvableCount: number;
  };
  attachments: {
    issues: AttachmentIssue[];
    checked: number;
  };
  /** 建议操作（中文，面向用户） */
  suggestions: string[];
}
