/**
 * PDF 解析（T9-04 / FR-DOC-01）。
 *
 * 零依赖手写的最小 PDF 文本提取：解析 `stream ... endstream` 中 FlateDecode
 * （`zlib.inflateSync`，失败时按未压缩处理）与 `Tj` / `TJ` 操作符取文本；
 * 标题层级用 `Tf` 字号启发式（比正文均值大者升为 heading，按大小映射 1-3 级）；
 * 输出 `{ sections, pages }` 供"页码定位"。
 *
 * 覆盖范围说明（如实降级）：仅处理单字节 Latin-1 内容流的文本操作符，不解析
 * 加密 / 对象流（ObjStm）/ 复杂编码（如 Identity-H 复合字体）。遇不支持的对象
 * 静默跳过，不让整体解析失败。
 *
 * 实现要点：PDF 二进制流用 `latin1` 解码仅用于正则定位，提取字节时**直接对
 * Uint8Array 切片**（latin1 是字节↔码元 1:1 映射，字符下标即字节下标），
 * 避免经 UTF-8 编码器回填导致二进制损坏。
 */

import { inflateSync } from 'node:zlib';

import type { DocSection, ParsedDocument } from '../doc-types';

interface PdfToken {
  text: string;
  size: number;
  page: number | null;
}

function decodePdfString(literal: string): string {
  let out = '';
  let i = 0;
  while (i < literal.length) {
    const ch = literal[i]!;
    if (ch === '\\') {
      const next = literal[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === '(') out += '(';
      else if (next === ')') out += ')';
      else if (next === '\\') out += '\\';
      else if (next === '\r' || next === '\n') {
        // 行续：忽略
      } else if (next !== undefined && /[0-7]/.test(next)) {
        const oct = literal.slice(i + 1, i + 4);
        out += String.fromCodePoint(parseInt(oct, 8) || 0);
        i += oct.length;
      } else {
        out += next ?? '';
      }
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** 从内容流文本中按出现顺序抽取文本片段，并携带其"当时"的字号（Tf 决定） */
function scanContent(content: string): Array<{ text: string; size: number }> {
  const out: Array<{ text: string; size: number }> = [];
  let size = 0;
  const re = /(\/[\w]+)\s+([\d.]+)\s+Tf|\((?:[^()\\]|\\.)*\)\s+Tj|\[([\s\S]*?)\]\s+TJ/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[2] !== undefined) {
      size = parseFloat(m[2]!);
      continue;
    }
    if (m[0]!.endsWith('Tj')) {
      const lit = m[0]!.slice(1, m[0]!.lastIndexOf(')'));
      out.push({ text: decodePdfString(lit), size });
    } else {
      const inner = m[3] ?? '';
      const strRe = /\((?:[^()\\]|\\.)*\)/g;
      let sm: RegExpExecArray | null;
      while ((sm = strRe.exec(inner)) !== null) {
        const lit = sm[0]!.slice(1, -1);
        out.push({ text: decodePdfString(lit), size });
      }
    }
  }
  return out;
}

interface PdfObject {
  num: number;
  dict: string;
  streamBytes: Uint8Array | null;
}

function isFlate(dict: string): boolean {
  return /Filter\s*\/FlateDecode/.test(dict) || /Filter\s*\[\s*[^\]]*FlateDecode/.test(dict);
}

/** 解析 PDF 对象；latin1 解码仅用于正则定位，字节切片直接取自 Uint8Array */
function parseObjects(bytes: Uint8Array): PdfObject[] {
  const text = new TextDecoder('latin1').decode(bytes);
  const out: PdfObject[] = [];
  const objRe = /(\d+) \d+ obj([\s\S]*?)endobj/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text)) !== null) {
    const num = parseInt(m[1]!, 10);
    const bodyStr = m[2] ?? '';
    const bodyAbs = m.index + m[0]!.indexOf(bodyStr);
    const streamRel = bodyStr.indexOf('stream');
    let streamBytes: Uint8Array | null = null;
    let dict = bodyStr;
    if (streamRel >= 0) {
      dict = bodyStr.slice(0, streamRel);
      const nl = bodyStr.indexOf('\n', streamRel);
      const dataStartAbs = bodyAbs + (nl >= 0 ? nl + 1 : streamRel + 6);
      const esRel = bodyStr.lastIndexOf('endstream');
      const dataEndAbs = bodyAbs + (esRel >= 0 ? esRel : bodyStr.length);
      // 去掉 endstream 前的换行（保留二进制完整性）
      let end = dataEndAbs;
      while (end > dataStartAbs && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end -= 1;
      streamBytes = bytes.subarray(dataStartAbs, end);
    }
    out.push({ num, dict, streamBytes });
  }
  return out;
}

