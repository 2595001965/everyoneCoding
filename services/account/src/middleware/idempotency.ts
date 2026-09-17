/**
 * 幂等键中间件：所有写接口支持 Idempotency-Key 头。
 * 同一 (方法:路径:幂等键) 的重复请求，直接返回首次响应（落库记录 key → 响应）。
 */
import type { FastifyInstance } from 'fastify';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerIdempotency(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const method = req.method;
    if (!MUTATING.has(method)) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) return;

    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0] ?? '/';
    const composite = `${method}:${path}:${key}`;
    req.idempotencyComposite = composite;

    const record = app.accountDb.getIdempotency(composite);
    if (record) {
      const ageMs = Date.now() - record.created_at;
      if (ageMs < app.appConfig.idempotencyTtlSec * 1000) {
        req.idempotencyReplay = true;
        reply.header('Idempotency-Key-Replay', 'true');
        reply.header('content-type', 'application/json');
        return reply.code(record.status_code).send(record.response_body);
      }
      // 已过期则忽略旧记录，重新处理
      app.accountDb.saveIdempotency(composite, 0, '');
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const composite = req.idempotencyComposite;
    if (!composite) return payload;
    if (req.idempotencyReplay) return payload;
    if (reply.statusCode >= 500) return payload; // 服务端错误不缓存
    let body = '';
    if (typeof payload === 'string') body = payload;
    else if (Buffer.isBuffer(payload)) body = payload.toString('utf8');
    else body = JSON.stringify(payload);
    app.accountDb.saveIdempotency(composite, reply.statusCode, body);
    return payload;
  });
}
