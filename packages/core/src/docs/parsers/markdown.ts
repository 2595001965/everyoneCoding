/**
 * Markdown 解析（T9-04 / FR-DOC-01）。
 *
 * 零依赖、纯字符串处理：保留标题层级（#1~6 → level 1~6，统一截断到 1~3 用于大纲），
 * 生成可跳转锚点（中文保留、空格转 `-`、去重加序号）。
 */

import type { DocSection, ParsedDocument } from '../doc-types';

/** 标题 slug：中文保留、空格与空白转 `-`、去掉非法字符、去重加序号 */
export function slugifyHeading(heading: string): string {
  let slug = heading.trim().toLowerCase();
  slug = slug.replace(/\s+/g, '-');
  // 保留字母（含中文 \p{L}）、数字、下划线、连字符
  slug = slug.replace(/[^\p{L}\p{N}_-]+/gu, '');
  slug = slug.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'section';
}

function makeAnchorFactory(): (heading: string) => string {
  const used = new Map<string, number>();
  return (heading: string): string => {
    const base = slugifyHeading(heading);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };
}

/** 解析 Markdown 文本为结构化文档 */
export function parseMarkdown(input: {
  raw: string | Uint8Array;
  fileName?: string | undefined;
}): ParsedDocument {
  const text = typeof input.raw === 'string' ? input.raw : new TextDecoder().decode(input.raw);
  const lines = text.split(/\r?\n/);
  const sections: DocSection[] = [];
  const makeAnchor = makeAnchorFactory();

  let title = '';
  let anyHeading = false;
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

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const heading = headingMatch[2]!.trim();
      flush();
      if (level === 1 && !title) title = heading;
      anyHeading = true;
      current = { index: sections.length, level, heading, anchor: makeAnchor(heading), text: '' };
      buffer = [];
      continue;
    }
    if (!anyHeading) {
      // 首个标题出现前的正文归到一个无标题块
      if (!current) {
        current = { index: sections.length, level: 0, heading: '', anchor: 'intro', text: '' };
        buffer = [];
      }
    }
    buffer.push(line);
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
