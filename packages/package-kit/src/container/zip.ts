/**
 * ZIP 容器（T8-01）：`.ecpkg` 的物理载体，ZIP + DEFLATE。
 *
 * 设计决策：
 * - **零第三方依赖**：ZIP 读写直接基于 `node:zlib` 的 raw deflate 与手工拼装
 *   local file header / central directory / EOCD。仓库不新增重依赖（P 块约束），
 *   且避免原生模块（nodegit 的前车之鉴）。
 * - **流式**：写入端逐条目处理，大文件用 1MB 分块泵入 deflate，压缩输出即写即落盘；
 *   读取端先解析 central directory（内存 O(条目数)），条目内容按需解压，
 *   `extractEntryTo` 同样分块——**绝不整包入内存**，支持 1 万文件工程。
 * - 局限（如实说明）：不支持 ZIP64（单文件 > 4GB 或条目数 > 65535）。桌面归档
 *   场景（1 万文件、普通工程体积）远低于该边界；触达时给出明确报错而非写坏文件。
 *
 * 布局细节：
 * - General purpose bit 0x0800：条目名一律 UTF-8（中文路径必需）；
 * - 压缩方法：8（deflate）；deflate 流为 raw（无 zlib 头）；
 * - local header 的 crc / sizes 先写占位，数据落盘后回填（大文件分块流式所必需）；
 * - central directory 里的 time/date 写 0（不参与任何校验，仅元数据位）。
 */
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createDeflateRaw, createInflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const METHOD_DEFLATE = 8;
const UTF8_FLAG = 0x0800;
const ZIP_VERSION_NEEDED = 20;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
/** 大文件分块泵入 deflate 的块大小 */
const CHUNK_SIZE = 1024 * 1024;

/* ------------------------------ CRC32 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** 增量 CRC32（写入端边泵块边算；读取端解压后核对） */
export class Crc32 {
  private value = 0xffffffff;

  update(data: Buffer): void {
    let c = this.value;
    for (let i = 0; i < data.length; i += 1) {
      c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
    }
    this.value = c;
  }

  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

function crc32Of(data: Buffer): number {
  const crc = new Crc32();
  crc.update(data);
  return crc.digest();
}

/* ------------------------------ DOS 时间 ------------------------------ */

function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dateField =
    ((Math.max(1980, date.getFullYear()) - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, date: dateField & 0xffff };
}

/* ------------------------------ 写入端 ------------------------------ */

export interface ZipEntryRecord {
  path: string;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** central directory 中的 local header 偏移 */
  localHeaderOffset: number;
}

export class ZipWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipWriteError';
    Object.setPrototypeOf(this, ZipWriteError.prototype);
  }
}

/**
 * ZIP 写入端。
 *
 * 用法：`create` 打开文件 → 逐条目 `addBuffer` / `addText` / `addFile` →
 * `close`（写 central directory + EOCD）。条目名重复直接报错（归档内路径唯一）。
 */
export class ZipWriter {
  private readonly fd: number;
  private position = 0;
  private readonly records: ZipEntryRecord[] = [];
  private readonly seenPaths = new Set<string>();
  private closed = false;

  private constructor(fd: number) {
    this.fd = fd;
  }

  /** 在指定路径创建 ZIP（通常写到临时文件，完成后由调用方原子替换） */
  static create(filePath: string): ZipWriter {
    const fd = fs.openSync(filePath, 'w');
    return new ZipWriter(fd);
  }

  private assertOpen(): void {
    if (this.closed) throw new ZipWriteError('ZipWriter 已关闭，不能再写入条目');
    if (this.records.length >= 0xffff) {
      throw new ZipWriteError(`条目数超过 ZIP 上限（65535）：${this.records.length}`);
    }
  }

  private assertName(path: string): void {
    if (this.seenPaths.has(path)) {
      throw new ZipWriteError(`条目路径重复：${path}`);
    }
  }

  private writeFully(buffer: Buffer): void {
    let written = 0;
    while (written < buffer.length) {
      const n = fs.writeSync(
        this.fd,
        buffer,
        written,
        buffer.length - written,
        this.position + written,
      );
      if (n <= 0) throw new ZipWriteError('ZIP 写入异常（writeSync 返回 0 字节）');
      written += n;
    }
    this.position += buffer.length;
  }

