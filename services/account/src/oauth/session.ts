/**
 * OAuth state 暂存（内存）。authorize 时写入 code_challenge，callback 时校验并消费。
 * 单实例最小实现；多实例部署应改用共享存储。
 */
import { randomUUID } from 'node:crypto';
import type { OAuthProvider } from './index.ts';

interface OAuthState {
  provider: OAuthProvider;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

const states = new Map<string, OAuthState>();

export function createOAuthState(
  provider: OAuthProvider,
  codeChallenge: string,
  redirectUri: string,
  ttlSec: number,
): string {
  const state = randomUUID();
  states.set(state, {
    provider,
    codeChallenge,
    redirectUri,
    expiresAt: Date.now() + ttlSec * 1000,
  });
  return state;
}

export function consumeOAuthState(state: string): OAuthState | null {
  const s = states.get(state);
  if (!s) return null;
  states.delete(state);
  if (s.expiresAt < Date.now()) return null;
  return s;
}
