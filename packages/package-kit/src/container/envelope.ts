/**
 * `.ecpkg` 加密信封（T8-01 容器层 / T8-02 加密导出 / FR-PKG-05）。
 *
 * 明文包是标准 ZIP（以 `PK\x03\x04` 开头）；加密包在本仓自定义信封内封装整个 ZIP：
 * ```
 * 偏移 0   : magic 'ECPKG'（5 字节 ASCII）
 * 偏移 5   : 信封版本 = 1
 * 偏移 6   : flags = 1（已加密）
 * 偏移 7   : 保留 = 0
 * 偏移 8   : salt（16 字节，PBKDF2 用）
 * 偏移 24  : nonce（12 字节，GCM 用）
 * 偏移 36  : 密文（AES-256-GCM，整段 ZIP 流式加密）
 * 末尾 16  : GCM 认证标签
 * ```
 * - 密钥 = PBKDF2-SHA256(口令, salt, 210000, 32)；**口令绝不写入包内**；
 * - 解密先校验认证标签再交付数据：口令错误时直接报错并清理临时文件，
 *   **绝不产生半解密数据**（解密目标始终是临时文件，验证通过才交给解析器）。
 */
import * as fs from 'node:fs';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('ECPKG', 'ascii');
const ENVELOPE_VERSION = 1;
const FLAG_ENCRYPTED = 1;
/** magic(5) + version(1) + flags(1) + reserved(1) + salt(16) + nonce(12) */
export const ENVELOPE_HEADER_SIZE = 36;
export const GCM_TAG_LENGTH = 16;
export const SALT_LENGTH = 16;
export const NONCE_LENGTH = 12;
/** PRD §14.1 / FR-PKG-05 规定的 PBKDF2 迭代次数 */
export const PBKDF2_ITERATIONS = 210000;
/** 流式加解密的块大小 */
const CHUNK_SIZE = 1024 * 1024;

/** 口令错误 / 认证标签不符：明确区分于其他 IO 错误 */
export class PasswordError extends Error {
  constructor(message = '解密失败：口令错误或包已损坏（认证标签校验不通过），未产生任何解密数据') {
    super(message);
    this.name = 'PasswordError';
    Object.setPrototypeOf(this, PasswordError.prototype);
  }
}

/** 探测文件是否为加密信封（读前 5 字节比对 magic） */
export function isEncryptedPackage(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length);
    const bytesRead = fs.readSync(fd, head, 0, MAGIC.length, 0);
    if (bytesRead < MAGIC.length) return false;
    return head.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
}

/** 密钥派生参数（导出端写入 manifest.encryption；导入端校验用） */
export function encryptionMarker(): { mode: 'aes-256-gcm'; kdf: 'PBKDF2-SHA256'; iterations: number } {
  return { mode: 'aes-256-gcm', kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS };
}

/**
 * 把明文 ZIP 加密为信封包（流式：源文件分块读入，密文即写即落盘）。
 * 写入临时文件成功后原子替换目标路径；失败时清理临时文件。
 */
export function wrapWithPassword(zipAbsolutePath: string, outputAbsolutePath: string, password: string): void {
  if (password.length === 0) {
    throw new Error('加密导出需要非空口令');
  }
  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);

  const tempPath = `${outputAbsolutePath}.encrypting.tmp`;
  const outFd = fs.openSync(tempPath, 'w');
  try {
    // 信封头
    const header = Buffer.alloc(ENVELOPE_HEADER_SIZE);
    MAGIC.copy(header, 0);
    header.writeUInt8(ENVELOPE_VERSION, 5);
    header.writeUInt8(FLAG_ENCRYPTED, 6);
    header.writeUInt8(0, 7);
    salt.copy(header, 8);
    nonce.copy(header, 24);
    fs.writeSync(outFd, header, 0, header.length, 0);

    // 密文流
    const sourceFd = fs.openSync(zipAbsolutePath, 'r');
    try {
      const sourceSize = fs.fstatSync(sourceFd).size;
      const buf = Buffer.alloc(CHUNK_SIZE);
      let offset = 0;
      let outPosition = ENVELOPE_HEADER_SIZE;
      for (;;) {
        const bytesRead = fs.readSync(sourceFd, buf, 0, CHUNK_SIZE, offset);
        if (bytesRead === 0) break;
        const encrypted = cipher.update(buf.subarray(0, bytesRead));
        fs.writeSync(outFd, encrypted, 0, encrypted.length, outPosition);
        outPosition += encrypted.length;
        offset += bytesRead;
      }
      void sourceSize;
      const finalChunk = cipher.final();
      fs.writeSync(outFd, finalChunk, 0, finalChunk.length, outPosition);
      outPosition += finalChunk.length;

      // 认证标签写在最末（解密端先解出密文、再取末 16 字节验签）
      const tag = cipher.getAuthTag();
      fs.writeSync(outFd, tag, 0, tag.length, outPosition);
    } finally {
      fs.closeSync(sourceFd);
    }
    fs.closeSync(outFd);
    fs.renameSync(tempPath, outputAbsolutePath);
  } catch (error) {
    try {
      fs.closeSync(outFd);
    } catch {
      /* 忽略重复关闭 */
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* 尽力清理 */
    }
    throw error;
  }
}

