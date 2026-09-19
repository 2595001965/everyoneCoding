/**
 * 解析器单测（T9-04 / FR-DOC-01）：Markdown / TXT / DOCX / PDF / 图片 OCR。
 *
 * DOCX / PDF 用 node:zlib 现场构造最小合法文件，验证零依赖解析器真的能解出来，
 * 不依赖任何第三方解析库。
 */

import { deflateRawSync, deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { parseDocx } from '../parsers/docx';
import { parseImageOcr, makeImageParser } from '../parsers/image-ocr';
import { parseMarkdown } from '../parsers/markdown';
import { parsePdf } from '../parsers/pdf';
import { parseTxt } from '../parsers/txt';
import type { OcrPort } from '../doc-types';

/* --------------------------- DOCX 构造（最小 ZIP） --------------------------- */

function pushU16(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >>> 8) & 0xff);
}
function pushU32(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function buildDocx(documentXml: string): Uint8Array {
  const entries: Array<{ name: string; data: Uint8Array }> = [
    { name: '[Content_Types].xml', data: new TextEncoder().encode('<Types/>') },
    { name: 'word/document.xml', data: new TextEncoder().encode(documentXml) },
  ];
  const out: number[] = [];
  const central: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const comp = deflateRawSync(entry.data);
    const nameBytes = new TextEncoder().encode(entry.name);
    const localStart = out.length;
    pushU32(out, 0x04034b50);
    pushU16(out, 20);
    pushU16(out, 0);
    pushU16(out, 8); // deflate
    pushU16(out, 0);
    pushU16(out, 0);
    pushU32(out, 0);
    pushU32(out, comp.length);
    pushU32(out, entry.data.length);
    pushU16(out, nameBytes.length);
    pushU16(out, 0);
    for (const b of nameBytes) out.push(b);
    for (const b of comp) out.push(b);

    const cdStart = central.length;
    pushU32(central, 0x02014b50);
    pushU16(central, 20);
    pushU16(central, 20);
    pushU16(central, 0);
    pushU16(central, 8);
    pushU16(central, 0);
    pushU16(central, 0);
    pushU32(central, 0);
    pushU32(central, comp.length);
    pushU32(central, entry.data.length);
    pushU16(central, nameBytes.length);
    pushU16(central, 0);
    pushU16(central, 0);
    pushU16(central, 0);
    pushU16(central, 0);
    pushU32(central, 0);
    pushU32(central, localStart);
    for (const b of nameBytes) central.push(b);
    void cdStart;
    offset = out.length;
  }
  const cdOffset = offset;
  const cdSize = central.length;
  for (const b of central) out.push(b);
  pushU32(out, 0x06054b50);
  pushU16(out, 0);
  pushU16(out, 0);
  pushU16(out, entries.length);
  pushU16(out, entries.length);
  pushU32(out, cdSize);
  pushU32(out, cdOffset);
  pushU16(out, 0);
  return Uint8Array.from(out);
}

/* --------------------------- PDF 构造 --------------------------- */

