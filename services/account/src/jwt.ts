/**
 * 轻量 JWT：HMAC-SHA256，手写不引入 jsonwebtoken。
 * 仅支持单段签名（HS256）。
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export type TokenType = 'access' | 'refresh';

export interface JwtPayload {
  sub: string;
  type: TokenType;
  jti: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

export function signJwt(payload: JwtPayload, secret: string): string {
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson(payload);
  const data = `${header}.${body}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = parts[0];
  const body = parts[1];
  const sig = parts[2];
  if (!header || !body || !sig) return null;
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let decoded: JwtPayload;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtPayload;
  } catch {
    return null;
  }
  if (typeof decoded.exp !== 'number' || decoded.exp * 1000 < Date.now()) return null;
  return decoded;
}

/** PKCE：由 code_verifier 计算 S256 code_challenge */
export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}
