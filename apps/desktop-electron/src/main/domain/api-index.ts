import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { apiRouteKeyOf, type ApiRelation, type SourceRef } from '@ec/core';
import {
  candidateRoutes,
  newUlid,
  scanApiSources,
  type ApiClassification,
  type ApiEndpointDetail,
  type ApiEndpointDraft,
  type ApiIndexSnapshot,
  type ApiSourceFile,
  type IndexedApiCall,
  type IndexedApiEndpoint,
  type IndexedApiRelation,
} from '@ec/registry';
import { parseOpenApiDocument } from '@ec/preview';
import { ShellError } from '@ec/shell-api';
import type { ProjectPaths } from './paths';
import { resolveCodeRoot } from './code-root';
import { createApiHistoryReader } from './api-history';

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SKIP = new Set([
  'node_modules',
  '.git',
  '.next',
  '.venv',
  'venv',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.openai',
]);
const ALLOWED = /\.(?:[cm]?[jt]sx?|py|json|ya?ml|md|toml)$|(^|\/)requirements\.txt$/;
const MAX_FILES = 2_000,
  MAX_BYTES = 20 * 1024 * 1024,
  MAX_FILE = 1024 * 1024;
interface SourceSnapshot {
  files: ApiSourceFile[];
  fingerprint: string;
  warnings: string[];
  complete: boolean;
}

