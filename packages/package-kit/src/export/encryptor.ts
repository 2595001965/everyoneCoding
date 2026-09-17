/**
 * 导出加密封装（T8-02 / FR-PKG-05）。
 *
 * 仅封装 `container/envelope` 的 `wrapWithPassword`：先把明文 ZIP 落盘（由 export-job
 * 用 `<outputPath>.plain.tmp` 作为中转），再包裹成加密 `.ecpkg`，最后删除明文中转文件。
 *
 * 硬约束：口令绝不写入包内任何地方（envelope 层只拿口令派生密钥，manifest 仅标记算法）。
 * 错误口令由 reader 层在解密时抛 `PasswordError` 且不产生半解密数据。
 */

import * as fs from 'node:fs';

import { encryptionMarker, wrapWithPassword } from '../container/envelope';
import type { EncryptionInfo } from '../format/manifest';

export { encryptionMarker };

/**
 * 把已 finalize 的明文 ZIP 包裹成加密包。
 * @param zipPath 明文中转 ZIP（绝对路径）
 * @param outputPath 最终加密包路径（绝对路径）
 * @param password 非空口令
 */
export function encryptPackage(zipPath: string, outputPath: string, password: string): void {
  wrapWithPassword(zipPath, outputPath, password);
}

/** 删除明文中转文件（尽力清理，忽略缺失） */
export function deletePlainZip(zipPath: string): void {
  try {
    fs.unlinkSync(zipPath);
  } catch {
    /* 中转文件可能本就不存在 */
  }
}

/** 构造 manifest 用的加密标记（aes-256-gcm / PBKDF2-SHA256 / 210000 迭代） */
export function encryptionInfo(): EncryptionInfo {
  return encryptionMarker();
}
