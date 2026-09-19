/**
 * 凭据安全工具（T9-05）：密码强度校验与 PKCE。
 *
 * 纯函数、零依赖（PKCE 的 SHA-256 用全局 crypto.subtle，浏览器与 Node 18+ 均可用）。
 */

/** 密码强度等级 */
export type PasswordStrength = 'empty' | 'weak' | 'medium' | 'strong';

export interface PasswordCheck {
  strength: PasswordStrength;
  /** 是否满足最低要求：≥8 位且含两类字符（FR-ACC-01） */
  valid: boolean;
  /** 问题清单（实时提示用） */
  issues: string[];
}

const CLASS_TESTS: Array<{ label: string; test: (value: string) => boolean }> = [
  { label: '小写字母', test: (value) => /[a-z]/.test(value) },
  { label: '大写字母', test: (value) => /[A-Z]/.test(value) },
  { label: '数字', test: (value) => /\d/.test(value) },
  { label: '符号', test: (value) => /[^A-Za-z0-9]/.test(value) },
];

/** 密码校验与实时提示 */
export function checkPassword(password: string, confirm?: string): PasswordCheck {
  const issues: string[] = [];
  if (!password) {
    return { strength: 'empty', valid: false, issues: ['请输入密码'] };
  }
  if (password.length < 8) issues.push('密码至少 8 位');

  const classes = CLASS_TESTS.filter((item) => item.test(password)).length;
  if (classes < 2) issues.push('需包含大小写字母、数字、符号中的至少两类');
  if (confirm !== undefined && confirm !== password) issues.push('两次输入的密码不一致');

  const valid = issues.length === 0;
  const strength: PasswordStrength = !valid
    ? 'weak'
    : password.length >= 12 && classes >= 3
      ? 'strong'
      : 'medium';
  return { strength, valid, issues };
}

export const PASSWORD_STRENGTH_LABELS: Record<PasswordStrength, string> = {
  empty: '',
  weak: '弱',
  medium: '中',
  strong: '强',
};

/* ------------------------------- PKCE ------------------------------- */

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成 code_verifier（43~128 位 URL 安全随机串） */
export function createCodeVerifier(length = 64): string {
  const bytes = new Uint8Array(length);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return base64UrlEncode(bytes).slice(0, 128);
}

/** code_challenge = BASE64URL(SHA256(verifier)) —— S256（FR-ACC-02 要求 PKCE） */
export async function createPkcePair(verifier?: string): Promise<PkcePair> {
  const codeVerifier = verifier ?? createCodeVerifier();
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return {
    verifier: codeVerifier,
    challenge: base64UrlEncode(new Uint8Array(digest)),
    method: 'S256',
  };
}

/** 生成 state（防 CSRF，回调必须校验一致） */
export function createState(): string {
  return createCodeVerifier(32);
}
