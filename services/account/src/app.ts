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
import { verifyPageRoutes } from './routes/verify-page.ts';
import { usageRoutes } from './routes/usage.ts';
import { releaseRoutes } from './routes/release.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { walletRoutes } from './routes/wallet.ts';
import { aiGatewayRoutes } from './routes/ai-gateway.ts';
import { adminRoutes } from './routes/admin.ts';
import { WalletLedger } from './models/wallet-ledger.ts';

export async function buildApp(config: AppConfig, db?: Database): Promise<FastifyInstance> {
  const database = db ?? openDatabase(config.dbPath);
  runMigrations(database);
  const accountDb = new AccountDb(database);
  const walletLedger = new WalletLedger(database, {
    attemptLeaseMs: config.billingAttemptLeaseMs,
    reconciliationSlaMs: config.billingReconciliationSlaMs,
  });
  walletLedger.recoverExpiredAttempts();

  // Only the immediately adjacent reverse proxy may supply forwarded headers.
  // Deployments with multiple trusted proxies should terminate the chain at one local proxy.
  const app = Fastify({ logger: false, trustProxy: 'loopback,linklocal,uniquelocal' });
  app.decorate('accountDb', accountDb);
  app.decorate('appConfig', config);
  app.decorate('walletLedger', walletLedger);

  registerErrorHandlers(app);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (config.requireHttps && request.protocol !== 'https') {
      return reply.code(426).send({
        code: 'HTTPS_REQUIRED',
        message: '此服务要求通过 HTTPS 访问',
        traceId: request.traceId,
      });
    }
  });
  registerRateLimit(app);
  registerIdempotency(app);

  app.get('/health', async (_request, reply) => {
    try {
      database.prepare('SELECT 1 AS ready').get();
      return { status: 'ok', timestamp: Date.now() };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  await app.register(authRoutes);
  // 邮件验证链接的落地页（不依赖桌面端是否运行，见 verify-page.ts 头部说明）
  await app.register(verifyPageRoutes);
  await app.register(usageRoutes);
  await app.register(releaseRoutes);
  await app.register(catalogRoutes);
  await app.register(walletRoutes);
  await app.register(adminRoutes);
  await app.register((instance) =>
    aiGatewayRoutes(instance, { db: database, ledger: walletLedger, config }),
  );

  await app.ready();
  return app;
}
