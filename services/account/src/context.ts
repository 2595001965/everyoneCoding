/**
 * Fastify 实例/请求扩展的类型声明（模块增强）。
 * 通过装饰器注入 accountDb、appConfig；请求上附带 traceId、鉴权用户与幂等键上下文。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccountDb } from './models/account.ts';
import type { AppConfig } from './config.ts';

declare module 'fastify' {
  interface FastifyInstance {
    accountDb: AccountDb;
    appConfig: AppConfig;
  }
  interface FastifyRequest {
    traceId: string;
    user?: { userId: string };
    idempotencyComposite?: string;
    idempotencyReplay?: boolean;
  }
}

export type { FastifyInstance, FastifyRequest };
