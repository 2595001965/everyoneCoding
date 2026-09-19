/**
 * 纯文本解析（T9-04 / FR-DOC-01）。
 *
 * 零依赖启发式：用章节标记（第X章/节）、全大写行、短行 + 空行分隔推断标题层级。
 * 无标题时产出单 section（level 0），保证下游大纲/跳转不崩溃。
 */

import type { DocSection, ParsedDocument } from '../doc-types';

function isChapterLine(line: string): boolean {
  return /^第[一二三四五六七八九十百千0-9]+[章篇部](\s|$)/.test(line.trim());
}

function isSectionLine(line: string): boolean {
  return /^第[一二三四五六七八九十百千0-9]+[节条款](\s|$)/.test(line.trim());
}

/** 全 ASCII 大写（含数字/空格/连字符），长度 >= 3，视为标题 */
function isAllCapsLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 3 && /^[A-Z0-9 _-]+$/.test(trimmed) && /[A-Z]/.test(trimmed);
}

/** 短标题行：长度 <= 24、非空、不以句末标点结尾、且下一行是空行 */
function isShortHeadingLine(line: string, nextLine: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 24) return false;
  if (/[。.，.!?！？：:；;、]$/.test(trimmed)) return false;
  return nextLine.trim().length === 0;
}

/** 解析纯文本为结构化文档 */
export function parseTxt(input: {
  raw: string | Uint8Array;
  fileName?: string | undefined;
}): ParsedDocument {
  const text = typeof input.raw === 'string' ? input.raw : new TextDecoder().decode(input.raw);
  const lines = text.split(/\r?\n/);
  const sections: DocSection[] = [];

  let title = '';
  let current: DocSection | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current) {
      current.text = buffer.join('\n').trim();
      sections.push(current);
    }
    current = null;
    buffer = [];
  };

  const startSection = (level: number, heading: string): void => {
    flush();
    current = {
      index: sections.length,
      level,
      heading,
      anchor: `sec-${sections.length}`,
      text: '',
    };
    buffer = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    const nextLine = lines[i + 1] ?? '';

    if (trimmed.length === 0) {
      buffer.push(line);
      continue;
    }

    if (isChapterLine(trimmed)) {
      if (!title) title = trimmed;
      startSection(1, trimmed);
    } else if (isSectionLine(trimmed)) {
      startSection(2, trimmed);
    } else if (isAllCapsLine(trimmed)) {
      startSection(2, trimmed);
    } else if (isShortHeadingLine(line, nextLine)) {
      startSection(3, trimmed);
    } else {
      if (!current) startSection(0, '');
      buffer.push(line);
    }
  }
  flush();

  if (sections.length === 0) {
    sections.push({ index: 0, level: 0, heading: '', anchor: 'doc', text: text.trim() });
  }
  if (!title) {
    const firstHeading = sections.find((section) => section.heading);
    title = firstHeading
      ? firstHeading.heading
      : (lines.find((l) => l.trim()) ?? '未命名文档').slice(0, 60);
  }

  return { title: title.trim() || '未命名文档', sections };
}
