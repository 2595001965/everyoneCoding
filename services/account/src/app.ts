/**
 * 应用装配：创建 Fastify 实例、注入依赖、注册中间件与路由。
 * 测试通过 buildApp 配合 app.inject() 运行（不占用端口）。
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import './context.ts';
import type { AppConfig } from './config.ts';
import { openDatabase, runMigrations } from './db.ts';
import { AccountDb } from './models/account.ts';
import { registerErrorHandlers } from './middleware/error.ts';
import { registerRateLimit } from './middleware/rate-limit.ts';
import { registerIdempotency } from './middleware/idempotency.ts';
import { authRoutes } from './routes/auth.ts';
import { usageRoutes } from './routes/usage.ts';
import { releaseRoutes } from './routes/release.ts';

export async function buildApp(config: AppConfig, db?: Database): Promise<FastifyInstance> {
  const database = db ?? openDatabase(config.dbPath);
  runMigrations(database);
  const accountDb = new AccountDb(database);

  const app = Fastify({ logger: false, trustProxy: true });
  app.decorate('accountDb', accountDb);
  app.decorate('appConfig', config);

  registerErrorHandlers(app);
  registerRateLimit(app);
  registerIdempotency(app);

  await app.register(authRoutes);
  await app.register(usageRoutes);
  await app.register(releaseRoutes);

  await app.ready();
  return app;
}
