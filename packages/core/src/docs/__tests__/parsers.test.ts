/**
 * 解析器单测（T9-04 / FR-DOC-01）：Markdown / TXT / DOCX / PDF / 图片 OCR。
 *
 * DOCX / PDF 用 node:zlib 现场构造最小合法文件，验证零依赖解析器真的能解出来，
 * 不依赖任何第三方解析库。
 */

import { describe, expect, it } from 'vitest';

import { parseDocx } from '../parsers/docx';
import { aggregateLinesToSections, joinOcrWords, resolveOcrLanguage } from '../parsers/windows-ocr';
import { parseImageOcr, makeImageParser } from '../parsers/image-ocr';
import { parseMarkdown } from '../parsers/markdown';
import { parsePdf } from '../parsers/pdf';
import { parseTxt } from '../parsers/txt';
import type { OcrPort } from '../doc-types';
import { buildDocx, buildPdf, buildPdf2Pages } from './doc-fixtures';

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

describe('解析失败如实抛错（不产出伪内容）', () => {
  it('DOCX：非 ZIP 字节报"未找到中央目录"；ZIP 内缺 word/document.xml 报缺件', () => {
    expect(() => parseDocx({ raw: new TextEncoder().encode('not a zip at all') })).toThrow(
      /DOCX 解析失败/,
    );
    // 用合法 ZIP 容器但把正文条目改名 → 缺 word/document.xml
    const zip = buildDocx('<w:document/>');
    const renamed = new TextDecoder('latin1')
      .decode(zip)
      .replaceAll('word/document.xml', 'word/documenX.xml');
    const bytes = Uint8Array.from(renamed, (ch) => ch.charCodeAt(0));
    expect(() => parseDocx({ raw: bytes })).toThrow(/缺少 word\/document\.xml/);
  });

  it('PDF：非 PDF 字节 / 无文字内容流 → 只剩空段落（由 DocService 判为 empty_content）', () => {
    for (const raw of [
      new TextEncoder().encode('%PDF-1.4\n%%EOF'),
      buildPdf(['q 1 0 0 1 0 0 cm Q']),
    ]) {
      const parsed = parsePdf({ raw });
      expect(parsed.sections.every((s) => s.text === '' && s.heading === '')).toBe(true);
    }
  });
});

describe('图片 OCR：语言透传与段落聚合', () => {
  it('识别语言经解析器透传给 OCR 端口', async () => {
    const seen: Array<string | undefined> = [];
    const port: OcrPort = {
      recognize: async (input) => {
        seen.push(input.language);
        return {
          title: 'x',
          sections: [{ index: 0, level: 0, heading: '', anchor: 's', text: 'hi' }],
        };
      },
    };
    const parser = makeImageParser(port);
    await parser.parse({ raw: new Uint8Array([1]), language: 'en-US' });
    await parser.parse({ raw: new Uint8Array([1]) });
    expect(seen).toEqual(['en-US', undefined]);
  });

  it('端口抛错（语言包缺失）→ ocr_unsupported，原因原样保留', async () => {
    const parser = makeImageParser({
      recognize: async () => {
        throw new Error('系统未安装「ja-JP」语言包');
      },
    });
    await expect(parser.parse({ raw: new Uint8Array([1]) })).rejects.toMatchObject({
      code: 'ocr_unsupported',
      message: expect.stringContaining('ja-JP') as unknown as string,
    });
  });

  it('正常行距的连续行并为同一段；空一行以上才分段（按行框下沿到上沿的间距）', () => {
    // 行高 20、行距 26（间隙 6）：同段；第三行与第二行间隙 40（> 0.8×20）：分段
    const sections = aggregateLinesToSections([
      { text: 'Para one line one', y: 0, h: 20 },
      { text: 'line two', y: 26, h: 20 },
      { text: '第 二 段', y: 86, h: 20 },
      { text: '续 行', y: 112, h: 20 },
    ]);
    // 英文行间以空格相接；中文跨行也不插空格（否则检索"二段续行"会落空）
    expect(sections.map((s) => s.text)).toEqual(['Para one line one line two', '第二段续行']);
    expect(sections.map((s) => s.anchor)).toEqual(['sec-0', 'sec-1']);
  });

  it('乱序输入按 y 排序；空白行被丢弃；零行返回空数组', () => {
    expect(aggregateLinesToSections([])).toEqual([]);
    const sections = aggregateLinesToSections([
      { text: 'B', y: 24, h: 20 },
      { text: '   ', y: 12, h: 20 },
      { text: 'A', y: 0, h: 20 },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.text).toBe('A B');
  });
});

describe('OCR 行内拼接与语言对齐', () => {
  it('去掉相邻 CJK 字符间的空格，中英/数字混排处保留', () => {
    expect(joinOcrWords('发 票 编 号 4821')).toBe('发票编号 4821');
    expect(joinOcrWords('  支 持 WeChat 登 录，  扫 码 ')).toBe('支持 WeChat 登录，扫码');
    expect(joinOcrWords('Invoice   Number 4821')).toBe('Invoice Number 4821');
  });

  it('zh-CN 对到 zh-Hans-CN，繁体不顶替简体；主子标签兜底；无匹配返回 null', () => {
    const installed = ['zh-Hans-CN', 'en-US'];
    expect(resolveOcrLanguage('zh-CN', installed)).toBe('zh-Hans-CN');
    expect(resolveOcrLanguage('ZH-HANS-CN', installed)).toBe('zh-Hans-CN');
    expect(resolveOcrLanguage('zh-TW', installed)).toBeNull();
    expect(resolveOcrLanguage('zh-TW', ['zh-Hant-TW'])).toBe('zh-Hant-TW');
    expect(resolveOcrLanguage('en-GB', installed)).toBe('en-US');
    expect(resolveOcrLanguage('ja-JP', installed)).toBeNull();
  });
});
