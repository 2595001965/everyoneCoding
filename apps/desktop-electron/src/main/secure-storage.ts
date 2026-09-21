import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * DPAPI 密文文件存储（主进程共用）。
 *
 * 抽出来的原因：密钥环既要被 `ipc/secure_store.ts`（渲染层直连的通用通道）使用，
 * 也要被域层（git 凭据）使用。如果域去 import ipc 模块，依赖方向就反了
 * （域是被 ipc 装配的东西），所以把"加密 + 落盘"这一段下沉到本文件。
 *
 * 硬约束（与 ipc/secure_store.ts 原文一致）：
 * - 磁盘上**只允许出现密文**，任何异常不得把明文带出；
 * - 明文只经 `safeStorage`（Windows 上即 DPAPI，用户上下文）加解密；
 * - 键名必须落在安全字符集内 —— 这一条不只是"防注入"：Windows 上文件名里的
 *   `:` 会被解释成 NTFS 备用数据流（ADS），写入/读取都"成功"但 `readdir`
 *   永远列不出该条目，会变成极难定位的静默失败。
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecureFileStorage {
  write(namespace: string, key: string, value: string): Promise<void>;
  read(namespace: string, key: string): Promise<string | null>;
  remove(namespace: string, key: string): Promise<void>;
  keys(namespace: string): Promise<string[]>;
}

/** 键名安全字符集（不含 `:` —— 见文件头 ADS 说明） */
export const SECURE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

export function isSafeSecureKey(key: string): boolean {
  return SECURE_KEY_PATTERN.test(key);
}

/**
 * 把任意字符串编码成安全键名（**可逆**）。
 *
 * 编码规则：安全字符原样保留；其余字符输出 `_` + 两位小写十六进制。
 * 因为字面 `_` 一定被编码成 `_5f`，所以解码时遇到 `_` 必然跟着两位十六进制，
 * 不存在歧义（这是与"直接替换成 `_`"的关键区别——那种做法不可逆，
 * 两个不同的远程名可能映射到同一个文件）。
 */
export function encodeSecureKey(input: string): string {
  let out = '';
  for (const char of input) {
    if (/[A-Za-z0-9-]/.test(char)) {
      out += char;
      continue;
    }
    if (char === '.') {
      // `.` 本身安全，但为了与分隔用途区分，仍保持原样（解码不依赖它的位置）
      out += '.';
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    out += code <= 0xff ? `_${code.toString(16).padStart(2, '0')}` : `_u${code.toString(16)}_`;
  }
  return out;
}

export function decodeSecureKey(input: string): string {
  let out = '';
  let index = 0;
  while (index < input.length) {
    const char = input[index] as string;
    if (char !== '_') {
      out += char;
      index += 1;
      continue;
    }
    if (input[index + 1] === 'u') {
      const end = input.indexOf('_', index + 2);
      if (end < 0) {
        out += char;
        index += 1;
        continue;
      }
      out += String.fromCodePoint(Number.parseInt(input.slice(index + 2, end), 16));
      index = end + 1;
      continue;
    }
    const hex = input.slice(index + 1, index + 3);
    if (!/^[0-9a-f]{2}$/.test(hex)) {
      out += char;
      index += 1;
      continue;
    }
    out += String.fromCharCode(Number.parseInt(hex, 16));
    index += 3;
  }
  return out;
}

export interface CreateSecureFileStorageOptions {
  secureDir: string;
  safeStorage: SafeStorageLike;
}

/**
 * 建立存储。`safeStorage` 不可用时**在构造期就失败**——
 * 绝不降级为明文落盘（那会让"凭据不落明文"的验收标准直接失效）。
 */
export function createSecureFileStorage(
  options: CreateSecureFileStorageOptions,
): SecureFileStorage {
  const { secureDir, safeStorage } = options;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用（safeStorage），拒绝以明文方式保存密钥');
  }

  const dirOf = (namespace: string): string => path.join(secureDir, namespace);
  const fileOf = (namespace: string, key: string): string =>
    path.join(dirOf(namespace), `${key}.dat`);

  return {
    async write(namespace, key, value) {
      await fsp.mkdir(dirOf(namespace), { recursive: true });
      const cipher = safeStorage.encryptString(value);
      await fsp.writeFile(fileOf(namespace, key), cipher);
    },
    async read(namespace, key) {
      try {
        const cipher = await fsp.readFile(fileOf(namespace, key));
        return safeStorage.decryptString(cipher);
      } catch {
        return null;
      }
    },
    async remove(namespace, key) {
      await fsp.rm(fileOf(namespace, key), { force: true });
    },
    async keys(namespace) {
      try {
        const entries = await fsp.readdir(dirOf(namespace));
        return entries.filter((name) => name.endsWith('.dat')).map((name) => name.slice(0, -4));
      } catch {
        return [];
      }
    },
  };
}
