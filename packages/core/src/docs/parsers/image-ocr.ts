/**
 * 图片 OCR 解析（T9-04 / FR-DOC-01）。
 *
 * 当前版本未接入 OCR 引擎：如实返回 `supported:false` + 原因，**绝不静默失败**。
 * 预留 `OcrPort` 供外壳注入（接入 OCR 引擎后换成真实识别）；注入后 `parseImageOcr`
 * 返回 `supported:true` 的结构化结果。端口类型 `OcrPort` 定义见 `doc-types.ts`。
 */

import type { DocSection, OcrPort, ParsedDocument } from '../doc-types';
import { DocDomainError } from '../doc-types';

export interface OcrUnsupportedResult {
  supported: false;
  reason: string;
}

export interface OcrSuccessResult {
  supported: true;
  title: string;
  sections: DocSection[];
}

export type OcrResult = OcrUnsupportedResult | OcrSuccessResult;

/** OCR 暂未接入时的统一原因文案（供 UI 引导） */
export const OCR_UNSUPPORTED_REASON = '当前版本未接入 OCR 引擎，图片文档暂不支持识别为可检索文本';

/**
 * 解析图片文档。
 * - 注入 `OcrPort` → 走引擎识别，返回 `supported:true` 结果；
 * - 未注入 → 返回 `supported:false`，**不抛异常也不伪造文本**（调用方据 `supported` 决定展示引导）。
 */
export function parseImageOcr(
  input: { raw: string | Uint8Array; fileName?: string | undefined },
  port?: OcrPort | null,
): OcrResult | Promise<OcrResult> {
  if (!port) {
    return { supported: false, reason: OCR_UNSUPPORTED_REASON };
  }
  const bytes = typeof input.raw === 'string' ? new TextEncoder().encode(input.raw) : input.raw;
  return port.recognize({ raw: bytes, fileName: input.fileName }).then((r) => ({
    supported: true,
    title: r.title,
    sections: r.sections,
  }));
}

/**
 * 供解析器注册表使用的图片解析器：未注入 OCR 端口时抛出明确的"暂不支持"错误，
 * 引擎识别失败（语言包缺失 / 子进程崩溃等）也**统一包成结构化**
 * `DocDomainError('ocr_unsupported')`（带可读原因），由 doc-service 转化为用户可见的引导，
 * 而不是把空文档塞进库里或让原始错误穿透到 UI。
 */
export function makeImageParser(port?: OcrPort | null): {
  format: 'image';
  parse(input: {
    raw: string | Uint8Array;
    fileName?: string | undefined;
  }): Promise<ParsedDocument>;
} {
  return {
    format: 'image',
    async parse(input): Promise<ParsedDocument> {
      let result: OcrResult;
      try {
        result = await parseImageOcr(input, port);
      } catch (error) {
        // 引擎侧失败 → 结构化"暂不支持/不可用"，保留可读原因（含安装引导）
        const message = error instanceof Error ? error.message : String(error);
        throw new DocDomainError('ocr_unsupported', `图片识别失败：${message}`);
      }
      if (!result.supported) {
        throw new DocDomainError('ocr_unsupported', result.reason);
      }
      return { title: result.title, sections: result.sections };
    },
  };
}