  /** 写入一段内存内容（单条目级别；条目数上万时内存只与单条目相关） */
  addBuffer(path: string, content: Buffer, timestamp: Date = new Date()): void {
    this.assertOpen();
    this.assertName(path);
    const nameBuf = Buffer.from(path, 'utf8');
    if (nameBuf.length > 0xffff) throw new ZipWriteError(`条目名过长：${path}`);
    const deflated = deflateRawSync(content);
    if (content.length > 0xffffffff) {
      throw new ZipWriteError(`单文件超过 4GB，需要 ZIP64（当前不支持）：${path}`);
    }
    const crc = crc32Of(content);
    const { time, date } = dosDateTime(timestamp);

    const offset = this.position;
    const header = Buffer.alloc(LOCAL_HEADER_SIZE + nameBuf.length);
    header.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    header.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(METHOD_DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(deflated.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    nameBuf.copy(header, LOCAL_HEADER_SIZE);
    this.writeFully(header);
    this.writeFully(deflated);

    this.records.push({
      path,
      crc32: crc,
      compressedSize: deflated.length,
      uncompressedSize: content.length,
      localHeaderOffset: offset,
    });
    this.seenPaths.add(path);
  }

  /** 写入文本（UTF-8） */
  addText(path: string, text: string, timestamp?: Date): void {
    this.addBuffer(path, Buffer.from(text, 'utf8'), timestamp);
  }

  /**
   * 从磁盘流式写入一个大文件：1MB 分块读入 → 泵入 deflate → 压缩块即写即落盘。
   * 内存占用只与块大小相关，与文件大小无关。
   */
  async addFile(
    path: string,
    sourceAbsolutePath: string,
    timestamp: Date = new Date(),
  ): Promise<void> {
    this.assertOpen();
    this.assertName(path);
    const nameBuf = Buffer.from(path, 'utf8');
    const { time, date } = dosDateTime(timestamp);

    // ① 写占位 local header（crc/sizes 待数据落盘后回填）
    const offset = this.position;
    const header = Buffer.alloc(LOCAL_HEADER_SIZE + nameBuf.length);
    header.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    header.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(METHOD_DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    nameBuf.copy(header, LOCAL_HEADER_SIZE);
    this.writeFully(header);

    // ② 分块泵入 deflate，压缩输出即时落盘（'data' 回调内同步写 fd，顺序有保证）
    const crc = new Crc32();
    let rawSize = 0;
    let compressedSize = 0;
    const deflate = createDeflateRaw();
    let deflateError: Error | null = null;
    deflate.on('error', (error: Error) => {
      deflateError = error;
    });
    deflate.on('data', (chunk: Buffer) => {
      this.writeFully(chunk);
      compressedSize += chunk.length;
    });

    const sourceFd = fs.openSync(sourceAbsolutePath, 'r');
    try {
      const buf = Buffer.alloc(CHUNK_SIZE);
      for (;;) {
        if (deflateError !== null) throw deflateError;
        const bytesRead = fs.readSync(sourceFd, buf, 0, CHUNK_SIZE, rawSize);
        if (bytesRead === 0) break;
        const chunk = Buffer.from(buf.subarray(0, bytesRead));
        crc.update(chunk);
        rawSize += bytesRead;
        if (!deflate.write(chunk)) {
          await once(deflate, 'drain');
        }
      }
      deflate.end();
      await once(deflate, 'end');
      if (deflateError !== null) throw deflateError;
    } finally {
      fs.closeSync(sourceFd);
      deflate.destroy();
    }

    if (rawSize > 0xffffffff) {
      throw new ZipWriteError(`单文件超过 4GB，需要 ZIP64（当前不支持）：${path}`);
    }

    // ③ 回填 local header 的 crc / sizes（local header 偏移 +14 处是 crc 字段）
    const patch = Buffer.alloc(12);
    patch.writeUInt32LE(crc.digest(), 0);
    patch.writeUInt32LE(compressedSize, 4);
    patch.writeUInt32LE(rawSize, 8);
    fs.writeSync(this.fd, patch, 0, 12, offset + 14);

    this.records.push({
      path,
      crc32: crc.digest(),
      compressedSize,
      uncompressedSize: rawSize,
      localHeaderOffset: offset,
    });
    this.seenPaths.add(path);
  }

  /** 条目清单（close 前调用，供 manifest 统计） */
  entries(): readonly ZipEntryRecord[] {
    return this.records;
  }

  /** 写 central directory + EOCD 并关闭文件 */
  close(): void {
    if (this.closed) return;
    const centralStart = this.position;
    for (const record of this.records) {
      const nameBuf = Buffer.from(record.path, 'utf8');
      const header = Buffer.alloc(CENTRAL_HEADER_SIZE + nameBuf.length);
      header.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
      header.writeUInt16LE(ZIP_VERSION_NEEDED, 4); // version made by（简化：与 needed 相同）
      header.writeUInt16LE(ZIP_VERSION_NEEDED, 6);
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(METHOD_DEFLATE, 10);
      header.writeUInt32LE(record.crc32, 16);
      header.writeUInt32LE(record.compressedSize, 20);
      header.writeUInt32LE(record.uncompressedSize, 24);
      header.writeUInt16LE(nameBuf.length, 28);
      header.writeUInt32LE(record.localHeaderOffset, 42);
      nameBuf.copy(header, CENTRAL_HEADER_SIZE);
      this.writeFully(header);
    }
    const centralSize = this.position - centralStart;
    if (centralStart > 0xffffffff) {
      throw new ZipWriteError('归档超过 4GB，需要 ZIP64（当前不支持）');
    }

    const eocd = Buffer.alloc(EOCD_SIZE);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.records.length, 8);
    eocd.writeUInt16LE(this.records.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    this.writeFully(eocd);

    fs.closeSync(this.fd);
    this.closed = true;
  }

  /** 中止：关闭文件句柄（半成品文件由调用方删除） */
  abort(): void {
    if (this.closed) return;
    fs.closeSync(this.fd);
    this.closed = true;
  }
}

/* ------------------------------ 读取端 ------------------------------ */

export interface ZipEntryInfo {
  path: string;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
}

export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipReadError';
    Object.setPrototypeOf(this, ZipReadError.prototype);
  }
}

/**
 * ZIP 读取端。
 *
 * `open` 时只解析 EOCD + central directory（内存 O(条目数)）；
 * 条目内容用 `readEntry`（单条目整体）或 `extractEntryTo`（分块流式落盘）按需读取。
 */
export class ZipReader {
  private readonly fd: number;
  private readonly entriesByName = new Map<string, ZipEntryInfo>();
  private closed = false;

