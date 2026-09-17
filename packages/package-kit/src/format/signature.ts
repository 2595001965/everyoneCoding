/**
 * 可选 Ed25519 签名（T8-01 / FR-PKG-04 验收第 4 条）。
 *
 * 用途：文件分发场景的来源完整性校验（导出方用私钥签名，导入方用公钥验证）。
 * 未配置密钥时整段跳过——签名是可选项，不强制。
 *
 * 签名对象：manifest.json 的**规范化字节**——即去掉 `signature` 字段后重新
 * JSON.stringify 的字节（两端的 JS 引擎都按插入序序列化字符串键，字节稳定）。
 * 权威载体是包根的 `signature.sig` 文件（manifest.signature 只是回显，便于工具查看）。
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

export const SIGNATURE_PREFIX = 'ed25519:';

export interface Ed25519KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** 生成一对 Ed25519 密钥（PEM；供设置界面导出/导入与测试使用） */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** 从 manifest 对象得到"待签名字节"：去掉 signature 字段后重新序列化 */
export function canonicalManifestBytes(manifest: Record<string, unknown>): Buffer {
  const copy: Record<string, unknown> = { ...manifest };
  delete copy.signature;
  return Buffer.from(JSON.stringify(copy), 'utf8');
}

/** 用私钥对 manifest 规范化字节签名，返回 `ed25519:<base64>` 形式 */
export function signManifest(manifest: Record<string, unknown>, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const signature = cryptoSign(null, canonicalManifestBytes(manifest), key);
  return `${SIGNATURE_PREFIX}${signature.toString('base64')}`;
}

/**
 * 校验签名：manifest.signature（或 signature.sig 内容）是否与 manifest 规范化字节匹配。
 * 返回 false 而不是抛错——调用方把"签名不符"作为明确的校验失败原因上报。
 */
export function verifyManifestSignature(
  manifest: Record<string, unknown>,
  signature: string,
  publicKeyPem: string,
): boolean {
  if (!signature.startsWith(SIGNATURE_PREFIX)) return false;
  const base64 = signature.slice(SIGNATURE_PREFIX.length);
  try {
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify(null, canonicalManifestBytes(manifest), key, Buffer.from(base64, 'base64'));
  } catch {
    // 密钥格式错误 / base64 不合法：一律视为校验失败（不掩盖为"跳过"）
    return false;
  }
}

/** 从 signature.sig 文件文本中提取签名串（允许首尾空白与换行） */
export function parseSignatureFile(text: string): string {
  return text.trim();
}
