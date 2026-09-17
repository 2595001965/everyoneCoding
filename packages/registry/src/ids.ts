/**
 * ULID 生成（与 `@ec/data/src/ids.ts` 同格式：26 位 Crockford base32，
 * 前 10 位毫秒时间戳 + 后 16 位随机，按时间有序、可跨设备合并）。
 *
 * 为何自持而不引 `@ec/data`：`@ec/data` 的根入口值引用 better-sqlite3 / node:fs，
 * 注册表包同时被渲染层（浏览器构建）与被测领域层使用，不应把存储层拖进依赖图。
 * 两处实现格式完全一致，主键可互换。
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now: number, length: number): string {
  let out = '';
  let value = now;
  for (let i = 0; i < length; i += 1) {
    out = ENCODING[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(length: number, random: () => number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ENCODING[Math.floor(random() * 32) % 32];
  }
  return out;
}

/** 生成 26 位 ULID；`now` / `random` 可注入以便测试确定性 */
export function newUlid(now: number = Date.now(), random: () => number = Math.random): string {
  if (!Number.isFinite(now) || now < 0) {
    throw new RangeError(`ULID 时间戳非法: ${String(now)}`);
  }
  return `${encodeTime(now, 10)}${encodeRandom(16, random)}`;
}

/** 从 ULID 解析毫秒时间戳，解析失败返回 null */
export function ulidTime(id: string): number | null {
  if (id.length !== 26) return null;
  let value = 0;
  for (let i = 0; i < 10; i += 1) {
    const index = ENCODING.indexOf(id[i] as string);
    if (index < 0) return null;
    value = value * 32 + index;
  }
  return value;
}

/** 是否是合法 ULID */
export function isUlid(id: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id) && ulidTime(id) !== null;
}