  private constructor(fd: number, entries: ZipEntryInfo[]) {
    this.fd = fd;
    for (const entry of entries) {
      this.entriesByName.set(entry.path, entry);
    }
  }

  /** 打开 ZIP 并解析目录；文件损坏 / 非法 ZIP 抛 `ZipReadError` */
  static open(filePath: string): ZipReader {
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size < EOCD_SIZE) {
        throw new ZipReadError('文件太小，不是合法的 ZIP 归档');
      }
      // 从尾部扫描 EOCD（最多回看 65535 + 22 字节，覆盖注释场景）
      const scanWindow = Math.min(size, EOCD_SIZE + 0xffff);
      const tail = Buffer.alloc(scanWindow);
      readFullyAt(fd, tail, size - scanWindow);
      let eocdOffset = -1;
      for (let i = scanWindow - EOCD_SIZE; i >= 0; i -= 1) {
        if (tail.readUInt32LE(i) === EOCD_SIG) {
          eocdOffset = size - scanWindow + i;
          break;
        }
      }
      if (eocdOffset === -1) {
        throw new ZipReadError('找不到 ZIP 结束记录（EOCD），文件可能被截断');
      }

      const eocd = Buffer.alloc(EOCD_SIZE);
      readFullyAt(fd, eocd, eocdOffset);
      const entryCount = eocd.readUInt16LE(10);
      const centralSize = eocd.readUInt32LE(12);
      const centralOffset = eocd.readUInt32LE(16);

      const entries: ZipEntryInfo[] = [];
      const central = Buffer.alloc(centralSize);
      readFullyAt(fd, central, centralOffset);
      let pos = 0;
      for (let index = 0; index < entryCount; index += 1) {
        if (
          pos + CENTRAL_HEADER_SIZE > central.length ||
          central.readUInt32LE(pos) !== CENTRAL_HEADER_SIG
        ) {
          throw new ZipReadError(`central directory 第 ${index + 1} 条损坏（签名不符或越界）`);
        }
        const method = central.readUInt16LE(pos + 10);
        const crc32 = central.readUInt32LE(pos + 16);
        const compressedSize = central.readUInt32LE(pos + 20);
        const uncompressedSize = central.readUInt32LE(pos + 24);
        const nameLength = central.readUInt16LE(pos + 28);
        const extraLength = central.readUInt16LE(pos + 30);
        const commentLength = central.readUInt16LE(pos + 32);
        const localHeaderOffset = central.readUInt32LE(pos + 42);
        const name = central
          .subarray(pos + CENTRAL_HEADER_SIZE, pos + CENTRAL_HEADER_SIZE + nameLength)
          .toString('utf8');
        entries.push({
          path: name,
          crc32,
          compressedSize,
          uncompressedSize,
          method,
          localHeaderOffset,
        });
        // 条目名恒按 UTF-8 解码（本仓写入端恒置 UTF-8 标志）；
        // 外部工具生成的包如遇乱码名，会在结构断言处报 unknown 分区
        pos += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
      }

      return new ZipReader(fd, entries);
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  list(): ZipEntryInfo[] {
    return [...this.entriesByName.values()];
  }

  has(path: string): boolean {
    return this.entriesByName.has(path);
  }

  entry(path: string): ZipEntryInfo {
    const entry = this.entriesByName.get(path);
    if (entry === undefined) {
      throw new ZipReadError(`包内不存在该条目：${path}`);
    }
    return entry;
  }

