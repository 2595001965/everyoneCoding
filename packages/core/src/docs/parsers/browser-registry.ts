/**
 * 浏览器解析器注册表（仅 markdown / txt 纯逻辑，绝不触碰 node:zlib）。
 * 供渲染层 `createBrowserParserRegistry` 使用；docx / pdf / image-OCR 在浏览器侧不导入。
 */

import type { DocParser, DocParserRegistry } from '../doc-types';
import { parseMarkdown } from './markdown';
import { parseTxt } from './txt';

/** 构造浏览器安全解析器注册表（markdown / txt） */
export function createBrowserParserRegistry(): DocParserRegistry {
  const parsers: DocParser[] = [
    { format: 'markdown', parse: (i) => parseMarkdown(i) },
    { format: 'txt', parse: (i) => parseTxt(i) },
  ];
  return {
    get: (f) => parsers.find((p) => p.format === f) ?? null,
    supported: () => parsers.map((p) => p.format),
  };
}
