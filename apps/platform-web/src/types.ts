export interface Identity {
  accountId: string;
  login: string;
  displayName: string;
  emailVerified: boolean;
  hasPassword: boolean;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
}

export interface AuthPayload {
  identity: Identity;
  tokens: TokenPair;
}

export interface PriceRates {
  uncachedInput: number | null;
  cacheRead: number | null;
  cacheWriteByTtl: Record<string, number | null> | null;
  output: number | null;
}

export interface PriceVersion {
  priceVersionId: string;
  providerModelKey: string;
  billingMode: 'per_million_tokens';
  currency: string;
  rates: PriceRates;
  cacheWriteRateSemantics: 'full_rate';
  source: { kind: string; evidenceUrl?: string; verifiedAt?: number };
  effectiveFrom: number;
  effectiveTo: number | null;
  publishedAt: number;
  version: number;
}

export interface CatalogProvider {
  providerId: string;
  displayName: string;
  protocol: 'openai' | 'anthropic';
  status: 'active' | 'maintenance';
  statusReason: string | null;
  updatedAt: number;
}

export interface CatalogModel {
  providerId: string;
  modelId: string;
  displayName: string | null;
  protocol: 'openai' | 'anthropic';
  canonicalVendor: string | null;
  canonicalModel: string | null;
  contextWindowTokens: number | null;
  capabilities: string[] | null;
  upstreamModelName: string;
}

export interface OfficialPrice {
  snapshotId: string;
  canonicalVendor: string;
  canonicalModel: string;
  currency: string;
  rates: PriceRates;
  sourceUrl: string;
  verifiedAt: number;
  evidenceVersion: string;
  conditions: string;
  effectiveFrom: number;
  effectiveTo: number | null;
  version: number;
}

export interface CatalogSnapshot {
  schemaVersion: 1;
  generatedAt: number;
  providers: CatalogProvider[];
  models: CatalogModel[];
  platformPrices: PriceVersion[];
  officialPrices: OfficialPrice[];
}

export interface Wallet {
  accountId: string;
  currency: string;
  postedMicros: number;
  heldMicros: number;
  availableMicros: number;
  asOf: number;
  stale: boolean;
}

export interface Usage {
  totalInput: number | null;
  uncachedInput: number | null;
  cacheReadInput: number | null;
  cacheWriteInputByTtl: Record<string, number> | null;
  totalOutput: number | null;
  quality: string;
}

export interface BillingAttempt {
  attemptId: string;
  logicalRequestId: string;
  accountId: string;
  currency: string;
  providerModelKey: string;
  priceVersionId: string;
  priceSnapshot: PriceVersion;
  projectId: string | null;
  sessionId: string | null;
  reservedMicros: number;
  finalMicros: number | null;
  status: string;
  dispatchState: string;
  usage: Usage | null;
  costLines: Array<{
    bucket: string;
    tokens: number;
    rateMicrosPerMillion: number;
    amountMicros: number;
  }> | null;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

export interface AdminProvider extends CatalogProvider {
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  credentialConfigured: boolean;
  credentialRotatedAt: number | null;
  revision: number;
}

export interface AdminModel extends CatalogModel {
  canonicalVendor: string | null;
  canonicalModel: string | null;
  contextWindowSource: string | null;
  capabilities: string[] | null;
  status: 'active' | 'disabled';
  revision: number;
}

export interface AuditEvent {
  id: string;
  action: string;
  actorAccountId: string | null;
  targetAccountId: string | null;
  attemptId: string | null;
  entryId: string | null;
  reason: string | null;
  detail: string | null;
  details: unknown;
  createdAt: number;
}

export interface ReconciliationCase {
  caseId: string;
  attemptId: string;
  accountId: string;
  currency: string;
  providerModelKey: string;
  priceVersionId: string;
  reserveMicros: number;
  finalMicros: number | null;
  attemptStatus: string;
  reason: string;
  createdAt: number;
  dueAt: number;
  status: string;
}
