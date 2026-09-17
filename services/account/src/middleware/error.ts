/**
 * 统一错误处理：兜底未捕获异常，返回 { code, message, traceId }，绝不泄漏堆栈。
 * 同时生成 traceId 供一次请求内串联日志与错误响应。
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.ts';

export function registerErrorHandlers(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    req.traceId = randomUUID();
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      code: 'NOT_FOUND',
      message: '资源不存在',
      traceId: req.traceId ?? randomUUID(),
    });
  });

  app.setErrorHandler((err, req, reply) => {
    const traceId = req.traceId ?? randomUUID();
    if (err instanceof AppError) {
      reply.code(err.statusCode).send({ code: err.code, message: err.message, traceId });
      return;
    }
    const e = err as { statusCode?: number; validation?: unknown; message?: string };
    const statusCode = e.statusCode ?? 500;
    if (statusCode === 400 && Array.isArray(e.validation)) {
      reply.code(400).send({
        code: 'BAD_REQUEST',
        message: '请求参数校验失败',
        traceId,
      });
      return;
    }
    if (statusCode >= 500) {
      // 生产环境不向客户端透出内部错误细节
      reply.code(500).send({
        code: 'INTERNAL',
        message: '服务器内部错误',
        traceId,
      });
      return;
    }
    reply.code(statusCode).send({
      code: 'BAD_REQUEST',
      message: e.message || '请求处理失败',
      traceId,
    });
  });
}