  /** 读取单条目完整内容（内存与单条目大小相关），并核对 CRC */
  readEntry(path: string): Buffer {
    const entry = this.entry(path);
    const data = this.readCompressedData(entry);
    const content = entry.method === METHOD_DEFLATE ? inflateRawSync(data) : Buffer.from(data);
    const crc = crc32Of(content);
    if (crc !== entry.crc32) {
      throw new ZipReadError(`条目 CRC 校验失败：${path}`);
    }
    if (content.length !== entry.uncompressedSize) {
      throw new ZipReadError(
        `条目解压后大小不符（期望 ${entry.uncompressedSize}，实际 ${content.length}）：${path}`,
      );
    }
    return content;
  }

  /**
   * 把单条目解压流式写到目标文件（分块，内存只与块大小相关），并核对 CRC。
   * deflate 状态跨块保持（一个条目一个 inflate 流）；失败时删除半成品目标文件。
   */
  async extractEntryTo(path: string, targetAbsolutePath: string): Promise<void> {
    const entry = this.entry(path);
    const outFd = fs.openSync(targetAbsolutePath, 'w');
    try {
      const crc = new Crc32();
      let written = 0;
      const { dataStart } = this.localEntryLayout(entry);
      const buf = Buffer.alloc(Math.min(CHUNK_SIZE, Math.max(entry.compressedSize, 1)));

      if (entry.method === METHOD_DEFLATE) {
        const inflater = createInflateRaw();
        let inflateError: Error | null = null;
        inflater.on('error', (error: Error) => {
          inflateError = error;
        });
        inflater.on('data', (content: Buffer) => {
          fs.writeSync(outFd, content, 0, content.length, written);
          crc.update(content);
          written += content.length;
        });
        let offset = 0;
        for (;;) {
          if (inflateError !== null) throw inflateError;
          const remaining = entry.compressedSize - offset;
          if (remaining <= 0) break;
          const toRead = Math.min(remaining, buf.length);
          const chunk = Buffer.alloc(toRead);
          readFullyAt(this.fd, chunk, dataStart + offset);
          if (!inflater.write(chunk)) {
            await once(inflater, 'drain');
          }
          offset += toRead;
        }
        inflater.end();
        await once(inflater, 'end');
        if (inflateError !== null) throw inflateError;
        inflater.destroy();
      } else {
        // 未压缩（method 0）：原样分块拷贝
        let offset = 0;
        for (;;) {
          const remaining = entry.compressedSize - offset;
          if (remaining <= 0) break;
          const toRead = Math.min(remaining, buf.length);
          const chunk = Buffer.alloc(toRead);
          readFullyAt(this.fd, chunk, dataStart + offset);
          fs.writeSync(outFd, chunk, 0, chunk.length, written);
          crc.update(chunk);
          written += chunk.length;
          offset += toRead;
        }
      }

      if (crc.digest() !== entry.crc32) {
        throw new ZipReadError(`条目 CRC 校验失败：${path}`);
      }
      if (written !== entry.uncompressedSize) {
        throw new ZipReadError(
          `条目解压后大小不符（期望 ${entry.uncompressedSize}，实际 ${written}）：${path}`,
        );
      }
    } catch (error) {
      try {
        fs.closeSync(outFd);
      } catch {
        /* 忽略关闭异常 */
      }
      try {
        fs.unlinkSync(targetAbsolutePath);
      } catch {
        /* 尽力清理 */
      }
      throw error;
    }
    fs.closeSync(outFd);
  }

  close(): void {
    if (this.closed) return;
    fs.closeSync(this.fd);
    this.closed = true;
  }

  /** 读出条目的压缩字节（整体）；解压在调用方完成 */
  private readCompressedData(entry: ZipEntryInfo): Buffer {
    const { dataStart } = this.localEntryLayout(entry);
    const data = Buffer.alloc(entry.compressedSize);
    readFullyAt(this.fd, data, dataStart);
    return data;
  }

  /** 解析 local header：跳过条目名与 extra 字段，返回压缩数据起点 */
  private localEntryLayout(entry: ZipEntryInfo): { dataStart: number } {
    const header = Buffer.alloc(LOCAL_HEADER_SIZE);
    readFullyAt(this.fd, header, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== LOCAL_HEADER_SIG) {
      throw new ZipReadError(`local header 签名不符：${entry.path}`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    return { dataStart: entry.localHeaderOffset + LOCAL_HEADER_SIZE + nameLength + extraLength };
  }
}

function readFullyAt(fd: number, buffer: Buffer, position: number): void {
  let read = 0;
  while (read < buffer.length) {
    const n = fs.readSync(fd, buffer, read, buffer.length - read, position + read);
    if (n <= 0) throw new ZipReadError('文件意外到达末尾（可能被截断）');
    read += n;
  }
}
