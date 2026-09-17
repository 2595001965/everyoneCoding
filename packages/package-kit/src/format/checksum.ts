/**
 * 逐文件 SHA-256 完整性校验（T8-01 / FR-PKG-04）。
 *
 * 清单文件 `checksums.sha256` 采用 sha256sum 风格行格式：
 * ```
 * <hex>  <包内路径>
 * ```
 * （哈希与路径之间两个空格，路径内不允许换行——包内路径本身不包含换行。）
 *
 * 导入前对包内全部文件重算哈希并逐条比对，任何一条不符都指出具体文件，
 * 整体判失败（绝不"跳过坏文件继续导入"）。
 */
import { createHash } from 'node:crypto';

/** 校验清单：包内路径 → SHA-256 十六进制小写 */
export type ChecksumMap = Map<string, string>;

/** 对一段内容计算 SHA-256（十六进制小写） */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 由「路径 + 内容」清单构建校验表 */
export function buildChecksums(entries: readonly { path: string; content: Buffer | string }[]): ChecksumMap {
  const map: ChecksumMap = new Map();
  for (const entry of entries) {
    map.set(entry.path, sha256Hex(entry.content));
  }
  return map;
}

/** 校验表 → checksums.sha256 文件内容（按路径排序，保证确定性） */
export function serializeChecksumFile(map: ChecksumMap): string {
  const paths = [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = paths.map((path) => `${map.get(path)}  ${path}`);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** 解析 checksums.sha256 文本；空行与 # 注释行跳过 */
export function parseChecksumFile(text: string): ChecksumMap {
  const map: ChecksumMap = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('  ');
    if (separatorIndex === -1) {
      throw new Error(`checksums.sha256 行格式不合法（缺少双空格分隔）：${line.slice(0, 60)}`);
    }
    const hash = line.slice(0, separatorIndex);
    const path = line.slice(separatorIndex + 2);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`checksums.sha256 哈希不合法：${hash.slice(0, 16)}…`);
    }
    if (path.length === 0) {
      throw new Error('checksums.sha256 存在空路径条目');
    }
    map.set(path, hash);
  }
  return map;
}

export interface IntegrityIssue {
  path: string;
  /** 具体原因：哈希不符（含期望/实际）或文件缺失 */
  reason: string;
}

export interface IntegrityReport {
  /** 全部文件校验通过 */
  ok: boolean;
  /** 哈希不符的文件 */
  corrupted: IntegrityIssue[];
  /** 清单里有、包里没有的文件 */
  missing: IntegrityIssue[];
  /** 校验的文件总数 */
  checked: number;
}

/**
 * 全量校验：对清单中的每个路径从包内取内容重算 SHA-256 并比对。
 *
 * `readEntry` 返回 null 表示包内缺该文件。任何损坏都记录具体路径与原因，
 * 由调用方决定整体中止（导入流程永远中止，不产生半导入状态）。
 */
export async function verifyChecksums(
  expected: ChecksumMap,
  readEntry: (path: string) => Promise<Buffer | string | null>,
): Promise<IntegrityReport> {
  const corrupted: IntegrityIssue[] = [];
  const missing: IntegrityIssue[] = [];
  let checked = 0;

  for (const [path, expectedHash] of expected) {
    const content = await readEntry(path);
    if (content === null) {
      missing.push({ path, reason: '包内缺少该文件（校验清单中存在）' });
      continue;
    }
    checked += 1;
    const actual = sha256Hex(content);
    if (actual !== expectedHash) {
      corrupted.push({
        path,
        reason: `SHA-256 不符：期望 ${expectedHash.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
      });
    }
  }

  return { ok: corrupted.length === 0 && missing.length === 0, corrupted, missing, checked };
}