function decodeContent(obj: PdfObject): string {
  if (!obj.streamBytes) return '';
  let data = obj.streamBytes;
  if (isFlate(obj.dict)) {
    try {
      data = inflateSync(data);
    } catch {
      data = obj.streamBytes; // 解压失败按未压缩处理
    }
  }
  return new TextDecoder('latin1').decode(data);
}

function buildPageMap(objs: PdfObject[]): Map<number, number> {
  const map = new Map<number, number>();
  let pageIndex = 0;
  for (const obj of objs) {
    if (!/Type\s*\/Page\b/.test(obj.dict)) continue;
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) continue; // 跳过页面树节点
    pageIndex += 1;
    const contentsMatch = /Contents\s*(?:(\d+) \d+ R|\[([\s\dR]+)\])/.exec(obj.dict);
    if (!contentsMatch) continue;
    if (contentsMatch[1]) {
      map.set(parseInt(contentsMatch[1], 10), pageIndex);
    } else if (contentsMatch[2]) {
      const nums = contentsMatch[2]!.match(/\d+/g) ?? [];
      for (let i = 0; i < nums.length; i += 2) map.set(parseInt(nums[i]!, 10), pageIndex);
    }
  }
  return map;
}

function fileBytesToUint8Array(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? new TextEncoder().encode(input) : input;
}

/** 解析 PDF 字节为结构化文档 */
export function parsePdf(input: { raw: string | Uint8Array; fileName?: string | undefined }): ParsedDocument {
  const bytes = fileBytesToUint8Array(input.raw);
  const objs = parseObjects(bytes);
  const pageMap = buildPageMap(objs);

  const tokens: PdfToken[] = [];
  const pageTexts = new Map<number, string[]>();
  for (const obj of objs) {
    const content = decodeContent(obj);
    if (!content) continue;
    const page = pageMap.get(obj.num) ?? null;
    for (const frag of scanContent(content)) {
      const trimmed = frag.text.replace(/\s+/g, ' ').trim();
      if (!trimmed) continue;
      tokens.push({ text: trimmed, size: frag.size, page });
      if (page !== null) {
        const arr = pageTexts.get(page) ?? [];
        arr.push(trimmed);
        pageTexts.set(page, arr);
      }
    }
  }

  if (tokens.length === 0) {
    return {
      title: '未命名文档',
      sections: [{ index: 0, level: 0, heading: '', anchor: 'doc', text: '' }],
      pages: [],
    };
  }

  const sizes = tokens.map((t) => t.size).filter((s) => s > 0);
  const meanSize = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
  const maxSize = sizes.length ? Math.max(...sizes) : 0;

  const classify = (token: PdfToken): { isHeading: boolean; level: number } => {
    const big = token.size > meanSize * 1.12 && token.size >= maxSize * 0.6;
    const shortTitle = token.text.length > 0 && token.text.length <= 80;
    if (!big || !shortTitle) return { isHeading: false, level: 0 };
    const ratio = maxSize > 0 ? token.size / maxSize : 1;
    const level = ratio >= 0.9 ? 1 : ratio >= 0.75 ? 2 : 3;
    return { isHeading: true, level };
  };

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

  for (const token of tokens) {
    const { isHeading, level } = classify(token);
    if (isHeading) {
      flush();
      if (!title) title = token.text;
      current = {
        index: sections.length,
        level,
        heading: token.text,
        anchor: `sec-${sections.length}`,
        text: '',
        page: token.page ?? undefined,
      };
      buffer = [];
    } else {
      if (!current) {
        current = {
          index: sections.length,
          level: 0,
          heading: '',
          anchor: `sec-${sections.length}`,
          text: '',
          page: token.page ?? undefined,
        };
        buffer = [];
      }
      buffer.push(token.text);
    }
  }
  flush();

  if (sections.length === 0) {
    sections.push({ index: 0, level: 0, heading: '', anchor: 'doc', text: tokens.map((t) => t.text).join('\n') });
  }
  if (!title) {
    const firstHeading = sections.find((section) => section.heading);
    title = firstHeading ? firstHeading.heading : tokens[0]!.text.slice(0, 60);
  }

  const pageList = [...pageTexts.keys()]
    .sort((a, b) => a - b)
    .map((index) => ({ index, text: (pageTexts.get(index) ?? []).join('\n') }));

  return { title: title.trim() || '未命名文档', sections, pages: pageList };
}
