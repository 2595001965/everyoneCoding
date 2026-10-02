/**
 * ZIP 条目安全校验（V2-D01 / PRD §4.3）。
 *
 * **纯函数**：只对 central directory 读出的条目元数据做判定，不触碰文件系统，
 * 便于用构造条目覆盖全部反例（穿越/绝对路径/盘符/UNC/ADS/大小写碰撞/解压炸弹）。
 *
 * 分层防御：
 * 1. 解压前 `validateZipEntries` 对全部条目做校验（落盘前中止，PRD「超限在落盘前
 *    或流式处理中中止」的前半段）；
 * 2. 逐条目解压时端口再用 `normalizeZipEntryPath` 复核 + Node 侧 containment 检查
 *    （深度防御：central directory 元数据说谎、路径分隔符差异都在这一层兜底）；
 * 3. 端口在逐条目落盘间统计实际字节，超过总限额即中止并清理（后半段）。
 *
 * 符号链接说明（如实）：本仓库 ZIP 读取端（package-kit ZipReader + extractEntryTo）
 * 只会写**普通文件**，永远不会创建符号链接/junction，因此压缩包内即使带链接条目
 * 也无法越界——这里不需要（也无法从 central directory 可靠）识别链接位。
 */

/** 条目元数据（与 package-kit ZipEntryInfo 的结构对齐，避免 core 依赖它） */
export interface ZipEntryLike {
  path: string;
  uncompressedSize: number;
  compressedSize: number;
  /** 目录条目（ZIP 惯例：路径以 / 结尾） */
  isDirectory: boolean;
}

export type ZipSafetyCode =
  | 'EMPTY_PATH'
  | 'ABSOLUTE_PATH'
  | 'DRIVE_LETTER'
  | 'UNC_PATH'
  | 'ADS_STREAM'
  | 'PATH_TRAVERSAL'
  | 'DUPLICATE_PATH'
  | 'CASE_COLLISION'
  | 'ENTRY_LIMIT'
  | 'SIZE_LIMIT'
  | 'RATIO_LIMIT';

export interface ZipSafetyLimits {
  /** 条目数上限 */
  maxEntries: number;
  /** 解压后总字节上限 */
  maxTotalBytes: number;
  /** 单文件解压后字节上限 */
  maxSingleFileBytes: number;
  /** 单条目压缩比上限（仅对压缩后 ≥ ratioFloorBytes 的条目生效，避免小文件误报） */
  maxRatio: number;
  ratioFloorBytes: number;
}

/** 默认限额：面向普通源码工程（万级文件 / 数百 MB），远高于正常工程、远低于炸弹性损害 */
export const DEFAULT_ZIP_SAFETY_LIMITS: ZipSafetyLimits = {
  maxEntries: 50_000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxSingleFileBytes: 512 * 1024 * 1024,
  maxRatio: 500,
  ratioFloorBytes: 4096,
};

export type ZipSafetyResult =
  | { ok: true; /** 与文件条目平行的规范化相对路径（posix 分隔） */ normalized: string[] }
  | { ok: false; code: ZipSafetyCode; message: string };

/**
 * 归一化并校验**单个**条目路径；不安全返回 null（message 给原因）。
 *
 * 规则（PRD §4.3）：防路径穿越、绝对路径、Windows 盘符/UNC/ADS。
 * - 分隔符：ZIP 条目按规范用 '/'，但恶意包可能用 '\'——统一按两种分隔符切分；
 * - '..' 段一律拒绝（规范化后仍无法保证不越界时，宁可错杀：源码包不需要 '..'）；
 * - ADS：盘符检查之后任何 ':' 都视为 NTFS 流语法拒绝。
 */
