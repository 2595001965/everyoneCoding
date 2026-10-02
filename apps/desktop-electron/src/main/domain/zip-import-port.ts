import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { validateZipEntries, normalizeZipEntryPath, type ZipEntryLike } from '@ec/core';
import { ZipReader } from '@ec/package-kit';
import { ShellError } from '@ec/shell-api';

/**
 * ZIP 安全解压端口（V2-D01 / PRD §4.3、V2-SRC-01）。
 *
 * 复用 package-kit 的零依赖流式 ZipReader（CRC 校验、分块落盘、绝不整包入内存），
 * 在其上叠加 PRD §4.3 要求的安全层：
 *
 * 1. **落盘前**：`validateZipEntries` 校验全部条目（穿越/绝对路径/盘符/UNC/ADS/
 *    大小写碰撞/重复路径/条目数/声明大小/压缩比），任一反例即整体拒绝；
 * 2. **逐条目落盘时**：`normalizeZipEntryPath` 复核 + `resolve` containment 复核
 *    （深度防御），Windows 侧再把实际落盘大小计入总预算，超限即中止；
 * 3. **中止语义**：`isCancelled` 轮询在条目间检查，取消抛 `CANCELLED`；
 *    半成品目录由调用方（workspace 域）清理，本端口只保证不再继续写。
 *
 * 符号链接（如实）：extractEntryTo 只写普通文件，从不创建链接/junction，
 * 压缩包内即使带链接条目也无法越界；因此不做（也无法可靠做）链接位识别。
 */

export interface ZipImportEntry {
  path: string;
  uncompressedSize: number;
  compressedSize: number;
  isDirectory: boolean;
}

export interface ZipExtractOptions {
  /** 每完成一个条目回调（已解压文件数 / 总文件数），用于进度上报 */
  onProgress?: ((done: number, total: number) => void) | undefined;
  /** 条目间轮询；返回 true 时中止（抛 CANCELLED，由调用方清理半成品） */
  isCancelled?: (() => boolean) | undefined;
  /** 实际落盘字节预算（默认与 core 的 DEFAULT_ZIP_SAFETY_LIMITS.maxTotalBytes 一致） */
  totalByteBudget?: number | undefined;
}

export interface ZipImportPort {
  /** 读取条目清单（只解析 central directory，不解压内容） */
  listEntries(zipPath: string): ZipImportEntry[];
  /**
   * 安全解压到 targetDir（必须已存在且为空，由调用方保证）。
   * 返回解压的文件数。
   */
  extract(zipPath: string, targetDir: string, options?: ZipExtractOptions): Promise<number>;
}

/** 把 package-kit 条目转成 core 校验形状（目录条目按 ZIP 惯例识别） */
function toZipEntryLike(entry: {
  path: string;
  uncompressedSize: number;
  compressedSize: number;
}): ZipEntryLike {
  return {
    path: entry.path,
    uncompressedSize: entry.uncompressedSize,
    compressedSize: entry.compressedSize,
    isDirectory: entry.path.endsWith('/') || entry.path.endsWith('\\'),
  };
}

/** 路径校验失败 → 统一 ShellError（PATH_ESCAPE：内容越出目标目录边界） */
function safetyError(code: string, message: string): ShellError {
  const mapped: Record<string, ShellError['code']> = {
    PATH_TRAVERSAL: 'PATH_ESCAPE',
    ABSOLUTE_PATH: 'PATH_ESCAPE',
    DRIVE_LETTER: 'PATH_ESCAPE',
    UNC_PATH: 'PATH_ESCAPE',
    ADS_STREAM: 'PATH_ESCAPE',
    DUPLICATE_PATH: 'INVALID_ARGUMENT',
    CASE_COLLISION: 'INVALID_ARGUMENT',
    EMPTY_PATH: 'INVALID_ARGUMENT',
    ENTRY_LIMIT: 'INVALID_ARGUMENT',
    SIZE_LIMIT: 'INVALID_ARGUMENT',
    RATIO_LIMIT: 'INVALID_ARGUMENT',
  };
  return new ShellError(mapped[code] ?? 'INVALID_ARGUMENT', message);
}

export function createZipImportPort(): ZipImportPort {
  return {
    listEntries(zipPath: string): ZipImportEntry[] {
      let reader: ZipReader;
      try {
        reader = ZipReader.open(zipPath);
      } catch (error) {
        throw new ShellError(
          'IO_ERROR',
          `无法读取 ZIP 归档：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        return reader.list().map((entry) => {
          const like = toZipEntryLike(entry);
          return {
            path: like.path,
            uncompressedSize: like.uncompressedSize,
            compressedSize: like.compressedSize,
            isDirectory: like.isDirectory,
          };
        });
      } finally {
        reader.close();
      }
    },

    async extract(zipPath, targetDir, options = {}): Promise<number> {
      const reader = (() => {
        try {
          return ZipReader.open(zipPath);
        } catch (error) {
          throw new ShellError(
            'IO_ERROR',
            `无法读取 ZIP 归档：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();

      try {
        // 第一层：落盘前全量校验（central directory 元数据）
        const validation = validateZipEntries(reader.list().map(toZipEntryLike));
        if (!validation.ok) throw safetyError(validation.code, validation.message);

        const total = validation.normalized.length;
        const budget = options.totalByteBudget ?? 2 * 1024 * 1024 * 1024;
        const rootAbs = resolve(targetDir);
        let done = 0;
        let writtenBytes = 0;

        for (const normalized of validation.normalized) {
          // 取消语义（V2-SRC-10）：条目间检查，立即中止且不再写任何文件
          if (options.isCancelled?.() === true) {
            throw new ShellError('CANCELLED', 'ZIP 导入已取消，本次创建的临时内容将被清理。');
          }

          // 第二层：逐条目复核（防御 central directory 说谎 / 分隔符差异）
          const rechecked = normalizeZipEntryPath(normalized);
          if (!rechecked.ok) throw safetyError(rechecked.code, rechecked.message);
          const targetAbs = resolve(join(rootAbs, rechecked.normalized));
          // Windows 用反斜杠；统一补一个分隔符再比对，防 "target-evil" 前缀绕过
          const containmentRoot = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
          if (!targetAbs.startsWith(containmentRoot)) {
            throw new ShellError('PATH_ESCAPE', `条目越出解压目标目录：${normalized}`);
          }

          mkdirSync(dirname(targetAbs), { recursive: true });
          await reader.extractEntryTo(rechecked.normalized, targetAbs);

          // 第三层：实际字节预算（元数据说谎时由真实落盘大小兜底）
          writtenBytes += statSync(targetAbs).size;
          if (writtenBytes > budget) {
            throw new ShellError(
              'INVALID_ARGUMENT',
              `解压实际字节超过预算（${writtenBytes} > ${budget}），疑似解压炸弹，中止。`,
            );
          }

          done += 1;
          options.onProgress?.(done, total);
        }
        return done;
      } finally {
        reader.close();
      }
    },
  };
}
