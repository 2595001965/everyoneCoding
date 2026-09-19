/**
 * DOCX 解析（T9-04 / FR-DOC-01）。
 *
 * 零依赖手写：docx 本质是 ZIP，用 `node:zlib` 的 `inflateRawSync` 解压 +
 * 手写 ZIP 中央目录解析（参考 `packages/package-kit/src/container/zip.ts` 思路，但**不 import 那个包**）。
 * 提取 `word/document.xml`，按 `w:pStyle` 的 Heading1/2/3 与 `w:outlineLvl` 判定标题层级，
 * 保留段落文本。不支持图片内嵌文本（OCR 走独立端口）。
 */

import { inflateRawSync } from 'node:zlib';

import type { DocSection, ParsedDocument } from '../doc-types';

/* ------------------------------- ZIP 读取（精简版） ------------------------------- */

const LOCAL_FILE_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function readU16(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8)) >>> 0;
}

function readU32(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function findEocd(buf: Uint8Array): number {
  // 从尾部向前搜索 EOCD 签名（注释长度通常 0）
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (readU32(buf, i) === EOCD_SIG) return i;
  }
  throw new Error('DOCX 解析失败：未找到 ZIP 中央目录结束符');
}

function parseCentralDirectory(buf: Uint8Array): ZipEntry[] {
  const eocd = findEocd(buf);
  const cdOffset = readU32(buf, eocd + 16);
  const cdCount = readU16(buf, eocd + 10);
  const entries: ZipEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < cdCount; i += 1) {
    if (readU32(buf, cursor) !== CENTRAL_DIR_SIG) break;
    const method = readU16(buf, cursor + 10);
    const compressedSize = readU32(buf, cursor + 20);
    const nameLen = readU16(buf, cursor + 28);
    const extraLen = readU16(buf, cursor + 30);
    const commentLen = readU16(buf, cursor + 32);
    const localOffset = readU32(buf, cursor + 42);
    const nameBytes = buf.subarray(cursor + 46, cursor + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    entries.push({ name, method, compressedSize, localOffset });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(buf: Uint8Array, entry: ZipEntry): Uint8Array {
  // 跳到本地文件头，读取真实 nameLen/extraLen/data
  const off = entry.localOffset;
  if (readU32(buf, off) !== LOCAL_FILE_SIG) {
    throw new Error(`DOCX 解析失败：本地文件头签名不匹配（${entry.name}）`);
  }
  const nameLen = readU16(buf, off + 26);
  const extraLen = readU16(buf, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 8) return inflateRawSync(data);
  if (entry.method === 0) return data; // 存储（无压缩）
  throw new Error(`DOCX 解析失败：不支持的压缩方式 ${entry.method}（${entry.name}）`);
}

/* ------------------------------- XML 文本解码 ------------------------------- */

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function paragraphLevel(pStyleVal: string | null, outlineLvl: string | null): number {
  if (pStyleVal) {
    const m = /Heading(\d+)/.exec(pStyleVal);
    if (m) {
      const n = Number(m[1]);
      return Math.min(3, Math.max(1, n));
    }
  }
  if (outlineLvl !== null) {
    const n = Number(outlineLvl);
    if (Number.isFinite(n)) return Math.min(3, Math.max(1, n + 1));
  }
  return 0;
}

interface ParsedParagraph {
  level: number;
  text: string;
}

function parseDocumentXml(xml: string): ParsedParagraph[] {
  const paragraphs: ParsedParagraph[] = [];
  const pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  let match: RegExpExecArray | null;
  while ((match = pRe.exec(xml)) !== null) {
    const p = match[0]!;
    const pStyleMatch = /<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(p);
    const outlineMatch = /<w:outlineLvl\b[^>]*\bw:val="([^"]+)"/.exec(p);
    const level = paragraphLevel(pStyleMatch?.[1] ?? null, outlineMatch?.[1] ?? null);

    const textParts: string[] = [];
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(p)) !== null) {
      textParts.push(decodeXmlEntities(tm[1] ?? ''));
    }
    const text = textParts.join('').replace(/\s+/g, ' ').trim();
    paragraphs.push({ level, text });
  }
  return paragraphs;
}

/* ------------------------------- 入口 ------------------------------- */

/** 解析 DOCX 字节为结构化文档 */
export function parseDocx(input: {
  raw: string | Uint8Array;
  fileName?: string | undefined;
}): ParsedDocument {
  const bytes = typeof input.raw === 'string' ? new TextEncoder().encode(input.raw) : input.raw;
  const entries = parseCentralDirectory(bytes);
  const docEntry = entries.find((e) => e.name === 'word/document.xml');
  if (!docEntry) throw new Error('DOCX 解析失败：缺少 word/document.xml');

  const xmlBytes = readEntryData(bytes, docEntry);
  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  const paragraphs = parseDocumentXml(xml);

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

  for (const para of paragraphs) {
    if (para.level > 0) {
      flush();
      if (!title) title = para.text;
      current = {
        index: sections.length,
        level: para.level,
        heading: para.text,
        anchor: `sec-${sections.length}`,
        text: '',
      };
      buffer = [];
    } else if (para.text) {
      if (!current) {
        current = {
          index: sections.length,
          level: 0,
          heading: '',
          anchor: `sec-${sections.length}`,
          text: '',
        };
        buffer = [];
      }
      buffer.push(para.text);
    }
  }
  flush();

  if (sections.length === 0) {
    sections.push({ index: 0, level: 0, heading: '', anchor: 'doc', text: '' });
  }
  if (!title) {
    const firstHeading = sections.find((section) => section.heading);
    title = firstHeading ? firstHeading.heading : '未命名文档';
  }

  return { title: title.trim() || '未命名文档', sections };
}