function buildPdf(contentStreams: string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const header = new TextEncoder().encode('%PDF-1.4\n');
  parts.push(header);
  // 对象 1: catalog, 2: pages, 3: page, 4..: content
  const contentObjNums = contentStreams.map((_, i) => 4 + i);
  let obj = 1;
  const writeObj = (body: string): void => {
    parts.push(new TextEncoder().encode(`${obj} 0 obj\n${body}\nendobj\n`));
    obj += 1;
  };
  writeObj('<< /Type /Catalog /Pages 2 0 R >>');
  writeObj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const contentsRef = `[${contentObjNums.map((n) => `${n} 0 R`).join(' ')}]`;
  writeObj(`<< /Type /Page /Parent 2 0 R /Contents ${contentsRef} >>`);
  for (const stream of contentStreams) {
    const comp = deflateSync(new TextEncoder().encode(stream));
    const dict = `<< /Length ${comp.length} /Filter /FlateDecode >>`;
    parts.push(new TextEncoder().encode(`${obj} 0 obj\n${dict}\nstream\n`));
    parts.push(comp);
    parts.push(new TextEncoder().encode('\nendstream\nendobj\n'));
    obj += 1;
  }
  const body = concatBytes(parts);
  const trailer = new TextEncoder().encode(`trailer\n<< /Root 1 0 R >>\n%%EOF\n`);
  return concatBytes([body, trailer]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 构造双页 PDF：每页各一个内容流，用于验证跨页页码映射 */
function buildPdf2Pages(streams: [string, string]): Uint8Array {
  const parts: Uint8Array[] = [];
  const header = new TextEncoder().encode('%PDF-1.4\n');
  parts.push(header);
  let obj = 1;
  const writeObj = (body: string): void => {
    parts.push(new TextEncoder().encode(`${obj} 0 obj\n${body}\nendobj\n`));
    obj += 1;
  };
  const contentNums: number[] = [];
  writeObj('<< /Type /Catalog /Pages 2 0 R >>');
  writeObj('<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>');
  for (let i = 0; i < 2; i += 1) {
    contentNums.push(obj);
    const comp = deflateSync(new TextEncoder().encode(streams[i]!));
    const dict = `<< /Length ${comp.length} /Filter /FlateDecode >>`;
    parts.push(new TextEncoder().encode(`${obj} 0 obj\n${dict}\nstream\n`));
    parts.push(comp);
    parts.push(new TextEncoder().encode('\nendstream\nendobj\n'));
    obj += 1;
  }
  // 两个页面对象，各自引用一个内容流
  writeObj(`<< /Type /Page /Parent 2 0 R /Contents ${contentNums[0]!} 0 R >>`);
  writeObj(`<< /Type /Page /Parent 2 0 R /Contents ${contentNums[1]!} 0 R >>`);
  const body = concatBytes(parts);
  const trailer = new TextEncoder().encode('trailer\n<< /Root 1 0 R >>\n%%EOF\n');
  return concatBytes([body, trailer]);
}

/* --------------------------- 测试 --------------------------- */

describe('Markdown 解析', () => {
  it('保留标题层级并生成可跳转锚点（中文保留、去重加序号）', () => {
    const md = '# 文档标题\n## 第一章\n正文一\n### 1.1 小节\n细节\n## 第二章\n正文二';
    const parsed = parseMarkdown({ raw: md });
    expect(parsed.title).toBe('文档标题');
    expect(parsed.sections.map((s) => s.level)).toEqual([1, 2, 3, 2]);
    expect(parsed.sections[1]!.heading).toBe('第一章');
    const anchors = parsed.sections.map((s) => s.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
    // 中文锚点保留
    expect(anchors).toContain('第一章');
  });

  it('无标题文档产出单 section', () => {
    const parsed = parseMarkdown({ raw: '只是一些普通文本，没有标题。' });
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.level).toBe(0);
  });
});

describe('TXT 解析', () => {
  it('按章节标记推断层级（第X章=1，第X节=2）', () => {
    const txt = '第一章 概述\n这是概述正文。\n\n第二节 详情\n详情内容。';
    const parsed = parseTxt({ raw: txt });
    expect(parsed.title).toBe('第一章 概述');
    expect(parsed.sections[0]!.level).toBe(1);
    expect(parsed.sections[1]!.level).toBe(2);
  });

  it('无标题纯文本产出单 section', () => {
    const parsed = parseTxt({ raw: '普通文本一段。\n另一段。' });
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.level).toBe(0);
  });
});

describe('DOCX 解析（零依赖 ZIP + XML）', () => {
  it('按 Heading1/Heading2 提取标题层级', () => {
    const xml =
      '<w:document><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 引言</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>这是正文。</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>第二节 背景</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const parsed = parseDocx({ raw: buildDocx(xml) });
    expect(parsed.title).toBe('第一章 引言');
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]!.level).toBe(1);
    expect(parsed.sections[0]!.heading).toBe('第一章 引言');
    expect(parsed.sections[0]!.text).toContain('这是正文');
    expect(parsed.sections[1]!.level).toBe(2);
    expect(parsed.sections[1]!.heading).toBe('第二节 背景');
  });
});

describe('PDF 解析（零依赖 FlateDecode + Tj/TJ）', () => {
  it('按字号启发式识别标题并给出页码定位', () => {
    const stream = 'BT /F1 20 Tf (Chapter One) Tj ET\nBT /F1 10 Tf (This is body text.) Tj ET';
    const parsed = parsePdf({ raw: buildPdf([stream]) });
    const heading = parsed.sections.find((s) => s.level > 0);
    expect(heading).toBeDefined();
    expect(heading!.heading).toBe('Chapter One');
    expect(heading!.page).toBe(1);
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages![0]!.text).toContain('Chapter One');
  });

  it('多内容流映射不同页码', () => {
    const s1 = 'BT /F1 18 Tf (Section One) Tj ET';
    const s2 = 'BT /F1 12 Tf (Section two content) Tj ET';
    const parsed = parsePdf({ raw: buildPdf2Pages([s1, s2]) });
    expect(parsed.pages).toHaveLength(2);
    expect(parsed.pages![0]!.index).toBe(1);
    expect(parsed.pages![1]!.index).toBe(2);
  });
});

describe('图片 OCR 解析', () => {
  it('未注入 OCR 端口时如实报"暂不支持"，不静默失败', async () => {
    const result = await parseImageOcr({ raw: new Uint8Array([1, 2, 3]) });
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toContain('OCR');
  });

  it('注入端口后返回结构化结果', async () => {
    const port: OcrPort = {
      recognize: async () => ({
        title: '截图文档',
        sections: [{ index: 0, level: 1, heading: '标题', anchor: 't', text: '内容' }],
      }),
    };
    const result = await parseImageOcr({ raw: new Uint8Array([1]), fileName: 'a.png' }, port);
    expect(result.supported).toBe(true);
    if (result.supported) expect(result.title).toBe('截图文档');
  });

  it('解析器在无端口时抛出可识别错误', async () => {
    const parser = makeImageParser(null);
    await expect(parser.parse({ raw: new Uint8Array([1]) })).rejects.toThrow(/OCR/);
  });
});
