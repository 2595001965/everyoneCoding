/** 平台目录与价格版本的 SQLite 存储。价格和官网证据只追加，不更新/删除。 */
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  platformCatalogSnapshotSchema,
  providerModelKeyOf,
  type CatalogModel,
  type CatalogProvider,
  type OfficialPriceSnapshot,
  type PlatformCatalogSnapshot,
  type PriceRates,
  type PriceVersion,
  type ProviderProtocol,
  type ProvenanceKind,
} from '@ec/core';

export type PlatformProviderStatus = 'active' | 'maintenance' | 'disabled';
export type PlatformModelStatus = 'active' | 'disabled';

export interface ProviderWrite {
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  credentialRef: string | null;
  status: PlatformProviderStatus;
  statusReason: string | null;
}

export interface ModelWrite {
  upstreamModelName: string;
  displayName: string;
  canonicalVendor: string | null;
  canonicalModel: string | null;
  contextWindowTokens: number | null;
  contextWindowSource: ProvenanceKind | null;
  capabilities: string[] | null;
  status: PlatformModelStatus;
}

export interface PriceWrite {
  currency: string;
  rates: PriceRates;
  sourceUrl: string | null;
  verifiedAt: number | null;
  effectiveFrom: number;
}

export interface OfficialPriceWrite {
  canonicalVendor: string;
  canonicalModel: string;
  currency: string;
  rates: PriceRates;
  sourceUrl: string;
  verifiedAt: number;
  evidenceVersion: string;
  evidenceSnapshot: string;
  conditions: string;
  effectiveFrom: number;
}

/** Internal gateway routing view. Never serialize this value to a client. */
export interface PlatformGatewayRoute {
  providerId: string;
  providerDisplayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  credentialRef: string;
  modelId: string;
  upstreamModelName: string;
  modelDisplayName: string;
  contextWindowTokens: number | null;
  priceVersionId: string;
  priceVersion: PriceVersion;
}

