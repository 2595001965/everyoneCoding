import type { ApiEndpoint, ApiRelation, HttpMethod, SourceRef } from '@ec/core';

export interface ApiSourceFile {
  path: string;
  content: string;
  modifiedAt: number | null;
}

export interface ApiService {
  serviceId: string;
  name: string;
  root: string;
  origins: string[];
}

export interface ApiEvidence {
  kind: 'router_decl' | 'openapi' | 'explicit_call' | 'configuration' | 'reference';
  sourceRef: SourceRef;
  detail: string;
  confidence: number | null;
  /** Declaration identity, independent of line numbers and route paths. */
  key: string;
}

export interface ApiEndpointDraft {
  serviceId: string;
  method: HttpMethod;
  rawPath: string;
  normalizedPath: string;
  title: string;
  tags: string[];
  evidence: ApiEvidence[];
  parameters: unknown;
  response: unknown;
  authentication: string[];
  implementation: SourceRef[];
  tests: SourceRef[];
  documents: SourceRef[];
  status: 'active' | 'pending_confirmation';
  modifiedAt: number | null;
}

export interface ApiCallDraft {
  key: string;
  method: HttpMethod | null;
  expression: string;
  path: string | null;
  origin: string | null;
  serviceHint: string | null;
  sourceRef: SourceRef;
  dynamic: boolean;
  reason: string | null;
}

export interface ApiClassification {
  group: string | null;
  tags: string[];
  source: 'user' | 'contract' | 'feature' | 'rule' | 'unclassified';
  revision: number;
  updatedAt: number;
}

export interface IndexedApiEndpoint extends ApiEndpoint, Omit<ApiEndpointDraft, 'status'> {
  classification: ApiClassification;
  manualClassification: ApiClassification | null;
  timeReason: string;
  fingerprint: string;
  routeHistory: Array<{ serviceId: string; method: HttpMethod; path: string; at: number }>;
}

export interface IndexedApiCall extends ApiCallDraft {
  callId: string;
  projectId: string;
  endpointIds: string[];
  status: 'resolved' | 'pending_confirmation' | 'external' | 'removed';
  confirmedEndpointId: string | null;
  confirmedByUser: boolean;
  revision: number;
  firstSeenAt: number;
  updatedAt: number;
}

export interface ApiIndexSnapshot {
  projectId: string;
  endpoints: IndexedApiEndpoint[];
  calls: IndexedApiCall[];
  relations: IndexedApiRelation[];
  services: ApiService[];
  warnings: string[];
  scannedAt: number | null;
  stale: boolean;
  fingerprint: string | null;
}

/** Inactive evidence remains available for historical endpoint references. */
export interface IndexedApiRelation extends ApiRelation {
  active: boolean;
}

export interface ApiEndpointDetail {
  endpoint: IndexedApiEndpoint;
  calls: IndexedApiCall[];
  relations: IndexedApiRelation[];
  elements: Array<{ elementId: string; pageId: string; name: string }>;
}

export interface ApiIndexPort {
  readonly ready: boolean;
  list(): Promise<ApiIndexSnapshot>;
  rescan(): Promise<ApiIndexSnapshot>;
  detail(endpointId: string): Promise<ApiEndpointDetail>;
  classify(input: {
    endpointId: string;
    revision: number;
    group: string | null;
    tags: string[];
    reset?: boolean;
  }): Promise<IndexedApiEndpoint>;
  confirmCall(input: {
    callId: string;
    revision: number;
    endpointId: string | null;
  }): Promise<ApiIndexSnapshot>;
  reverse(input: { filePath: string; line: number }): Promise<string[]>;
  navigate(sourceRef: SourceRef): Promise<void>;
  navigateElement(input: { pageId: string; elementId: string }): void;
}

export type ApiSort = 'created_asc' | 'created_desc' | 'modified_desc';

export function sortApiEndpoints(
  endpoints: readonly IndexedApiEndpoint[],
  sort: ApiSort,
): IndexedApiEndpoint[] {
  return [...endpoints].sort((a, b) => {
    const aTime = sort === 'modified_desc' ? a.modifiedAt : a.createdAt;
    const bTime = sort === 'modified_desc' ? b.modifiedAt : b.createdAt;
    if (aTime === null && bTime !== null) return 1;
    if (bTime === null && aTime !== null) return -1;
    if (aTime !== null && bTime !== null && aTime !== bTime)
      return sort === 'created_asc' ? aTime - bTime : bTime - aTime;
    return a.firstSeenAt - b.firstSeenAt || a.endpointId.localeCompare(b.endpointId);
  });
}
