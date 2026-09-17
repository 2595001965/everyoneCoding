/**
 * 令牌签发与鉴权辅助。
 * access 短时效（默认 15 分钟），refresh 轮换（旧 refresh 使用一次后即失效）。
 */
import { randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AccountDb } from './models/account.ts';
import type { AppConfig } from './config.ts';
import { AppError, ErrCode } from './errors.ts';
import { signJwt, verifyJwt } from './jwt.ts';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function issueTokens(db: AccountDb, config: AppConfig, userId: string): TokenPair {
  const nowSec = Math.floor(Date.now() / 1000);
  const accessExp = nowSec + config.accessTokenTtlSec;
  const refreshExp = nowSec + config.refreshTokenTtlSec;
  const accessJti = randomUUID();
  const refreshJti = randomUUID();
  const accessToken = signJwt(
    { sub: userId, type: 'access', jti: accessJti, iat: nowSec, exp: accessExp },
    config.jwtSecret,
  );
  const refreshToken = signJwt(
    { sub: userId, type: 'refresh', jti: refreshJti, iat: nowSec, exp: refreshExp },
    config.jwtSecret,
  );
  db.createRefreshToken(userId, refreshJti, refreshExp * 1000);
  return { accessToken, refreshToken, expiresIn: config.accessTokenTtlSec };
}

/** 校验 refresh 令牌：成功返回 userId，并就地吊销该 refresh（轮换）。 */
export function rotateRefreshToken(
  db: AccountDb,
  config: AppConfig,
  refreshToken: string,
): { userId: string } {
  const payload = verifyJwt(refreshToken, config.jwtSecret);
  if (!payload || payload.type !== 'refresh') {
    throw new AppError(ErrCode.UNAUTHORIZED, '刷新令牌无效', 401);
  }
  const record = db.getRefreshToken(payload.jti);
  if (!record || record.revoked === 1 || record.expires_at * 1000 < Date.now()) {
    throw new AppError(ErrCode.UNAUTHORIZED, '刷新令牌已失效', 401);
  }
  db.revokeRefreshToken(payload.jti);
  return { userId: payload.sub };
}

/** 受保护接口的鉴权前置：解析 Bearer access token，写入 req.user。 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new AppError(ErrCode.UNAUTHORIZED, '缺少访问令牌', 401);
  }
  const token = header.slice('Bearer '.length);
  const config = req.server.appConfig;
  const verified = verifyJwt(token, config.jwtSecret);
  if (!verified || verified.type !== 'access') {
    throw new AppError(ErrCode.UNAUTHORIZED, '访问令牌无效或已过期', 401);
  }
  req.user = { userId: verified.sub };
}