export function createApiIndex(options: { db: Database.Database; paths: ProjectPaths }) {
  const { db, paths } = options;
  const inFlight = new Map<string, Promise<ApiIndexSnapshot>>();
  const projectRoot = (projectId: string): string => {
    const project = db.prepare('SELECT id FROM project WHERE id = ?').get(projectId);
    if (!project) throw new ShellError('NOT_FOUND', '项目不存在');
    return paths.projectRoot(projectId);
  };
  const codeRoot = (projectId: string): string => resolveCodeRoot(projectRoot(projectId));
  function readSources(projectId: string): SourceSnapshot {
    const root = codeRoot(projectId),
      files: ApiSourceFile[] = [],
      warnings: string[] = [];
    let totalBytes = 0,
      complete = true;
    if (!existsSync(root)) {
      complete = false;
      warnings.push('登记的源码根不可读取，保留旧接口；请核对项目源码位置');
    }
    const walk = (dir: string, depth: number): void => {
      if (depth > 16) {
        warnings.push('源码深度超限，扫描不完整');
        complete = false;
        return;
      }
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (SKIP.has(entry.name) || entry.name.startsWith('.env')) continue;
        if (entry.isSymbolicLink()) {
          warnings.push(`跳过链接：${entry.name}`);
          complete = false;
          continue;
        }
        try {
          const full = paths.inside(
            root,
            [paths.relative(root, dir), entry.name].filter(Boolean).join('/'),
          );
          if (entry.isDirectory()) {
            walk(full, depth + 1);
            continue;
          }
          if (
            !entry.isFile() ||
            !ALLOWED.test(entry.name) ||
            /(?:lock|tsconfig)\.json$|pnpm-lock\.ya?ml$|package-lock\.json$/.test(entry.name)
          )
            continue;
          const stat = statSync(full);
          if (
            files.length >= MAX_FILES ||
            stat.size > MAX_FILE ||
            totalBytes + stat.size > MAX_BYTES
          ) {
            complete = false;
            warnings.push('源码文件/大小超限，扫描不完整，保留旧接口');
            continue;
          }
          const content = readFileSync(full, 'utf8');
          totalBytes += stat.size;
          files.push({
            path: paths.relative(root, full),
            content,
            modifiedAt: Math.floor(stat.mtimeMs),
          });
        } catch {
          complete = false;
          warnings.push(`无法安全读取：${entry.name}，扫描不完整`);
        }
      }
    };
    try {
      walk(root, 0);
    } catch {
      complete = false;
      warnings.push('源码目录无法读取，扫描不完整');
    }
    return {
      files,
      warnings,
      complete,
      fingerprint: hash([
        root,
        files.map((f) => [f.path, hash(f.content), f.modifiedAt]),
        complete,
      ]),
    };
  }
  const rows = <T>(table: string, projectId: string): T[] =>
    (
      db.prepare(`SELECT payload_json FROM ${table} WHERE project_id = ?`).all(projectId) as Array<{
        payload_json: string;
      }>
    ).map((row) => JSON.parse(row.payload_json) as T);
  function snapshot(projectId: string, source?: SourceSnapshot): ApiIndexSnapshot {
    projectRoot(projectId);
    const meta = db
      .prepare('SELECT fingerprint, scanned_at, payload_json FROM api_scan WHERE project_id = ?')
      .get(projectId) as
      { fingerprint: string; scanned_at: number; payload_json: string } | undefined;
    const metadata: Pick<ApiIndexSnapshot, 'services' | 'warnings'> & { complete?: boolean } = meta
      ? (JSON.parse(meta.payload_json) as Pick<ApiIndexSnapshot, 'services' | 'warnings'> & {
          complete?: boolean;
        })
      : { services: [], warnings: [] };
    return {
      projectId,
      endpoints: rows<IndexedApiEndpoint>('api_endpoint', projectId),
      calls: rows<IndexedApiCall>('api_call', projectId),
      relations: rows<IndexedApiRelation>('api_relation', projectId),
      ...metadata,
      scannedAt: meta?.scanned_at ?? null,
      stale:
        !meta ||
        metadata.complete === false ||
        meta.fingerprint !== (source ?? readSources(projectId)).fingerprint,
      fingerprint: meta?.fingerprint ?? null,
    };
  }
  const saveEndpoint = db.prepare(
    `INSERT INTO api_endpoint(endpoint_id,project_id,service_id,method,normalized_path,status,revision,payload_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(endpoint_id) DO UPDATE SET service_id=excluded.service_id,method=excluded.method,normalized_path=excluded.normalized_path,status=excluded.status,revision=excluded.revision,payload_json=excluded.payload_json`,
  );
  const persistEndpoint = (e: IndexedApiEndpoint): void => {
    saveEndpoint.run(
      e.endpointId,
      e.projectId,
      e.serviceId,
      e.method,
      e.normalizedPath,
      e.status,
      e.revision,
      JSON.stringify(e),
    );
  };
  const persistCall = (c: IndexedApiCall): void => {
    db.prepare(
      `INSERT INTO api_call(call_id,project_id,source_key,revision,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(call_id) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json`,
    ).run(c.callId, c.projectId, c.key, c.revision, JSON.stringify(c));
  };
  function classifyDraft(
    draft: ApiEndpointDraft,
    previous: IndexedApiEndpoint | undefined,
    projectId: string,
    now: number,
  ): ApiClassification {
    if (previous?.manualClassification) return previous.manualClassification;
    const features = db
      .prepare('SELECT id, name FROM feature WHERE project_id = ?')
      .all(projectId) as Array<{ id: string; name: string }>;
    const feature = features.find(
      (f) => f.name.length > 1 && (draft.title.includes(f.name) || draft.rawPath.includes(f.name)),
    );
    const group =
      draft.tags[0] ??
      feature?.name ??
      draft.normalizedPath
        .split('/')
        .find(
          (segment) =>
            segment &&
            !['api', 'v1', 'v2', '__unresolved__'].includes(segment) &&
            !segment.startsWith('{'),
        ) ??
      null;
    return {
      group:
        draft.status === 'pending_confirmation' && !draft.tags.length && !feature ? null : group,
      tags: draft.tags,
      source: draft.tags.length
        ? 'contract'
        : feature
          ? 'feature'
          : group && draft.status === 'active'
            ? 'rule'
            : 'unclassified',
      revision: previous?.classification.revision ?? 1,
      updatedAt: now,
    };
  }
  function reconcileRelations(
    projectId: string,
    endpoints: IndexedApiEndpoint[],
    calls: IndexedApiCall[],
    previous: IndexedApiRelation[],
    now: number,
  ): void {
    const put = (relation: IndexedApiRelation): void => {
      db.prepare(
        `INSERT INTO api_relation(relation_id,project_id,endpoint_id,caller_ref,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(relation_id) DO UPDATE SET payload_json=excluded.payload_json`,
      ).run(
        relation.relationId,
        projectId,
        relation.endpointId,
        relation.callerRef,
        JSON.stringify(relation),
      );
    };
    for (const relation of previous)
      put({
        ...relation,
        active: false,
        revision: relation.revision + (relation.active ? 1 : 0),
        updatedAt: relation.active ? now : relation.updatedAt,
      });
    const add = (
      endpointId: string,
      callerRef: string,
      callerKind: ApiRelation['callerKind'],
      evidenceKind: ApiRelation['evidenceKind'],
      confidence: number | null,
      confirmedByUser: boolean,
    ): void => {
      const prev = previous.find((r) => r.endpointId === endpointId && r.callerRef === callerRef);
      const next: IndexedApiRelation = {
        relationId: prev?.relationId ?? newUlid(),
        endpointId,
        callerRef,
        callerKind,
        evidenceKind,
        confidence,
        confirmedByUser,
        updatedAt: prev?.updatedAt ?? now,
        revision: prev?.revision ?? 1,
        active: true,
      };
      if (
        prev &&
        (!prev.active || prev.confirmedByUser !== confirmedByUser || prev.confidence !== confidence)
      ) {
        next.revision++;
        next.updatedAt = now;
      }
      put(next);
    };
    for (const e of endpoints.filter((e) => e.status !== 'removed'))
      for (const ev of e.evidence.filter((ev) => ev.kind === 'openapi'))
        add(e.endpointId, ev.key, 'contract', 'contract_operation', ev.confidence, false);
    for (const c of calls.filter((c) => c.status === 'resolved'))
      for (const endpointId of c.endpointIds)
        add(
          endpointId,
          c.callId,
          'source_call',
          'explicit_call',
          c.confirmedByUser ? null : 1,
          c.confirmedByUser,
        );
  }
  async function performScan(projectId: string): Promise<ApiIndexSnapshot> {
    const source = readSources(projectId),
      previous = snapshot(projectId, source);
    const result = scanApiSources(source.files, parseOpenApiDocument);
    const inferTime = createApiHistoryReader(
      codeRoot(projectId),
      source.files,
      parseOpenApiDocument,
    );
    const now = Date.now(),
      used = new Set<string>();
    const endpoints: IndexedApiEndpoint[] = [];
    for (const draft of result.endpoints) {
      let old = previous.endpoints.find(
        (e) => apiRouteKeyOf(e) === apiRouteKeyOf(draft) && !used.has(e.endpointId),
      );
      if (!old) {
        const matches = previous.endpoints.filter(
          (e) =>
            !used.has(e.endpointId) &&
            e.serviceId === draft.serviceId &&
            e.evidence.some((ev) =>
              draft.evidence.some((d) => d.kind !== 'configuration' && d.key === ev.key),
            ),
        );
        if (matches.length === 1) old = matches[0];
      }
      const fingerprint = hash(draft);
      const creation =
        old?.createdAtSource === 'tool_event'
          ? {
              createdAt: old.createdAt,
              createdAtSource: old.createdAtSource,
              timeReason: old.timeReason,
            }
          : await inferTime(draft);
      const endpointId = old?.endpointId ?? newUlid();
      used.add(endpointId);
      const classification = classifyDraft(draft, old, projectId, now);
      if (old && old.classification.source !== 'user') {
        if (
          hash([old.classification.group, old.classification.tags, old.classification.source]) ===
          hash([classification.group, classification.tags, classification.source])
        ) {
          classification.updatedAt = old.classification.updatedAt;
        } else {
          classification.revision = old.classification.revision + 1;
        }
      }
      const changed =
        !old ||
        old.fingerprint !== fingerprint ||
        old.status !== draft.status ||
        hash([old.createdAt, old.createdAtSource, old.timeReason, old.classification]) !==
          hash([creation.createdAt, creation.createdAtSource, creation.timeReason, classification]);
      const routeHistory = [...(old?.routeHistory ?? [])];
      if (old && apiRouteKeyOf(old) !== apiRouteKeyOf(draft))
        routeHistory.push({
          serviceId: old.serviceId,
          method: old.method,
          path: old.normalizedPath,
          at: now,
        });
      endpoints.push({
        ...draft,
        endpointId,
        projectId,
        contractSource: draft.evidence.some((e) => e.kind === 'router_decl')
          ? 'router_decl'
          : 'openapi',
        sourceRef: draft.evidence[0]?.sourceRef ?? null,
        featureIds: old?.featureIds ?? [],
        ...creation,
        firstSeenAt: old?.firstSeenAt ?? now,
        updatedAt: changed ? now : old!.updatedAt,
        revision: old ? old.revision + (changed ? 1 : 0) : 1,
        classification,
        manualClassification: old?.manualClassification ?? null,
        fingerprint,
        routeHistory,
      });
    }
    const complete = source.complete && result.complete;
    for (const old of previous.endpoints.filter((e) => !used.has(e.endpointId)))
      endpoints.push(
        complete
          ? {
              ...old,
              status: 'removed',
              revision: old.revision + (old.status === 'removed' ? 0 : 1),
              updatedAt: old.status === 'removed' ? old.updatedAt : now,
            }
          : old.status === 'removed'
            ? old
            : {
                ...old,
                status: 'pending_confirmation',
                revision: old.revision + (old.status === 'pending_confirmation' ? 0 : 1),
                updatedAt: old.status === 'pending_confirmation' ? old.updatedAt : now,
              },
      );
    const calls: IndexedApiCall[] = result.calls.map((draft) => {
      const old = previous.calls.find((c) => c.key === draft.key),
        candidates = candidateRoutes(
          draft,
          endpoints
            .filter((e) => e.status !== 'removed')
            .map((e) => ({ ...e, status: e.status as ApiEndpointDraft['status'] })),
          result.services,
        );
      const expressionChanged =
        old &&
        hash([old.expression, old.path, old.origin, old.method]) !==
          hash([draft.expression, draft.path, draft.origin, draft.method]);
      const confirmedRoute = endpoints.find(
        (e) => e.endpointId === old?.confirmedEndpointId && e.status === 'active',
      );
      const previousRoute = previous.endpoints.find(
        (e) => e.endpointId === old?.confirmedEndpointId,
      );
      const confirmed =
        old?.confirmedEndpointId &&
        !expressionChanged &&
        confirmedRoute &&
        previousRoute &&
        apiRouteKeyOf(confirmedRoute) === apiRouteKeyOf(previousRoute)
          ? old.confirmedEndpointId
          : null;
      const external =
        !!draft.origin &&
        !result.services.some((s) => s.origins.includes(draft.origin!)) &&
        !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(draft.origin);
      const status = confirmed
        ? 'resolved'
        : external
          ? 'external'
          : complete && !draft.dynamic && candidates.length === 1
            ? 'resolved'
            : 'pending_confirmation';
      const endpointIds = confirmed
        ? [confirmed]
        : candidates.map((e) => (e as IndexedApiEndpoint).endpointId);
      const reason = confirmed
        ? '用户已确认关系'
        : old?.confirmedEndpointId && !confirmed
          ? '原人工关系的源码/路由证据已变化，需重新确认'
          : external
            ? '第三方请求，仅记录本地调用点；未请求外部服务'
            : !complete
              ? '扫描不完整，候选关系待重新验证'
              : (draft.reason ??
                (candidates.length > 1
                  ? '同方法/路径存在多个服务候选，待确认'
                  : candidates.length === 0
                    ? '没有确定的本地路由匹配，待确认'
                    : null));
      const revision = old
        ? old.revision +
          (expressionChanged || old.status !== status || hash(old.endpointIds) !== hash(endpointIds)
            ? 1
            : 0)
        : 1;
      return {
        ...draft,
        reason,
        callId: old?.callId ?? newUlid(),
        projectId,
        endpointIds,
        status,
        confirmedEndpointId: old?.confirmedEndpointId ?? null,
        confirmedByUser: !!confirmed,
        revision,
        firstSeenAt: old?.firstSeenAt ?? now,
        updatedAt: old?.revision === revision ? old.updatedAt : now,
      };
    });
    for (const old of previous.calls.filter((c) => !calls.some((n) => n.callId === c.callId)))
      calls.push(
        complete
          ? {
              ...old,
              status: 'removed',
              confirmedByUser: false,
              revision: old.revision + (old.status === 'removed' ? 0 : 1),
              updatedAt: old.status === 'removed' ? old.updatedAt : now,
            }
          : old.status === 'removed'
            ? old
            : {
                ...old,
                status: 'pending_confirmation',
                confirmedByUser: false,
                reason: '扫描不完整，旧调用证据待重新验证',
                revision:
                  old.revision +
                  (old.status !== 'pending_confirmation' || old.confirmedByUser ? 1 : 0),
                updatedAt:
                  old.status !== 'pending_confirmation' || old.confirmedByUser
                    ? now
                    : old.updatedAt,
              },
      );
    // Source may change while Git history is being read. Never store a fresh-looking stale scan.
    if (readSources(projectId).fingerprint !== source.fingerprint)
      throw new ShellError('INVALID_ARGUMENT', '源码在扫描中发生变化，请重新扫描');
    db.transaction(() => {
      // Release current identity constraints before assigning renamed routes.
      db.prepare("UPDATE api_endpoint SET status='removed' WHERE project_id=?").run(projectId);
      for (const e of endpoints) persistEndpoint(e);
      for (const c of calls) persistCall(c);
      reconcileRelations(projectId, endpoints, calls, previous.relations, now);
      db.prepare(
        `INSERT INTO api_scan(project_id,fingerprint,scanned_at,payload_json) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET fingerprint=excluded.fingerprint,scanned_at=excluded.scanned_at,payload_json=excluded.payload_json`,
      ).run(
        projectId,
        source.fingerprint,
        now,
        JSON.stringify({
          services: result.services,
          warnings: [...source.warnings, ...result.warnings],
          complete,
        }),
      );
    })();
    return snapshot(projectId, source);
  }
  async function rescan(projectId: string): Promise<ApiIndexSnapshot> {
    const running = inFlight.get(projectId);
    if (running) return running;
    const operation = performScan(projectId);
    inFlight.set(projectId, operation);
    try {
      return await operation;
    } finally {
      inFlight.delete(projectId);
    }
  }
  const findEndpoint = (projectId: string, endpointId: string): IndexedApiEndpoint => {
    const endpoint = rows<IndexedApiEndpoint>('api_endpoint', projectId).find(
      (e) => e.endpointId === endpointId,
    );
    if (!endpoint) throw new ShellError('NOT_FOUND', '接口不存在');
    return endpoint;
  };
  function detail(projectId: string, endpointId: string): ApiEndpointDetail {
    projectRoot(projectId);
    const endpoint = findEndpoint(projectId, endpointId),
      calls = rows<IndexedApiCall>('api_call', projectId).filter(
        (c) => c.status !== 'removed' && c.endpointIds.includes(endpointId),
      );
    const elements = (
      db
        .prepare(
          'SELECT element_id, file_path, start_line, end_line FROM code_anchor WHERE project_id=?',
        )
        .all(projectId) as Array<{
        element_id: string;
        file_path: string;
        start_line: number | null;
        end_line: number | null;
      }>
    ).filter((a) =>
      calls.some(
        (c) =>
          c.status === 'resolved' &&
          c.sourceRef.filePath === a.file_path &&
          c.sourceRef.startLine !== null &&
          a.start_line !== null &&
          a.end_line !== null &&
          c.sourceRef.startLine >= a.start_line &&
          c.sourceRef.startLine <= a.end_line,
      ),
    );
    return {
      endpoint,
      calls,
      relations: rows<IndexedApiRelation>('api_relation', projectId).filter(
        (r) => r.endpointId === endpointId,
      ),
      elements: elements.flatMap((a) => {
        const e = db
          .prepare('SELECT id, page_id, name FROM element WHERE id=?')
          .get(a.element_id) as { id: string; page_id: string; name: string } | undefined;
        return e ? [{ elementId: e.id, pageId: e.page_id, name: e.name }] : [];
      }),
    };
  }
  function classify(projectId: string, input: Record<string, unknown>): IndexedApiEndpoint {
    projectRoot(projectId);
    if (inFlight.has(projectId))
      throw new ShellError('INVALID_ARGUMENT', '扫描进行中，请稍后保存分类');
    const e = findEndpoint(projectId, String(input['endpointId'] ?? ''));
    if (e.revision !== input['revision'])
      throw new ShellError('INVALID_ARGUMENT', '接口版本已变化，请刷新后保存');
    const group = input['group'],
      tags = input['tags'];
    if (
      !(group === null || (typeof group === 'string' && group.length <= 120)) ||
      !Array.isArray(tags) ||
      tags.length > 30 ||
      !tags.every((t) => typeof t === 'string' && t.length <= 80)
    )
      throw new ShellError('INVALID_ARGUMENT', '分类/标签格式非法');
    const classification: ApiClassification = {
      group: typeof group === 'string' ? group.trim() || null : null,
      tags: [...new Set(tags as string[])],
      source: 'user',
      revision: (e.manualClassification?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    };
    e.manualClassification = input['reset'] === true ? null : classification;
    e.classification =
      e.manualClassification ??
      classifyDraft(
        { ...e, status: e.status === 'removed' ? 'pending_confirmation' : e.status },
        { ...e, manualClassification: null },
        projectId,
        Date.now(),
      );
    e.revision++;
    e.updatedAt = Date.now();
    persistEndpoint(e);
    return e;
  }
  function confirmCall(projectId: string, input: Record<string, unknown>): ApiIndexSnapshot {
    const current = snapshot(projectId);
    if (current.stale || inFlight.has(projectId))
      throw new ShellError('INVALID_ARGUMENT', '索引已失效或正在扫描，请重扫后确认关系');
    const call = current.calls.find((c) => c.callId === input['callId']);
    if (!call || call.status === 'removed') throw new ShellError('NOT_FOUND', '调用点不存在');
    if (call.revision !== input['revision'])
      throw new ShellError('INVALID_ARGUMENT', '调用版本已变化，请刷新');
    const endpointId = input['endpointId'];
    if (
      endpointId !== null &&
      (typeof endpointId !== 'string' ||
        !current.endpoints.some((e) => e.endpointId === endpointId && e.status === 'active'))
    )
      throw new ShellError('INVALID_ARGUMENT', '需要选择有效的项目接口');
    if (call.status === 'external')
      throw new ShellError('INVALID_ARGUMENT', '第三方调用不能确认成项目内接口');
    call.confirmedEndpointId = endpointId as string | null;
    call.confirmedByUser = endpointId !== null;
    call.endpointIds = endpointId === null ? [] : [endpointId as string];
    call.status = endpointId === null ? 'pending_confirmation' : 'resolved';
    call.reason = endpointId === null ? '人工关系已清除，等待重新识别/确认' : '用户已确认关系';
    call.revision++;
    call.updatedAt = Date.now();
    db.transaction(() => {
      persistCall(call);
      reconcileRelations(
        projectId,
        current.endpoints,
        current.calls,
        current.relations,
        Date.now(),
      );
    })();
    return snapshot(projectId);
  }
  function reverse(projectId: string, filePath: string, line: number): string[] {
    paths.inside(codeRoot(projectId), filePath);
    if (!Number.isInteger(line) || line < 1)
      throw new ShellError('INVALID_ARGUMENT', '非法代码行号');
    const current = snapshot(projectId);
    const contains = (ref: SourceRef): boolean =>
      ref.filePath === filePath &&
      ref.startLine !== null &&
      line >= ref.startLine &&
      line <= (ref.endLine ?? ref.startLine);
    const direct = current.endpoints
      .filter((e) => e.status !== 'removed' && e.evidence.some((ev) => contains(ev.sourceRef)))
      .map((e) => e.endpointId);
    const callers = current.calls
      .filter((c) => c.status === 'resolved' && contains(c.sourceRef))
      .flatMap((c) => c.endpointIds);
    return [...new Set([...direct, ...callers])];
  }
  function validateSource(projectId: string, ref: SourceRef): void {
    const full = paths.inside(codeRoot(projectId), ref.filePath);
    if (!existsSync(full)) throw new ShellError('NOT_FOUND', '源码已不存在，请重扫');
    if (ref.startLine !== null && (!Number.isInteger(ref.startLine) || ref.startLine < 1))
      throw new ShellError('INVALID_ARGUMENT', '非法代码行号');
  }
  return { snapshot, rescan, detail, classify, confirmCall, reverse, validateSource, codeRoot };
}
