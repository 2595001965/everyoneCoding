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
export function createDefaultParserRegistry(
  opts?: { ocr?: OcrPort | null } | undefined,
): DocParserRegistry {
  const imageParser = makeImageParser(opts?.ocr ?? null);
  const hasOcr = opts?.ocr != null;
  const parsers: DocParser[] = [
    { format: 'markdown', parse: (i) => parseMarkdown(i) },
    { format: 'txt', parse: (i) => parseTxt(i) },
    { format: 'docx', parse: (i) => parseDocx(i) },
    { format: 'pdf', parse: (i) => parsePdf(i) },
    imageParser,
  ];
  return {
    get: (f) => parsers.find((p) => p.format === f) ?? null,
    /**
     * `supported()` 的契约是「**当前环境**可解析的格式」，而 image 解析器在没有 OCR 端口时
     * 只能在解析阶段报"暂不支持"。若这里仍把 image 列为支持，导入界面会给出一个必然失败的选项，
     * 因此未注入 OCR 时如实把它排除（`get('image')` 仍返回解析器本身，解析时的报错文案不变）。
     */
    supported: () =>
      hasOcr
        ? parsers.map((p) => p.format)
        : parsers.map((p) => p.format).filter((f) => f !== 'image'),
  };
}
