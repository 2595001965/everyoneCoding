/**
 * 密码哈希：scrypt + 随机盐，使用 Node 内置 node:crypto，不引入第三方库。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const PREFIX = 'scrypt';

/** 返回格式：scrypt$<saltHex>$<derivedHex> */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, KEY_LENGTH);
  return `${PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const prefix = parts[0];
  const saltHex = parts[1];
  const expectedHex = parts[2];
  if (prefix !== PREFIX || !saltHex || !expectedHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  const derived = scryptSync(password, salt, expected.length);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

/**
 * 密码强度校验：长度 ≥ 8，且至少包含「小写、大写、数字、特殊字符」中的两类。
 */
export function isStrongPassword(password: string): boolean {
  if (typeof password !== 'string' || password.length < 8) return false;
  let categories = 0;
  if (/[a-z]/.test(password)) categories += 1;
  if (/[A-Z]/.test(password)) categories += 1;
  if (/[0-9]/.test(password)) categories += 1;
  if (/[^a-zA-Z0-9]/.test(password)) categories += 1;
  return categories >= 2;
}