interface ProviderRow {
  provider_id: string;
  display_name: string;
  protocol: ProviderProtocol;
  base_url: string;
  credential_ref: string | null;
  credential_rotated_at: number | null;
  status: PlatformProviderStatus;
  status_reason: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface ModelRow {
  model_id: string;
  provider_id: string;
  upstream_model_name: string;
  display_name: string;
  canonical_vendor: string | null;
  canonical_model: string | null;
  context_window_tokens: number | null;
  context_window_source: ProvenanceKind | null;
  capabilities_json: string | null;
  status: PlatformModelStatus;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface PriceRow {
  price_version_id: string;
  provider_id: string;
  model_id: string;
  provider_model_key: string;
  billing_mode: 'per_million_tokens';
  currency: string;
  rates_json: string;
  cache_write_rate_semantics: 'full_rate';
  source_json: string;
  effective_from: number;
  published_at: number;
  version: number;
}

interface OfficialPriceRow {
  snapshot_id: string;
  canonical_vendor: string;
  canonical_model: string;
  billing_mode: 'per_million_tokens';
  currency: string;
  rates_json: string;
  source_url: string;
  verified_at: number;
  evidence_version: string;
  evidence_sha256: string;
  evidence_snapshot: string;
  conditions: string;
  effective_from: number;
  published_at: number;
  version: number;
  verified_by: string;
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID-compatible, cryptographically random IDs for public directory/price entities. */
function newUlid(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError('ULID timestamp is out of range');
  }
  const entropy = randomBytes(10);
  let value = (BigInt(now) << 80n) | BigInt(`0x${entropy.toString('hex')}`);
  let out = '';
  for (let i = 0; i < 26; i += 1) {
    out = ULID_ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

function json<T>(value: string): T {
  return JSON.parse(value) as T;
}

function providerAdminView(row: ProviderRow): Record<string, unknown> {
  return {
    providerId: row.provider_id,
    displayName: row.display_name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    status: row.status,
    statusReason: row.status_reason,
    credentialConfigured: row.credential_ref !== null,
    credentialRotatedAt: row.credential_rotated_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function modelAdminView(row: ModelRow): Record<string, unknown> {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    upstreamModelName: row.upstream_model_name,
    displayName: row.display_name,
    canonicalVendor: row.canonical_vendor,
    canonicalModel: row.canonical_model,
    contextWindowTokens: row.context_window_tokens,
    contextWindowSource: row.context_window_source,
    capabilities: row.capabilities_json === null ? null : json<string[]>(row.capabilities_json),
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PlatformCatalogDb {
  constructor(private readonly db: Database) {}

  private provider(providerId: string): ProviderRow | null {
    return (
      (this.db.prepare('SELECT * FROM platform_provider WHERE provider_id = ?').get(providerId) as
        ProviderRow | undefined) ?? null
    );
  }

  private model(providerId: string, modelId: string): ModelRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM platform_model WHERE provider_id = ? AND model_id = ?')
        .get(providerId, modelId) as ModelRow | undefined) ?? null
    );
  }

  hasModel(providerId: string, modelId: string): boolean {
    return this.model(providerId, modelId) !== null;
  }

  listAdminProviders(): Record<string, unknown>[] {
    const rows = this.db
      .prepare('SELECT * FROM platform_provider ORDER BY created_at, provider_id')
      .all() as ProviderRow[];
    return rows.map(providerAdminView);
  }

  createProvider(input: ProviderWrite, now = Date.now()): Record<string, unknown> {
    const providerId = newUlid(now);
    this.db
      .prepare(
        `INSERT INTO platform_provider
          (provider_id, display_name, protocol, base_url, credential_ref, credential_rotated_at,
           status, status_reason, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        providerId,
        input.displayName,
        input.protocol,
        input.baseUrl,
        input.credentialRef,
        input.credentialRef === null ? null : now,
        input.status,
        input.statusReason,
        now,
        now,
      );
    return providerAdminView(this.provider(providerId)!);
  }

  updateProvider(
    providerId: string,
    patch: Partial<ProviderWrite>,
    now = Date.now(),
  ): Record<string, unknown> | null {
    const current = this.provider(providerId);
    if (!current) return null;
    const next: ProviderRow = {
      ...current,
      display_name: patch.displayName ?? current.display_name,
      protocol: patch.protocol ?? current.protocol,
      base_url: patch.baseUrl ?? current.base_url,
      credential_ref:
        patch.credentialRef === undefined ? current.credential_ref : patch.credentialRef,
      credential_rotated_at:
        patch.credentialRef === undefined
          ? current.credential_rotated_at
          : patch.credentialRef === null
            ? null
            : now,
      status: patch.status ?? current.status,
      status_reason: patch.statusReason === undefined ? current.status_reason : patch.statusReason,
      revision: current.revision + 1,
      updated_at: now,
    };
    if (next.status === 'active' && next.credential_ref === null) {
      throw new Error('启用 Provider 前必须配置服务端密钥引用');
    }
    this.db
      .prepare(
        `UPDATE platform_provider SET display_name = ?, protocol = ?, base_url = ?,
          credential_ref = ?, credential_rotated_at = ?, status = ?, status_reason = ?,
          revision = ?, updated_at = ? WHERE provider_id = ?`,
      )
      .run(
        next.display_name,
        next.protocol,
        next.base_url,
        next.credential_ref,
        next.credential_rotated_at,
        next.status,
        next.status_reason,
        next.revision,
        now,
        providerId,
      );
    return providerAdminView(next);
  }

  listAdminModels(providerId?: string): Record<string, unknown>[] {
    const rows = (
      providerId === undefined
        ? this.db
            .prepare('SELECT * FROM platform_model ORDER BY provider_id, created_at, model_id')
            .all()
        : this.db
            .prepare(
              'SELECT * FROM platform_model WHERE provider_id = ? ORDER BY created_at, model_id',
            )
            .all(providerId)
    ) as ModelRow[];
    return rows.map(modelAdminView);
  }

  createModel(
    providerId: string,
    input: ModelWrite,
    now = Date.now(),
  ): Record<string, unknown> | null {
    const provider = this.provider(providerId);
    if (!provider) return null;
    const modelId = newUlid(now);
    this.db
      .prepare(
        `INSERT INTO platform_model
          (model_id, provider_id, upstream_model_name, display_name, canonical_vendor, canonical_model,
           context_window_tokens, context_window_source, capabilities_json, status, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        modelId,
        providerId,
        input.upstreamModelName,
        input.displayName,
        input.canonicalVendor,
        input.canonicalModel,
        input.contextWindowTokens,
        input.contextWindowSource,
        input.capabilities === null ? null : JSON.stringify(input.capabilities),
        input.status,
        now,
        now,
      );
    return modelAdminView(this.model(providerId, modelId)!);
  }

  updateModel(
    providerId: string,
    modelId: string,
    patch: Partial<ModelWrite>,
    now = Date.now(),
  ): Record<string, unknown> | null {
    const current = this.model(providerId, modelId);
    if (!current) return null;
    const next: ModelRow = {
      ...current,
      upstream_model_name: patch.upstreamModelName ?? current.upstream_model_name,
      display_name: patch.displayName ?? current.display_name,
      canonical_vendor:
        patch.canonicalVendor === undefined ? current.canonical_vendor : patch.canonicalVendor,
      canonical_model:
        patch.canonicalModel === undefined ? current.canonical_model : patch.canonicalModel,
      context_window_tokens:
        patch.contextWindowTokens === undefined
          ? current.context_window_tokens
          : patch.contextWindowTokens,
      context_window_source:
        patch.contextWindowSource === undefined
          ? current.context_window_source
          : patch.contextWindowSource,
      capabilities_json:
        patch.capabilities === undefined
          ? current.capabilities_json
          : patch.capabilities === null
            ? null
            : JSON.stringify(patch.capabilities),
      status: patch.status ?? current.status,
      revision: current.revision + 1,
      updated_at: now,
    };
    this.db
      .prepare(
        `UPDATE platform_model SET upstream_model_name = ?, display_name = ?, canonical_vendor = ?,
          canonical_model = ?, context_window_tokens = ?, context_window_source = ?, capabilities_json = ?,
          status = ?, revision = ?, updated_at = ? WHERE provider_id = ? AND model_id = ?`,
      )
      .run(
        next.upstream_model_name,
        next.display_name,
        next.canonical_vendor,
        next.canonical_model,
        next.context_window_tokens,
        next.context_window_source,
        next.capabilities_json,
        next.status,
        next.revision,
        now,
        providerId,
        modelId,
      );
    return modelAdminView(this.model(providerId, modelId)!);
  }

  private priceRows(providerModelKey: string): PriceRow[] {
    return this.db
      .prepare(
        'SELECT * FROM platform_price_version WHERE provider_model_key = ? ORDER BY effective_from, version',
      )
      .all(providerModelKey) as PriceRow[];
  }

  private priceView(row: PriceRow, effectiveTo: number | null): PriceVersion {
    return {
      priceVersionId: row.price_version_id,
      providerModelKey: row.provider_model_key,
      billingMode: row.billing_mode,
      currency: row.currency,
      rates: json<PriceRates>(row.rates_json),
      cacheWriteRateSemantics: row.cache_write_rate_semantics,
      source: json<PriceVersion['source']>(row.source_json),
      effectiveFrom: row.effective_from,
      effectiveTo,
      publishedAt: row.published_at,
      version: row.version,
    };
  }

  listPrices(providerId: string, modelId: string): PriceVersion[] {
    const key = providerModelKeyOf({ providerId, modelId });
    const rows = this.priceRows(key);
    return rows.map((row, index) => this.priceView(row, rows[index + 1]?.effective_from ?? null));
  }

  getPriceAt(providerId: string, modelId: string, at: number): PriceVersion | null {
    const prices = this.listPrices(providerId, modelId);
    return (
      prices.find(
        (price) =>
          price.effectiveFrom <= at && (price.effectiveTo === null || at < price.effectiveTo),
      ) ?? null
    );
  }

  private getGatewayPrice(providerId: string, modelId: string, at: number): PriceVersion | null {
    const published = this.getPriceAt(providerId, modelId, at);
    if (published) return published;
    const official = this.db
      .prepare(
        `SELECT o.*
         FROM platform_official_price_snapshot o
         JOIN platform_model m
           ON m.canonical_vendor = o.canonical_vendor AND m.canonical_model = o.canonical_model
         JOIN platform_provider p ON p.provider_id = m.provider_id
         WHERE m.provider_id = ? AND m.model_id = ?
           AND p.status = 'active' AND m.status = 'active'
           AND o.effective_from <= ?
           AND NOT EXISTS (
             SELECT 1 FROM platform_official_price_snapshot next
             WHERE next.canonical_vendor = o.canonical_vendor
               AND next.canonical_model = o.canonical_model
               AND next.effective_from > o.effective_from AND next.effective_from <= ?
           )
         ORDER BY o.effective_from DESC, o.version DESC LIMIT 1`,
      )
      .get(providerId, modelId, at, at) as OfficialPriceRow | undefined;
    if (!official) return null;
    const next = this.db
      .prepare(
        `SELECT MIN(effective_from) AS next_from FROM platform_official_price_snapshot
         WHERE canonical_vendor = ? AND canonical_model = ? AND effective_from > ?`,
      )
      .get(official.canonical_vendor, official.canonical_model, official.effective_from) as {
      next_from: number | null;
    };
    return {
      priceVersionId: official.snapshot_id,
      providerModelKey: providerModelKeyOf({ providerId, modelId }),
      billingMode: official.billing_mode,
      currency: official.currency,
      rates: json<PriceRates>(official.rates_json),
      cacheWriteRateSemantics: 'full_rate',
      source: {
        kind: 'official_vendor',
        evidenceUrl: official.source_url,
        verifiedAt: official.verified_at,
      },
      effectiveFrom: official.effective_from,
      effectiveTo: next.next_from,
      publishedAt: official.published_at,
      version: official.version,
    };
  }

  /** Resolve only an active, catalog-owned route with a currently billable price. */
  getGatewayRoute(
    providerId: string,
    modelId: string,
    at = Date.now(),
  ): PlatformGatewayRoute | null {
    const row = this.db
      .prepare(
        `SELECT p.provider_id, p.display_name AS provider_display_name, p.protocol,
                p.base_url, p.credential_ref, p.status AS provider_status,
                m.model_id, m.upstream_model_name, m.display_name AS model_display_name,
                m.context_window_tokens, m.status AS model_status
         FROM platform_provider p
         JOIN platform_model m ON m.provider_id = p.provider_id
         WHERE p.provider_id = ? AND m.model_id = ?`,
      )
      .get(providerId, modelId) as
      | {
          provider_id: string;
          provider_display_name: string;
          protocol: ProviderProtocol;
          base_url: string;
          credential_ref: string | null;
          provider_status: PlatformProviderStatus;
          model_status: PlatformModelStatus;
          model_id: string;
          upstream_model_name: string;
          model_display_name: string;
          context_window_tokens: number | null;
        }
      | undefined;
    if (
      !row ||
      row.provider_status !== 'active' ||
      row.model_status !== 'active' ||
      row.credential_ref === null
    )
      return null;
    const priceVersion = this.getGatewayPrice(providerId, modelId, at);
    if (priceVersion === null) return null;
    return {
      providerId: row.provider_id,
      providerDisplayName: row.provider_display_name,
      protocol: row.protocol,
      baseUrl: row.base_url,
      credentialRef: row.credential_ref,
      modelId: row.model_id,
      upstreamModelName: row.upstream_model_name,
      modelDisplayName: row.model_display_name,
      contextWindowTokens: row.context_window_tokens,
      priceVersionId: priceVersion.priceVersionId,
      priceVersion,
    };
  }

  pricePublicationIssue(
    providerId: string,
    modelId: string,
    effectiveFrom: number,
    now = Date.now(),
  ): 'not_found' | 'inactive' | 'conflict' | null {
    const provider = this.provider(providerId);
    const model = this.model(providerId, modelId);
    if (!provider || !model) return 'not_found';
    if (provider.status === 'disabled' || model.status !== 'active') return 'inactive';
    const latest = this.priceRows(providerModelKeyOf({ providerId, modelId })).at(-1);
    if (latest && (effectiveFrom <= latest.effective_from || effectiveFrom < now)) {
      return 'conflict';
    }
    return null;
  }

  publishPrice(
    providerId: string,
    modelId: string,
    input: PriceWrite,
    now = Date.now(),
  ): PriceVersion | null {
    const issue = this.pricePublicationIssue(providerId, modelId, input.effectiveFrom, now);
    if (issue === 'not_found' || issue === 'inactive') return null;
    if (issue === 'conflict') {
      throw new Error('新价格生效时间必须晚于已发布版本且不得回溯当前时间');
    }

    const key = providerModelKeyOf({ providerId, modelId });
    const rows = this.priceRows(key);
    const latest = rows.at(-1);

    const version = (latest?.version ?? 0) + 1;
    const priceVersionId = newUlid(now);
    const source = {
      kind: 'platform_published' as const,
      evidenceUrl: input.sourceUrl,
      verifiedAt: input.verifiedAt,
    };
    this.db
      .prepare(
        `INSERT INTO platform_price_version
          (price_version_id, provider_id, model_id, provider_model_key, billing_mode, currency,
           rates_json, cache_write_rate_semantics, source_json, effective_from, published_at, version)
         VALUES (?, ?, ?, ?, 'per_million_tokens', ?, ?, 'full_rate', ?, ?, ?, ?)`,
      )
      .run(
        priceVersionId,
        providerId,
        modelId,
        key,
        input.currency,
        JSON.stringify(input.rates),
        JSON.stringify(source),
        input.effectiveFrom,
        now,
        version,
      );
    return this.priceView(
      this.priceRows(key).find((row) => row.price_version_id === priceVersionId)!,
      null,
    );
  }

  listAdminOfficialPrices(): Record<string, unknown>[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM platform_official_price_snapshot
         ORDER BY canonical_vendor, canonical_model, version`,
      )
      .all() as OfficialPriceRow[];
    return rows.map((row, index) => {
      const next = rows[index + 1];
      const nextEffectiveFrom =
        next?.canonical_vendor === row.canonical_vendor &&
        next.canonical_model === row.canonical_model
          ? next.effective_from
          : null;
      return {
        ...this.officialView(row, nextEffectiveFrom),
        evidenceSnapshot: row.evidence_snapshot,
        verifiedBy: row.verified_by,
      };
    });
  }

  private officialView(row: OfficialPriceRow, effectiveTo: number | null): OfficialPriceSnapshot {
    return {
      snapshotId: row.snapshot_id,
      canonicalVendor: row.canonical_vendor,
      canonicalModel: row.canonical_model,
      billingMode: row.billing_mode,
      currency: row.currency,
      rates: json<PriceRates>(row.rates_json),
      sourceUrl: row.source_url,
      verifiedAt: row.verified_at,
      evidenceVersion: row.evidence_version,
      evidenceSha256: row.evidence_sha256,
      conditions: row.conditions,
      effectiveFrom: row.effective_from,
      effectiveTo,
      publishedAt: row.published_at,
      version: row.version,
    };
  }

  publishOfficialPrice(
    input: OfficialPriceWrite,
    verifiedBy: string,
    now = Date.now(),
  ): OfficialPriceSnapshot {
    const latest = this.db
      .prepare(
        `SELECT * FROM platform_official_price_snapshot
         WHERE canonical_vendor = ? AND canonical_model = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(input.canonicalVendor, input.canonicalModel) as OfficialPriceRow | undefined;
    if (latest && (input.effectiveFrom <= latest.effective_from || input.effectiveFrom < now)) {
      throw new Error('官网证据生效时间必须晚于已发布版本且不得回溯当前时间');
    }
    const snapshotId = newUlid(now);
    const version = (latest?.version ?? 0) + 1;
    const evidenceSha256 = createHash('sha256')
      .update(input.evidenceSnapshot, 'utf8')
      .digest('hex');
    this.db
      .prepare(
        `INSERT INTO platform_official_price_snapshot
          (snapshot_id, canonical_vendor, canonical_model, billing_mode, currency, rates_json,
           source_url, verified_at, evidence_version, evidence_sha256, evidence_snapshot,
           conditions, effective_from, published_at, version, verified_by)
         VALUES (?, ?, ?, 'per_million_tokens', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshotId,
        input.canonicalVendor,
        input.canonicalModel,
        input.currency,
        JSON.stringify(input.rates),
        input.sourceUrl,
        input.verifiedAt,
        input.evidenceVersion,
        evidenceSha256,
        input.evidenceSnapshot,
        input.conditions,
        input.effectiveFrom,
        now,
        version,
        verifiedBy,
      );
    const row = this.db
      .prepare('SELECT * FROM platform_official_price_snapshot WHERE snapshot_id = ?')
      .get(snapshotId) as OfficialPriceRow;
    return this.officialView(row, null);
  }

  buildPublicSnapshot(asOf = Date.now()): PlatformCatalogSnapshot {
    const providerRows = this.db
      .prepare(
        `SELECT * FROM platform_provider WHERE status IN ('active', 'maintenance')
         ORDER BY display_name, provider_id`,
      )
      .all() as ProviderRow[];
    const providerById = new Map(providerRows.map((row) => [row.provider_id, row]));
    const providers: CatalogProvider[] = providerRows.map((row) => ({
      providerId: row.provider_id,
      displayName: row.display_name,
      protocol: row.protocol,
      status: row.status === 'maintenance' ? 'maintenance' : 'active',
      statusReason: row.status_reason,
      updatedAt: row.updated_at,
    }));
    const modelRows = this.db
      .prepare(
        "SELECT * FROM platform_model WHERE status = 'active' ORDER BY provider_id, display_name, model_id",
      )
      .all() as ModelRow[];
    const publicModelRows = modelRows.filter((row) => providerById.has(row.provider_id));
    const models: CatalogModel[] = publicModelRows.map((row) => {
      const provider = providerById.get(row.provider_id)!;
      return {
        providerId: row.provider_id,
        modelId: row.model_id,
        providerSource: 'platform',
        displayName: row.display_name,
        protocol: provider.protocol,
        baseUrl: null,
        canonicalVendor: row.canonical_vendor,
        canonicalModel: row.canonical_model,
        contextWindowTokens: row.context_window_tokens,
        contextWindowSource: row.context_window_source,
        capabilities: row.capabilities_json === null ? null : json<string[]>(row.capabilities_json),
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        upstreamModelName: row.upstream_model_name,
      };
    });
    const routeKeys = new Set(
      models.map((model) =>
        providerModelKeyOf({ providerId: model.providerId, modelId: model.modelId }),
      ),
    );
    const allPriceRows = this.db
      .prepare(
        'SELECT * FROM platform_price_version ORDER BY provider_model_key, effective_from, version',
      )
      .all() as PriceRow[];
    const rowsByRoute = new Map<string, PriceRow[]>();
    for (const row of allPriceRows) {
      const group = rowsByRoute.get(row.provider_model_key) ?? [];
      group.push(row);
      rowsByRoute.set(row.provider_model_key, group);
    }
    const platformPrices: PriceVersion[] = [];
    for (const [routeKey, rows] of rowsByRoute) {
      if (!routeKeys.has(routeKey)) continue;
      rows.forEach((row, index) => {
        if (row.effective_from <= asOf) {
          platformPrices.push(this.priceView(row, rows[index + 1]?.effective_from ?? null));
        }
      });
    }

    const canonicalPairs = new Set(
      models
        .filter((model) => model.canonicalVendor !== null && model.canonicalModel !== null)
        .map((model) => JSON.stringify([model.canonicalVendor, model.canonicalModel])),
    );
    const allOfficial = this.db
      .prepare(
        `SELECT * FROM platform_official_price_snapshot
         ORDER BY canonical_vendor, canonical_model, effective_from, version`,
      )
      .all() as OfficialPriceRow[];
    const officialGroups = new Map<string, OfficialPriceRow[]>();
    for (const row of allOfficial) {
      const pairKey = JSON.stringify([row.canonical_vendor, row.canonical_model]);
      if (!canonicalPairs.has(pairKey)) continue;
      const group = officialGroups.get(pairKey) ?? [];
      group.push(row);
      officialGroups.set(pairKey, group);
    }
    const officialPrices: OfficialPriceSnapshot[] = [];
    for (const rows of officialGroups.values()) {
      rows.forEach((row, index) => {
        if (row.effective_from <= asOf) {
          officialPrices.push(this.officialView(row, rows[index + 1]?.effective_from ?? null));
        }
      });
    }

    return platformCatalogSnapshotSchema.parse({
      schemaVersion: 1,
      generatedAt: asOf,
      providers,
      models,
      platformPrices,
      officialPrices,
    });
  }
}
