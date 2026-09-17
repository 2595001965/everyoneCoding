/**
 * 默认解析器注册表（Node 全集：含 docx / pdf / image，依赖 node:zlib）。
 * 仅供 `docs/index.ts`（Node 入口）使用；浏览器入口请用 `browser-registry.ts`。
 */

import type { DocParser, DocParserRegistry, OcrPort } from '../doc-types';
import { parseDocx } from './docx';
import { parseMarkdown } from './markdown';
import { makeImageParser } from './image-ocr';
import { parsePdf } from './pdf';
import { parseTxt } from './txt';

/** 构造完整解析器注册表（image 未注入 OCR 端口时解析如实报"暂不支持"） */
export function createDefaultParserRegistry(opts?: { ocr?: OcrPort | null } | undefined): DocParserRegistry {
  const parsers: DocParser[] = [
    { format: 'markdown', parse: (i) => parseMarkdown(i) },
    { format: 'txt', parse: (i) => parseTxt(i) },
    { format: 'docx', parse: (i) => parseDocx(i) },
    { format: 'pdf', parse: (i) => parsePdf(i) },
    makeImageParser(opts?.ocr ?? null),
  ];
  return {
    get: (f) => parsers.find((p) => p.format === f) ?? null,
    supported: () => parsers.map((p) => p.format),
  };
}
