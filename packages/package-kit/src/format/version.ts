/**
 * `.ecpkg` 格式版本与兼容策略（T8-01 / FR-PKG-03 / NFR-C-04）。
 *
 * `formatVersion` 为语义化版本（major.minor.patch）：
 * - **major 升级**表示包结构发生不兼容变更（拆字段 / 改布局）——
 *   高版本包在低版本客户端上必须明确提示"需升级"，绝不静默失败；
 * - **minor / patch 升级**保证向后兼容：旧客户端可以读取（新增字段按缺省处理）。
 *
 * 兼容矩阵覆盖近 3 个格式版本：旧包（major 更小）在新客户端上可读；
 * 同 major 内的 minor 差异可读；仅 major 超前才阻断。
 */

/** 当前客户端支持的 `.ecpkg` 格式版本（写入新包时使用） */
export const FORMAT_VERSION = '1.0.0';

/** 语义化版本正则（严格三段式，不允许前导零） */
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface FormatVersion {
  major: number;
  minor: number;
  patch: number;
}

/** 解析语义化版本；不合法返回 null（调用方转为明确报错，不静默） */
export function parseFormatVersion(value: string): FormatVersion | null {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** 语义化版本比较：a < b 返回 -1，相等返回 0，a > b 返回 1 */
export function compareFormatVersions(a: string, b: string): -1 | 0 | 1 {
  const va = parseFormatVersion(a);
  const vb = parseFormatVersion(b);
  if (va === null || vb === null) {
    throw new Error(`格式版本不合法：${va === null ? a : b}（期望 major.minor.patch 三段式）`);
  }
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  return 0;
}

export type FormatCompatibilityStatus = 'compatible' | 'requires-upgrade';

export interface FormatCompatibility {
  status: FormatCompatibilityStatus;
  /** 包的格式版本 */
  packageVersion: string;
  /** 客户端支持的格式版本 */
  clientVersion: string;
  /** 不兼容时的中文提示（含最低所需客户端版本），兼容时为 null */
  message: string | null;
}

/**
 * 校验"包格式版本 ↔ 客户端支持版本"的兼容性。
 *
 * 策略：
 * - 包 major > 客户端 major → `requires-upgrade`：结构不兼容，必须升级客户端；
 * - 其余情况（包 major 更低或相同）→ `compatible`：向后兼容可读。
 */
export function checkFormatCompatibility(
  packageVersion: string,
  clientVersion: string = FORMAT_VERSION,
): FormatCompatibility {
  const pv = parseFormatVersion(packageVersion);
  if (pv === null) {
    return {
      status: 'requires-upgrade',
      packageVersion,
      clientVersion,
      message: `包格式版本不合法：${packageVersion}（期望 major.minor.patch），无法安全导入`,
    };
  }
  const cv = parseFormatVersion(clientVersion);
  if (cv === null) {
    throw new Error(`客户端格式版本不合法：${clientVersion}`);
  }
  if (pv.major > cv.major) {
    return {
      status: 'requires-upgrade',
      packageVersion,
      clientVersion,
      message: `该包的格式版本为 ${packageVersion}，高于当前客户端支持的 ${clientVersion}，需升级 EveryoneCoding 后再导入`,
    };
  }
  return { status: 'compatible', packageVersion, clientVersion, message: null };
}

/**
 * 兼容矩阵用例（T8-01 验收：覆盖近 3 个格式版本场景）。
 * 测试据此逐条断言：旧包可读、同 major 的 minor 超前可读、major 超前阻断。
 */
export interface CompatibilityMatrixCase {
  name: string;
  packageVersion: string;
  clientVersion: string;
  expected: FormatCompatibilityStatus;
}

export const COMPATIBILITY_MATRIX: readonly CompatibilityMatrixCase[] = [
  {
    name: '旧包在新客户端（0.9.x → 1.0.0）',
    packageVersion: '0.9.0',
    clientVersion: '1.0.0',
    expected: 'compatible',
  },
  { name: '同版本', packageVersion: '1.0.0', clientVersion: '1.0.0', expected: 'compatible' },
  {
    name: '同 major 的 minor 超前（1.1.0 → 1.0.0）',
    packageVersion: '1.1.0',
    clientVersion: '1.0.0',
    expected: 'compatible',
  },
  {
    name: '同 major 的 patch 超前（1.0.3 → 1.0.0）',
    packageVersion: '1.0.3',
    clientVersion: '1.0.0',
    expected: 'compatible',
  },
  {
    name: 'major 超前阻断（2.0.0 → 1.0.0）',
    packageVersion: '2.0.0',
    clientVersion: '1.0.0',
    expected: 'requires-upgrade',
  },
  {
    name: '版本不合法阻断',
    packageVersion: 'one-two-three',
    clientVersion: '1.0.0',
    expected: 'requires-upgrade',
  },
];