export function normalizeZipEntryPath(
  rawPath: string,
): { ok: true; normalized: string } | { ok: false; code: ZipSafetyCode; message: string } {
  if (rawPath.length === 0) {
    return { ok: false, code: 'EMPTY_PATH', message: '存在空路径条目' };
  }
  // 目录条目去尾部 '/' 后按同一套规则校验
  const withoutTrailingSlash = rawPath.replace(/[/\\]+$/, '');
  if (withoutTrailingSlash.length === 0) {
    return { ok: true, normalized: '' }; // 根目录占位条目：忽略（无落盘效果）
  }
  if (withoutTrailingSlash.startsWith('\\\\') || withoutTrailingSlash.startsWith('//')) {
    return { ok: false, code: 'UNC_PATH', message: `条目为 UNC 路径：${rawPath}` };
  }
  if (rawPath.startsWith('/') || rawPath.startsWith('\\')) {
    return { ok: false, code: 'ABSOLUTE_PATH', message: `条目为绝对路径：${rawPath}` };
  }
  if (/^[a-zA-Z]:/.test(withoutTrailingSlash)) {
    return { ok: false, code: 'DRIVE_LETTER', message: `条目带 Windows 盘符：${rawPath}` };
  }
  const segments = withoutTrailingSlash.split(/[/\\]+/);
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, code: 'PATH_TRAVERSAL', message: `条目含路径穿越段（..）：${rawPath}` };
  }
  if (segments.some((segment) => segment.includes(':'))) {
    return { ok: false, code: 'ADS_STREAM', message: `条目含 NTFS 流语法（:）：${rawPath}` };
  }
  return { ok: true, normalized: segments.join('/') };
}

/** 大小写与 Windows 尾部字符归一化（仅用于碰撞检测，不改写实际写入名） */
function collisionKey(normalized: string): string {
  return normalized.toLowerCase().replace(/[. ]+$/, '');
}

/**
 * 校验整个 ZIP 的条目集合（解压前一次性调用；任一反例即整体拒绝）。
 * 通过时返回与**文件条目**平行的规范化路径数组（目录条目不在其中）。
 */
export function validateZipEntries(
  entries: readonly ZipEntryLike[],
  limits: ZipSafetyLimits = DEFAULT_ZIP_SAFETY_LIMITS,
): ZipSafetyResult {
  if (entries.length > limits.maxEntries) {
    return {
      ok: false,
      code: 'ENTRY_LIMIT',
      message: `条目数超过上限：${entries.length} > ${limits.maxEntries}（疑似解压炸弹，拒绝解压）`,
    };
  }

  const seenExact = new Set<string>();
  const seenCollision = new Set<string>();
  let totalBytes = 0;
  const normalizedFiles: string[] = [];

  for (const entry of entries) {
    const checked = normalizeZipEntryPath(entry.path);
    if (!checked.ok) return checked;
    if (checked.normalized === '') continue; // 根目录占位条目

    if (seenExact.has(checked.normalized)) {
      return {
        ok: false,
        code: 'DUPLICATE_PATH',
        message: `条目路径重复：${checked.normalized}（拒绝歧义解压）`,
      };
    }
    seenExact.add(checked.normalized);

    // Windows 文件系统大小写不敏感、尾部点/空格会被剥离：两者都可能造成静默覆盖
    const key = collisionKey(checked.normalized);
    if (seenCollision.has(key)) {
      return {
        ok: false,
        code: 'CASE_COLLISION',
        message: `条目大小写/尾部字符碰撞：${checked.normalized}（Windows 下会互相覆盖，拒绝解压）`,
      };
    }
    seenCollision.add(key);

    if (entry.uncompressedSize > limits.maxSingleFileBytes) {
      return {
        ok: false,
        code: 'SIZE_LIMIT',
        message: `单文件解压后超过上限：${entry.path}（${entry.uncompressedSize} > ${limits.maxSingleFileBytes}）`,
      };
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > limits.maxTotalBytes) {
      return {
        ok: false,
        code: 'SIZE_LIMIT',
        message: `解压后总大小超过上限：${totalBytes} > ${limits.maxTotalBytes}（疑似解压炸弹，拒绝解压）`,
      };
    }
    if (
      !entry.isDirectory &&
      entry.compressedSize >= limits.ratioFloorBytes &&
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > limits.maxRatio
    ) {
      return {
        ok: false,
        code: 'RATIO_LIMIT',
        message: `条目压缩比异常：${entry.path}（${entry.uncompressedSize}/${entry.compressedSize} > ${limits.maxRatio}，疑似解压炸弹）`,
      };
    }

    if (!entry.isDirectory) normalizedFiles.push(checked.normalized);
  }

  return { ok: true, normalized: normalizedFiles };
}
