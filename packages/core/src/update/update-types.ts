/**
 * 更新领域：版本号比较（T10-04 / FR-SET-05）。
 *
 * 只实现与"要不要更新"相关的语义，不引入 semver 依赖：
 * - 三段数字 + 可选预发布标识（`1.2.3-beta.1`）
 * - 预发布版本**小于**同号正式版（语义化版本 §11）
 * - 数字段比较用数值而非字典序（`1.10.0 > 1.9.0`）
 */

export interface VersionParts {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识，如 `beta.1` → ['beta','1']；正式版为空数组 */
  prerelease: string[];
}

/** 解析版本号；非法输入返回 null（调用方决定是报错还是当"无更新"）。 */
export function parseVersion(raw: string): VersionParts | null {
  const text = raw.trim().replace(/^v/i, '');
  if (text === '') return null;
  const [core, ...preParts] = text.split('-');
  if (core === undefined) return null;
  const segments = core.split('.');
  if (segments.length !== 3) return null;
  const numbers: number[] = [];
  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) return null;
    numbers.push(Number(segment));
  }
  const [major, minor, patch] = numbers as [number, number, number];
  const prerelease = preParts.join('-').split('.').filter((part) => part !== '');
  return { major, minor, patch, prerelease };
}

/** 比较两个预发布标识段（语义化版本 §11）。 */
function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  // 有预发布标识 < 无预发布标识
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    // 数字标识 < 字母标识
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

/**
 * 比较版本：`a > b` 返回 1，`a < b` 返回 -1，相等返回 0。
 * 任一无法解析时**抛错**（静默返回 0 会让"更新检查"变成哑巴，问题更难查）。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null) throw new Error(`非法版本号：${a}`);
  if (right === null) throw new Error(`非法版本号：${b}`);
  for (const key of ['major', 'minor', 'patch'] as const) {
    const diff = left[key] - right[key];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** `candidate` 是否比 `current` 新（用于"发现新版本"判定）。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** 校验版本号是否合法（发布流水线用）。 */
export function isValidVersion(raw: string): boolean {
  return parseVersion(raw) !== null;
}
