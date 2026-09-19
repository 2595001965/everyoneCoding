/**
 * 锚点重定位（T8-04 要点 1 / FR-PKG-10）。
 *
 * 复用 `@ec/ai` 的 `relocate`（T4-06 的漂移修复主入口），定位优先级一致：
 * 代码注释标记（`// @everyonecoding:anchor <elementId>`，最强事实）→
 * 完整符号名 → 容器内短名 → 相似度候选（只给建议，绝不自动改）。
 *
 * 导入后场景的扩展：锚点记录的**文件本身可能被移动**。此时先按
 * 「注释标记 → 符号文本」在项目文件清单里搜索新位置：
 * - 恰好一个文件命中 → 在新文件里继续 relocate；
 * - 多个命中 → ambiguous（列出候选，UI 逐条采纳）；
 * - 零命中 → missing。
 *
 * 成功率口径：`(relocated + unchanged) / total`——unchanged 表示锚点仍然有效，
 * 也算"导入后无需人工干预"。目标 ≥90%（验收：20 个漂移锚点）。
 */
import { findMarker, relocate, type AnchorKind } from '@ec/ai';

import type { AnchorRelocation, RelocatableAnchor } from './healing-types';

/** 代码文件读取端口（外壳装配；测试用内存假实现） */
export interface HealingCodePort {
  /** 读取工程文件内容（路径相对项目代码根，正斜杠）；不存在返回 null */
  readFile(projectId: string, relativePath: string): string | null;
  /** 列出项目全部代码文件（相对路径） */
  listFiles(projectId: string): string[];
}

const ANCHOR_MARKER_TAG = '@everyonecoding:anchor';

/**
 * 重定位一批锚点。
 *
 * `projectId` 用于在文件被移动时圈定搜索范围（不跨项目联动，D-07）。
 */
export function relocateAnchors(
  anchors: readonly RelocatableAnchor[],
  projectId: string,
  port: HealingCodePort,
): AnchorRelocation[] {
  const fileList = port.listFiles(projectId);
  const results: AnchorRelocation[] = [];

  for (const anchor of anchors) {
    results.push(relocateOne(anchor, projectId, port, fileList));
  }
  return results;
}

function relocateOne(
  anchor: RelocatableAnchor,
  projectId: string,
  port: HealingCodePort,
  fileList: string[],
): AnchorRelocation {
  const kind: AnchorKind = anchor.kind;
  // ① 原路径还在：直接走 @ec/ai 的 relocate（标记 → 符号 → 候选）
  const content = port.readFile(projectId, anchor.filePath);
  if (content !== null) {
    const result = relocate({
      anchor: {
        elementId: anchor.elementId,
        symbol: anchor.symbol,
        filePath: anchor.filePath,
        kind,
      },
      content,
    });
    if (result.status === 'ok') {
      const moved = result.startLine !== anchor.startLine;
      return {
        anchorId: anchor.id,
        symbol: result.symbol,
        oldFilePath: anchor.filePath,
        newFilePath: anchor.filePath,
        newStartLine: result.startLine,
        newEndLine: result.endLine,
        status: moved ? 'relocated' : 'unchanged',
        reason: result.reason,
        candidates: [],
      };
    }
    if (result.status === 'ambiguous') {
      return {
        anchorId: anchor.id,
        symbol: null,
        oldFilePath: anchor.filePath,
        newFilePath: null,
        newStartLine: null,
        newEndLine: null,
        status: 'ambiguous',
        reason: `${result.reason}（候选：${result.candidates.map((c) => `${c.symbol}@${c.startLine}`).join('、')}）`,
        candidates: result.candidates.map((candidate) => ({
          filePath: anchor.filePath,
          symbol: candidate.symbol,
          startLine: candidate.startLine,
          endLine: candidate.endLine,
        })),
      };
    }
    // missing：原文件在但符号没了——继续尝试全项目搜索（可能被移动）
    return searchAcrossProject(anchor, projectId, port, fileList, '原文件中已找不到该符号');
  }

  // ② 原路径不在：文件可能被移动/重命名——全项目搜索
  return searchAcrossProject(
    anchor,
    projectId,
    port,
    fileList,
    '原文件不存在（可能被移动或重命名）',
  );
}

