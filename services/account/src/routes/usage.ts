/**
 * 用量上报路由：匿名用量上报，需授权（Bearer）。仅记录聚合/匿名信息，不含内容。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ErrCode } from '../errors.ts';
import { requireAuth } from '../auth-tokens.ts';
import { writeAudit } from '../logger.ts';

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  const db = app.accountDb;

  app.post('/api/usage/report', { preHandler: requireAuth }, async (req, reply) => {
    const schema = z.object({
      events: z.array(z.record(z.unknown())).max(200).optional(),
      client: z.string().max(64).optional(),
      version: z.string().max(32).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrCode.BAD_REQUEST, '请求参数校验失败', 400);
    }
    const userId = req.user!.userId;
    const payload = JSON.stringify({
      client: parsed.data.client ?? 'unknown',
      version: parsed.data.version ?? 'unknown',
      eventCount: parsed.data.events?.length ?? 0,
    });
    db.insertUsage(userId, payload);
    writeAudit(db.raw, 'usage.report', `用户=${userId.slice(0, 4)}*** 匿名上报`); // 仅记用户前缀，不记内容
    return reply.code(202).send({ accepted: true });
  });
}
