import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db.ts';
import { PlatformCatalogDb } from '../models/platform-catalog.ts';
import { WalletLedger } from '../models/wallet-ledger.ts';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(now = Date.now()): string {
  let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  let result = '';
  for (let index = 0; index < 26; index += 1) {
    result = (ULID_ALPHABET[Number(value & 31n)] ?? '0') + result;
    value >>= 5n;
  }
  return result;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of request) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString('utf8');
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error(message);
}

describe('V2-D12 trusted platform gateway', () => {
  let root = '';
  let database: Database;
  let app: FastifyInstance;
  let serviceUrl = '';
  let upstream: Server;
  let upstreamUrl = '';
  let upstreamMode: 'success' | 'hang' | 'reject' | 'unknown_usage' = 'success';
  let upstreamCalls = 0;
  let upstreamAuthorization: string | undefined;
  let upstreamModel: string | undefined;
  let hangStarted = deferred();
  let hangingResponse: ServerResponse | null = null;
  let upstreamResponseClosed = false;
  let previousCredential: string | undefined;
  let secretName = '';
  let ledger: WalletLedger;
  let providerId = '';
  let modelId = '';
  let priceVersionId = '';
  let testAccount: { accountId: string; token: string };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'everyone-coding-gateway-'));
    const dbPath = join(root, 'account.sqlite');
    database = openDatabase(dbPath);
    previousCredential = process.env['EC_TEST_PLATFORM_UPSTREAM_KEY'];
    process.env['EC_TEST_PLATFORM_UPSTREAM_KEY'] = 'controlled-upstream-secret';
    secretName = `EC_TEST_PLATFORM_UPSTREAM_KEY`;
    upstreamCalls = 0;
    upstreamAuthorization = undefined;
    upstreamModel = undefined;
    upstreamMode = 'success';
    hangStarted = deferred();
    hangingResponse = null;
    upstreamResponseClosed = false;

    upstream = createServer(async (request, reply) => {
      const body = await readBody(request);
      upstreamCalls += 1;
      upstreamAuthorization = request.headers.authorization;
      try {
        upstreamModel = (JSON.parse(body) as { model?: string }).model;
      } catch {
        upstreamModel = undefined;
      }
      if (upstreamMode === 'reject') {
        reply.writeHead(400, { 'content-type': 'application/json' });
        reply.end('{"error":{"message":"fixture rejection"}}');
        return;
      }
      reply.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.write('data: {"id":"fixture","choices":[{"delta":{"content":"controlled"}}]}\n\n');
      if (upstreamMode === 'hang') {
        hangingResponse = reply;
        reply.once('close', () => {
          upstreamResponseClosed = true;
        });
        hangStarted.resolve();
        return;
      }
      const usage =
        upstreamMode === 'unknown_usage'
          ? '"usage":{"prompt_tokens":6,"completion_tokens":2}'
          : '"usage":{"prompt_tokens":6,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":0}}';
      reply.write(
        `data: {"id":"fixture","choices":[{"delta":{},"finish_reason":"stop"}],${usage}}\n\n`,
      );
      reply.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}/v1`;

    app = await buildApp(
      loadConfig({
        dbPath,
        platformSecretDir: join(root, 'platform-secrets'),
        gatewayAllowLoopbackUpstreams: true,
        billingAttemptLeaseMs: 5_000,
        billingReconciliationSlaMs: 60_000,
      }),
      database,
    );
    serviceUrl = await app.listen({ port: 0, host: '127.0.0.1' });

    const account = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: `${randomUUID()}@example.test`, password: 'Abcd1234' },
    });
    expect(account.statusCode).toBe(201);
    const registered = account.json() as {
      identity: { accountId: string };
      tokens: { accessToken: string };
    };
    testAccount = {
      accountId: registered.identity.accountId,
      token: registered.tokens.accessToken,
    };

    const catalog = new PlatformCatalogDb(database);
    const provider = catalog.createProvider({
      displayName: 'Controlled gateway fixture',
      protocol: 'openai',
      baseUrl: upstreamUrl,
      credentialRef: `env:${secretName}`,
      status: 'active',
      statusReason: null,
    });
    providerId = String(provider['providerId']);
    const model = catalog.createModel(providerId, {
      upstreamModelName: 'fixture-upstream-model',
      displayName: 'Fixture model',
      canonicalVendor: null,
      canonicalModel: null,
      contextWindowTokens: 100_000,
      contextWindowSource: 'measured',
      capabilities: ['tools'],
      status: 'active',
    });
    modelId = String(model?.['modelId']);
    const price = catalog.publishPrice(providerId, modelId, {
      currency: 'USD',
      rates: {
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        cacheWriteByTtl: {},
        output: 2_000_000,
      },
      sourceUrl: null,
      verifiedAt: null,
      effectiveFrom: 0,
    });
    priceVersionId = String(price?.priceVersionId);

    ledger = new WalletLedger(database, { attemptLeaseMs: 5_000 });
    ledger.adjustWallet({
      accountId: testAccount.accountId,
      currency: 'USD',
      amountMicros: 1_000_000,
      reason: 'Controlled D12 integration fixture credit',
      idempotencyKey: `credit-${randomUUID()}`,
      actorAccountId: testAccount.accountId,
    });
  });

  afterEach(async () => {
    if (hangingResponse && !hangingResponse.writableEnded) hangingResponse.destroy();
    if (app) await app.close();
    await closeServer(upstream);
    if (database?.open) database.close();
    if (previousCredential === undefined) delete process.env['EC_TEST_PLATFORM_UPSTREAM_KEY'];
    else process.env['EC_TEST_PLATFORM_UPSTREAM_KEY'] = previousCredential;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function account(): { accountId: string; token: string } {
    return testAccount;
  }

  function payload(content = 'private controlled request text'): Record<string, unknown> {
    return {
      model: `${providerId}/${modelId}`,
      messages: [{ role: 'user', content }],
      maxTokens: 32,
    };
  }

  async function startRequest(
    idempotencyKey: string,
    logicalRequestId: string,
    options: { content?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    return fetch(`${serviceUrl}/api/ai/requests`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${account().token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'idempotency-key': idempotencyKey,
        'x-ec-logical-request-id': logicalRequestId,
      },
      body: JSON.stringify(payload(options.content)),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async function getAttempt(attemptId: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${serviceUrl}/api/ai/requests/${attemptId}`, {
      headers: { authorization: `Bearer ${account().token}` },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it('streams through the D10 route, reserves and settles D11 usage, and never replays a charge', async () => {
    const key = ulid();
    const logicalRequestId = `logical-${randomUUID()}`;
    const response = await startRequest(key, logicalRequestId);
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('event: request.accepted');
    expect(stream).toContain('event: output.delta');
    expect(stream).toContain('controlled');
    expect(stream).toContain('event: bill.settled');
    expect(stream).toContain('event: request.completed');
    expect(upstreamCalls).toBe(1);
    expect(upstreamAuthorization).toBe('Bearer controlled-upstream-secret');
    expect(upstreamModel).toBe('fixture-upstream-model');

    const attemptResult = await getAttempt(key);
    const attempt = attemptResult['request'] as Record<string, unknown>;
    expect(attempt).toMatchObject({
      attemptId: key,
      logicalRequestId,
      providerModelKey: `${providerId}/${modelId}`,
      priceVersionId,
      status: 'settled',
      dispatchState: 'dispatched',
      finalMicros: 10,
    });
    const wallet = ledger.getWallet(account().accountId, 'USD');
    expect(wallet.heldMicros).toBe(0);
    expect(wallet.postedMicros).toBe(999_990);

    const replay = await startRequest(key, logicalRequestId);
    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain('REQUEST_ALREADY_PROCESSED');
    expect(upstreamCalls).toBe(1);
    const changedBody = await startRequest(key, logicalRequestId, { content: 'changed request' });
    expect(changedBody.status).toBe(409);
    expect(upstreamCalls).toBe(1);

    const persisted = database
      .prepare('SELECT request_fingerprint FROM billing_attempt WHERE attempt_id = ?')
      .get(key) as { request_fingerprint: string };
    expect(persisted.request_fingerprint).not.toContain('private controlled request text');
  });

  it('explicit cancellation after dispatch aborts upstream, retains the hold for reconciliation, and blocks replay', async () => {
    upstreamMode = 'hang';
    const key = ulid();
    const logicalRequestId = `logical-${randomUUID()}`;
    const response = await startRequest(key, logicalRequestId);
    expect(response.status).toBe(200);
    await hangStarted.promise;

    const cancelled = await fetch(`${serviceUrl}/api/ai/requests/${key}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${account().token}` },
    });
    expect(cancelled.status).toBe(200);
    const current = await getAttempt(key);
    expect((current['request'] as Record<string, unknown>)['status']).toBe(
      'unknown_pending_reconciliation',
    );
    expect(ledger.getWallet(account().accountId, 'USD').heldMicros).toBeGreaterThan(0);

    await response.text();
    await waitFor(() => upstreamResponseClosed, 'gateway did not abort upstream');
    const replay = await startRequest(key, logicalRequestId);
    expect(replay.status).toBe(409);
    expect(upstreamCalls).toBe(1);
  });

  it('client disconnect marks execution unknown and prevents another upstream charge', async () => {
    upstreamMode = 'hang';
    const key = ulid();
    const logicalRequestId = `logical-${randomUUID()}`;
    const controller = new AbortController();
    const response = await startRequest(key, logicalRequestId, { signal: controller.signal });
    expect(response.status).toBe(200);
    await hangStarted.promise;
    controller.abort();
    await waitFor(
      () =>
        ledger.getAttempt(account().accountId, key)?.status === 'unknown_pending_reconciliation',
      'disconnected request was not marked unknown',
    );
    expect(ledger.getWallet(account().accountId, 'USD').heldMicros).toBeGreaterThan(0);
    const replay = await startRequest(key, logicalRequestId);
    expect(replay.status).toBe(409);
    expect(upstreamCalls).toBe(1);
  });

  it('a definite upstream rejection releases its reservation without charging', async () => {
    upstreamMode = 'reject';
    const key = ulid();
    const response = await startRequest(key, `logical-${randomUUID()}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: request.failed');
    const result = await getAttempt(key);
    expect((result['request'] as Record<string, unknown>)['status']).toBe('released');
    expect(ledger.getWallet(account().accountId, 'USD').heldMicros).toBe(0);
    expect(ledger.getWallet(account().accountId, 'USD').postedMicros).toBe(1_000_000);
  });

  it('missing trusted usage dimensions keeps the reservation pending reconciliation', async () => {
    upstreamMode = 'unknown_usage';
    const key = ulid();
    const response = await startRequest(key, `logical-${randomUUID()}`);
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"billingStatus":"unknown_pending_reconciliation"');
    const current = await getAttempt(key);
    expect((current['request'] as Record<string, unknown>)['status']).toBe(
      'unknown_pending_reconciliation',
    );
    expect(ledger.getWallet(account().accountId, 'USD').heldMicros).toBeGreaterThan(0);
    expect(ledger.getWallet(account().accountId, 'USD').postedMicros).toBe(1_000_000);
  });

  it('disabled catalog routes and private upstream destinations fail before reservation or dispatch', async () => {
    const catalog = new PlatformCatalogDb(database);
    const key = ulid();
    catalog.updateProvider(providerId, { status: 'maintenance' });
    const disabled = await startRequest(key, `logical-${randomUUID()}`);
    expect(disabled.status).toBe(409);
    expect(upstreamCalls).toBe(0);
    expect(ledger.getAttempt(account().accountId, key)).toBeNull();

    catalog.updateProvider(providerId, { status: 'active' });
    catalog.updateProvider(providerId, { baseUrl: 'https://169.254.169.254/latest/meta-data' });
    const blocked = await startRequest(ulid(), `logical-${randomUUID()}`);
    expect(blocked.status).toBe(403);
    expect(upstreamCalls).toBe(0);
    expect(ledger.getWallet(account().accountId, 'USD').heldMicros).toBe(0);
  });
});