/** 在项目文件清单里搜索新位置：注释标记优先，其次符号文本 */
function searchAcrossProject(
  anchor: RelocatableAnchor,
  projectId: string,
  port: HealingCodePort,
  fileList: string[],
  prefixReason: string,
): AnchorRelocation {
  const markerHits: string[] = [];
  const symbolHits: string[] = [];
  const symbolNeedle = anchor.symbol ?? '';

  for (const path of fileList) {
    if (path === anchor.filePath) continue;
    const fileContent = port.readFile(projectId, path);
    if (fileContent === null) continue;
    const hasMarker =
      anchor.elementId !== null && anchor.elementId.length > 0
        ? findMarker(fileContent, anchor.elementId) !== null ||
          fileContent.includes(`${ANCHOR_MARKER_TAG} ${anchor.elementId}`)
        : false;
    if (hasMarker) {
      markerHits.push(path);
      continue;
    }
    if (symbolNeedle.length > 0 && fileContent.includes(symbolNeedle)) {
      symbolHits.push(path);
    }
  }

  // 注释标记是"写在代码里的事实"，最优先；其次符号文本
  const candidates = markerHits.length > 0 ? markerHits : symbolHits;
  if (candidates.length === 0) {
    return {
      anchorId: anchor.id,
      symbol: null,
      oldFilePath: anchor.filePath,
      newFilePath: null,
      newStartLine: null,
      newEndLine: null,
      status: 'missing',
      reason: `${prefixReason}，且全项目搜索无命中`,
      candidates: [],
    };
  }
  if (candidates.length > 1) {
    return {
      anchorId: anchor.id,
      symbol: null,
      oldFilePath: anchor.filePath,
      newFilePath: null,
      newStartLine: null,
      newEndLine: null,
      status: 'ambiguous',
      reason: `${prefixReason}，在 ${candidates.length} 个文件中找到疑似位置，需人工确认`,
      candidates: candidates.map((filePath) => ({
        filePath,
        symbol: symbolNeedle,
        startLine: 1,
        endLine: 1,
      })),
    };
  }

  // 唯一命中：在新文件里继续精确定位
  const newPath = candidates[0]!;
  const newContent = port.readFile(projectId, newPath);
  if (newContent === null) {
    return {
      anchorId: anchor.id,
      symbol: null,
      oldFilePath: anchor.filePath,
      newFilePath: null,
      newStartLine: null,
      newEndLine: null,
      status: 'missing',
      reason: `${prefixReason}，命中文件读取失败`,
      candidates: [],
    };
  }
  const result = relocate({
    anchor: {
      elementId: anchor.elementId,
      symbol: anchor.symbol,
      filePath: newPath,
      kind: anchor.kind,
    },
    content: newContent,
  });
  if (result.status === 'ok') {
    return {
      anchorId: anchor.id,
      symbol: result.symbol,
      oldFilePath: anchor.filePath,
      newFilePath: newPath,
      newStartLine: result.startLine,
      newEndLine: result.endLine,
      status: 'relocated',
      reason: `${prefixReason}；${result.reason}`,
      candidates: [],
    };
  }
  // 新文件里也只够"疑似"：标记命中但符号索引不到等——作为 ambiguous 上报
  return {
    anchorId: anchor.id,
    symbol: null,
    oldFilePath: anchor.filePath,
    newFilePath: newPath,
    newStartLine: null,
    newEndLine: null,
    status: 'ambiguous',
    reason: `${prefixReason}；在新文件 ${newPath} 中找到了疑似位置但无法精确定位`,
    candidates: [{ filePath: newPath, symbol: symbolNeedle, startLine: 1, endLine: 1 }],
  };
}

/** 成功率：(relocated + unchanged) / total（验收口径 ≥0.9） */
export function relocationSuccessRate(relocations: readonly AnchorRelocation[]): number {
  if (relocations.length === 0) return 1;
  const ok = relocations.filter((r) => r.status === 'relocated' || r.status === 'unchanged').length;
  return ok / relocations.length;
}
