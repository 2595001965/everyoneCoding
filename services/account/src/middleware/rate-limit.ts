/**
 * 简易限流：内存令牌桶。登录/注册接口每 IP 每分钟限制次数（可配置）。
 * 生产环境应替换为 Redis 等共享存储；此处满足最小实现与测试触发 429 的需求。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ErrCode } from '../errors.ts';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

function allow(key: string, limitPerMin: number): boolean {
  const now = Date.now();
  const refillPerMs = limitPerMin / 60_000;
  const existing = buckets.get(key);
  if (!existing) {
    buckets.set(key, { tokens: limitPerMin - 1, updatedAt: now });
    return true;
  }
  existing.tokens = Math.min(
    limitPerMin,
    existing.tokens + (now - existing.updatedAt) * refillPerMs,
  );
  existing.updatedAt = now;
  if (existing.tokens >= 1) {
    existing.tokens -= 1;
    return true;
  }
  return false;
}

function clientIp(req: FastifyRequest): string {
  return req.ip ?? 'unknown';
}

export function registerRateLimit(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    const url = req.url ?? '';
    const path = url.split('?')[0] ?? '';
    let limit = 0;
    if (path === '/api/auth/login') limit = app.appConfig.loginRateLimitPerMin;
    else if (path === '/api/auth/register') limit = app.appConfig.registerRateLimitPerMin;
    if (limit <= 0) return;

    const ip = clientIp(req);
    const key = `${ip}:${path}`;
    if (!allow(key, limit)) {
      throw new AppError(ErrCode.RATE_LIMITED, '请求过于频繁，请稍后重试', 429);
    }
  });
}