/**
 * 把加密信封解密为明文 ZIP（写到 `plainZipAbsolutePath` 临时文件）。
 *
 * 认证标签在**最后 16 字节**：先把密文（不含标签）流式解出，再验签；
 * 任一步失败都删除临时文件并抛 `PasswordError`——目标路径永远不接触半解密数据。
 */
export function unwrapWithPassword(
  packageAbsolutePath: string,
  plainZipAbsolutePath: string,
  password: string,
): void {
  const sourceFd = fs.openSync(packageAbsolutePath, 'r');
  let tempOpened = false;
  let outFd = -1;
  try {
    const sourceSize = fs.fstatSync(sourceFd).size;
    if (sourceSize < ENVELOPE_HEADER_SIZE + GCM_TAG_LENGTH) {
      throw new PasswordError('加密包结构不完整（比信封头还短）');
    }
    const header = Buffer.alloc(ENVELOPE_HEADER_SIZE);
    readFullyAt(sourceFd, header, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new PasswordError('加密包信封头不合法（magic 不符）');
    }
    if (header.readUInt8(5) !== ENVELOPE_VERSION) {
      throw new PasswordError(`加密信封版本不支持：${header.readUInt8(5)}`);
    }
    if (header.readUInt8(6) !== FLAG_ENCRYPTED) {
      throw new PasswordError('加密信封 flags 不合法');
    }
    const salt = header.subarray(8, 8 + SALT_LENGTH);
    const nonce = header.subarray(24, 24 + NONCE_LENGTH);
    const key = deriveKey(password, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);

    const cipherSize = sourceSize - ENVELOPE_HEADER_SIZE - GCM_TAG_LENGTH;
    const tempPath = `${plainZipAbsolutePath}.decrypting.tmp`;
    outFd = fs.openSync(tempPath, 'w');
    tempOpened = true;

    const buf = Buffer.alloc(CHUNK_SIZE);
    let offset = 0;
    let outPosition = 0;
    for (;;) {
      const remaining = cipherSize - offset;
      if (remaining <= 0) break;
      const toRead = Math.min(remaining, buf.length);
      const chunk = Buffer.alloc(toRead);
      readFullyAt(sourceFd, chunk, ENVELOPE_HEADER_SIZE + offset);
      const plain = decipher.update(chunk);
      fs.writeSync(outFd, plain, 0, plain.length, outPosition);
      outPosition += plain.length;
      offset += toRead;
    }

    // 验证认证标签（在交付任何数据之前）
    const tag = Buffer.alloc(GCM_TAG_LENGTH);
    readFullyAt(sourceFd, tag, ENVELOPE_HEADER_SIZE + cipherSize);
    decipher.setAuthTag(tag);
    const finalChunk = decipher.final(); // 标签不符在此抛错
    fs.writeSync(outFd, finalChunk, 0, finalChunk.length, outPosition);

    fs.closeSync(outFd);
    outFd = -1;
    fs.renameSync(tempPath, plainZipAbsolutePath);
  } catch (error) {
    if (outFd !== -1) {
      try {
        fs.closeSync(outFd);
      } catch {
        /* 忽略 */
      }
    }
    // 清理解密临时文件（绝不留下半解密数据）
    if (tempOpened) {
      try {
        fs.unlinkSync(`${plainZipAbsolutePath}.decrypting.tmp`);
      } catch {
        /* 尽力清理 */
      }
    }
    if (error instanceof PasswordError) throw error;
    // crypto 的 GCM 校验失败统一转成口令错误语义
    if (error instanceof Error && /auth|decrypt|.bad decrypt/i.test(error.message)) {
      throw new PasswordError();
    }
    throw error;
  } finally {
    fs.closeSync(sourceFd);
  }
}

function readFullyAt(fd: number, buffer: Buffer, position: number): void {
  let read = 0;
  while (read < buffer.length) {
    const n = fs.readSync(fd, buffer, read, buffer.length - read, position + read);
    if (n <= 0) throw new Error('文件意外到达末尾（可能被截断）');
    read += n;
  }
}
