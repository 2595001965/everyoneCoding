import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Ed25519 签名校验（可选能力，FR-MDL-06）。
 *
 * 策略：
 * - 用户未填公钥 → 跳过校验（`skipped`），并在拉取结果里如实标注
 * - 用户填了公钥但响应没有签名 → 视为失败（`missing`），防止"以为有校验其实没有"
 * - 签名不匹配 → 失败（`invalid`），旧配置保持不变
 *
 * 公钥支持两种输入：PEM 文本（`-----BEGIN PUBLIC KEY-----`）或 base64 裸密钥（自动补 PEM 头尾）。
 */

export type VerifyOutcome = 'skipped' | 'missing' | 'invalid' | 'valid';

export interface VerifyResult {
  outcome: VerifyOutcome;
  message: string;
}

export function normalizePublicKey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('BEGIN PUBLIC KEY')) return trimmed;
  const body = trimmed.replace(/\s+/g, '').match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${body.join('\n')}\n-----END PUBLIC KEY-----`;
}

export function verifySignature(
  raw: string,
  signature: string | null,
  publicKey: string | null | undefined,
): VerifyResult {
  if (!publicKey || publicKey.trim().length === 0) {
    return { outcome: 'skipped', message: '未配置公钥，已跳过签名校验' };
  }
  if (!signature) {
    return { outcome: 'missing', message: '已配置公钥，但响应缺少签名字段' };
  }

  try {
    const key = createPublicKey(normalizePublicKey(publicKey));
    const signatureBytes = Buffer.from(
      signature,
      /^[0-9a-f]+$/i.test(signature) ? 'hex' : 'base64',
    );
    const ok = cryptoVerify(null, Buffer.from(raw, 'utf8'), key, signatureBytes);
    return ok
      ? { outcome: 'valid', message: '签名校验通过' }
      : { outcome: 'invalid', message: '签名校验失败，配置未应用' };
  } catch (error) {
    return {
      outcome: 'invalid',
      message: `签名校验异常：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
