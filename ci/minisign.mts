/**
 * minisign 验签（Tauri updater 同款格式），发布前在 CI 里核对 `.sig` 与仓库公钥是否配套。
 *
 * 为什么发布脚本要自己验一遍：Tauri 客户端只在**用户机器上**验签，签错了（用错私钥 / 公钥没换 /
 * 产物被二次改动）要等全部用户"一直检查不到更新"才会暴露。在 `make-release` 里先验，错了直接不发。
 *
 * 格式（Tauri 的 pubkey 与 `.sig` 都是"整份 minisign 文本再 base64 一层"）：
 * - 公钥第二行：`Ed` + key_id(8) + ed25519 公钥(32)
 * - 签名第二行：`ED`(预哈希 BLAKE2b-512) 或 `Ed`(原文) + key_id(8) + 签名(64)；
 *   第三行 `trusted comment: ...`，第四行 = 对 (签名 || 可信注释) 的全局签名(64)。
 */

import { createHash, createPublicKey, verify } from 'node:crypto';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface MinisignPublicKey {
  keyId: string;
  key: ReturnType<typeof createPublicKey>;
}

function decodeTauriText(value: string): string[] {
  const text = value.includes('untrusted comment:')
    ? value
    : Buffer.from(value.trim(), 'base64').toString('utf8');
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

export function parsePublicKey(tauriPubkey: string): MinisignPublicKey {
  const lines = decodeTauriText(tauriPubkey);
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('公钥格式不对（应为 minisign Ed25519 公钥）');
  }
  return {
    keyId: raw.subarray(2, 10).toString('hex'),
    key: createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw.subarray(10)]),
      format: 'der',
      type: 'spki',
    }),
  };
}

export type VerifyResult =
  { ok: true; keyId: string; trustedComment: string } | { ok: false; reason: string };

export function verifyMinisign(
  data: Buffer,
  tauriSignature: string,
  publicKey: MinisignPublicKey,
): VerifyResult {
  let lines: string[];
  try {
    lines = decodeTauriText(tauriSignature);
  } catch {
    return { ok: false, reason: '签名不是合法的 base64' };
  }
  const sigLine = Buffer.from(lines[1] ?? '', 'base64');
  const trusted = lines[2] ?? '';
  const globalSig = Buffer.from(lines[3] ?? '', 'base64');
  if (sigLine.length !== 74) return { ok: false, reason: '签名格式不对' };
  const algorithm = sigLine.subarray(0, 2).toString('latin1');
  const keyId = sigLine.subarray(2, 10).toString('hex');
  const signature = sigLine.subarray(10);
  if (keyId !== publicKey.keyId) {
    return {
      ok: false,
      reason: `签名用的密钥 ${keyId} 与公钥 ${publicKey.keyId} 不符（私钥与 tauri.conf.json 的 pubkey 不配套）`,
    };
  }
  const message =
    algorithm === 'ED'
      ? createHash('blake2b512').update(data).digest()
      : algorithm === 'Ed'
        ? data
        : null;
  if (message === null) return { ok: false, reason: `不支持的签名算法 ${algorithm}` };
  if (!verify(null, message, publicKey.key, signature)) {
    return { ok: false, reason: '签名与文件内容不符（文件被改动 / 下载不完整 / 签错了文件）' };
  }
  if (!trusted.startsWith('trusted comment: ')) return { ok: false, reason: '缺少可信注释' };
  const trustedComment = trusted.slice('trusted comment: '.length);
  if (
    globalSig.length !== 64 ||
    !verify(null, Buffer.concat([signature, Buffer.from(trustedComment)]), publicKey.key, globalSig)
  ) {
    return { ok: false, reason: '可信注释的全局签名不符' };
  }
  return { ok: true, keyId, trustedComment };
}
