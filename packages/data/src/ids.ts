/**
 * ULID 生成（Crockford base32：前 10 位毫秒时间戳 + 后 16 位随机）。
 * 全库主键统一使用该格式，保证按时间大致有序且可跨设备合并。
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

/** 生成一个 26 位 ULID 字符串 */
export function newUlid(now: number = Date.now(), random: () => number = Math.random): string {
  if (!Number.isFinite(now) || now < 0) {
    throw new RangeError(`ULID 时间戳非法: ${String(now)}`);
  }
  return `${encodeTime(now, 10)}${encodeRandom(16, random)}`;
}

/** 从 ULID 解析出毫秒时间戳，解析失败返回 null */
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

/** 当前毫秒时间戳（统一入口，便于测试注入） */
export function nowMs(): number {
  return Date.now();
}
