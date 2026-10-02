import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ZIP_SAFETY_LIMITS,
  normalizeZipEntryPath,
  validateZipEntries,
  type ZipEntryLike,
} from '../zip-safety';

const entry = (path: string, uncompressedSize = 10, compressedSize = 5): ZipEntryLike => ({
  path,
  uncompressedSize,
  compressedSize,
  isDirectory: path.endsWith('/') || path.endsWith('\\'),
});

describe('单条目路径校验（PRD §4.3）', () => {
  it('正常相对路径通过并归一化（反斜杠按分隔符处理）', () => {
    expect(normalizeZipEntryPath('src/main.ts')).toEqual({ ok: true, normalized: 'src/main.ts' });
    expect(normalizeZipEntryPath('a\\b\\c.ts')).toEqual({ ok: true, normalized: 'a/b/c.ts' });
    expect(normalizeZipEntryPath('dir/')).toEqual({ ok: true, normalized: 'dir' });
    expect(normalizeZipEntryPath('/')).toEqual({ ok: true, normalized: '' }); // 根占位
  });

  it('路径穿越（..）拒绝', () => {
    expect(normalizeZipEntryPath('a/../../evil.txt').ok).toBe(false);
    expect(normalizeZipEntryPath('..\\evil.txt').ok).toBe(false);
    expect(normalizeZipEntryPath('a/..b/c.txt').ok).toBe(true); // '..b' 是合法名
  });

  it('绝对路径 / 盘符 / UNC / ADS 拒绝', () => {
    expect(normalizeZipEntryPath('/etc/passwd')).toMatchObject({ code: 'ABSOLUTE_PATH' });
    expect(normalizeZipEntryPath('C:/evil.txt')).toMatchObject({ code: 'DRIVE_LETTER' });
    expect(normalizeZipEntryPath('C:\\evil.txt')).toMatchObject({ code: 'DRIVE_LETTER' });
    expect(normalizeZipEntryPath('\\\\server\\share\\x')).toMatchObject({ code: 'UNC_PATH' });
    expect(normalizeZipEntryPath('file.txt:stream')).toMatchObject({ code: 'ADS_STREAM' });
    expect(normalizeZipEntryPath('C:stream')).toMatchObject({ code: 'DRIVE_LETTER' });
  });

  it('空路径拒绝', () => {
    expect(normalizeZipEntryPath('')).toMatchObject({ code: 'EMPTY_PATH' });
  });
});

describe('条目集合校验（解压前一次性判定）', () => {
  it('正常包通过：返回与文件条目平行的规范化路径（目录条目不在其中）', () => {
    const result = validateZipEntries([
      entry('index.html'),
      entry('src/main.ts'),
      entry('src/'),
      entry('assets/logo.png'),
    ]);
    expect(result).toEqual({
      ok: true,
      normalized: ['index.html', 'src/main.ts', 'assets/logo.png'],
    });
  });

  it('重复路径拒绝', () => {
    const result = validateZipEntries([entry('a.txt'), entry('a.txt')]);
    expect(result).toMatchObject({ ok: false, code: 'DUPLICATE_PATH' });
  });

  it('大小写碰撞拒绝（Windows 大小写不敏感会静默覆盖）', () => {
    const result = validateZipEntries([entry('Readme.md'), entry('readme.md')]);
    expect(result).toMatchObject({ ok: false, code: 'CASE_COLLISION' });
  });

  it('尾部点/空格差异同样视为碰撞（Windows 会剥离）', () => {
    const result = validateZipEntries([entry('a.txt'), entry('a.txt.')]);
    expect(result).toMatchObject({ ok: false, code: 'CASE_COLLISION' });
  });

  it('文件与目录同名：归一化后为同一路径，按重复路径拒绝', () => {
    const result = validateZipEntries([entry('src'), entry('src/')]);
    expect(result).toMatchObject({ ok: false, code: 'DUPLICATE_PATH' });
  });

  it('条目数超限拒绝（ENTRY_LIMIT）', () => {
    const many = Array.from({ length: DEFAULT_ZIP_SAFETY_LIMITS.maxEntries + 1 }, (_, index) =>
      entry(`f-${index}.txt`),
    );
    const result = validateZipEntries(many);
    expect(result).toMatchObject({ ok: false, code: 'ENTRY_LIMIT' });
  });

  it('单文件超限拒绝（SIZE_LIMIT）', () => {
    const result = validateZipEntries([
      entry('huge.bin', DEFAULT_ZIP_SAFETY_LIMITS.maxSingleFileBytes + 1),
    ]);
    expect(result).toMatchObject({ ok: false, code: 'SIZE_LIMIT' });
  });

  it('总量超限拒绝（SIZE_LIMIT）', () => {
    const half = Math.floor(DEFAULT_ZIP_SAFETY_LIMITS.maxTotalBytes / 2) + 1;
    const result = validateZipEntries([entry('a.bin', half), entry('b.bin', half)]);
    expect(result).toMatchObject({ ok: false, code: 'SIZE_LIMIT' });
  });

  it('高压缩比拒绝（RATIO_LIMIT，解压炸弹特征）；小压缩文件有地板不误报', () => {
    const bomb = validateZipEntries([
      {
        path: 'bomb.bin',
        uncompressedSize: 10_000_000,
        compressedSize: 10_000,
        isDirectory: false,
      },
    ]);
    expect(bomb).toMatchObject({ ok: false, code: 'RATIO_LIMIT' });

    const tiny = validateZipEntries([
      { path: 'small.bin', uncompressedSize: 10_000, compressedSize: 100, isDirectory: false },
    ]);
    expect(tiny.ok).toBe(true); // compressedSize < ratioFloorBytes，不做比值判定
  });

  it('任一反例即整体拒绝：正常条目与穿越条目混合时全部不解压', () => {
    const result = validateZipEntries([entry('index.html'), entry('../evil.txt')]);
    expect(result).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect('normalized' in result).toBe(false);
  });
});
