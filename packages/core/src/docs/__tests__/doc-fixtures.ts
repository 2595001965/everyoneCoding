/**
 * 文档解析测试夹具：用 node:zlib 现场构造最小合法 DOCX / PDF（零第三方依赖），
 * 供解析器单测与 DocService 导入矩阵共用。
 */

import { deflateRawSync, deflateSync } from 'node:zlib';

/* --------------------------- DOCX 构造（最小 ZIP） --------------------------- */

function pushU16(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >>> 8) & 0xff);
}
function pushU32(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
export function buildDocx(documentXml: string): Uint8Array {
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

export function buildPdf(contentStreams: string[]): Uint8Array {
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
export function buildPdf2Pages(streams: [string, string]): Uint8Array {
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
