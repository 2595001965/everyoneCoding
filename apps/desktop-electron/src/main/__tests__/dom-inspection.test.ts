// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { DomMapping, DomSelection, DomSession } from '@ec/preview';
import { createDomainEventSink, type DomainControlServiceHost } from '@ec/shell-api';
import { openBusinessDb } from '../domain/db';
import { createProductionDomains } from '../domain/domain-factories';
import { createDomainRuntime } from '../domain/runtime';
import { DomInspection } from '../domain/dom-inspection';
import { createProjectPaths } from '../domain/paths';
import { createSettingStore } from '../domain/setting-store';

let folder: string;
let db: Database.Database;
let runtime: DomainControlServiceHost;
let url: string;
let session: DomSession;
const projectId = '01K00000000000000000000003';
let source: string;
let selection: DomSelection;
async function call<T>(
  domain: 'preview' | 'ai-context',
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await runtime.invoke({
    requestId: `dom-${method}`,
    domain,
    method,
    params: { projectId, ...params },
  });
  if (!response.ok) throw new Error(response.error?.message);
  return response.result as T;
}
function get(url: string): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const req = request(url, { agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolveBody(body));
    });
    req.on('error', reject);
    req.end();
  });
}
beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'ec-dom-'));
  const projectsDir = join(folder, 'projects');
  mkdirSync(join(projectsDir, projectId, 'code'), { recursive: true });
  source = '<!doctype html>\n<button>保存</button>\n';
  writeFileSync(join(projectsDir, projectId, 'code/index.html'), source);
  db = openBusinessDb({ dataDir: join(folder, 'data') });
  const production = createProductionDomains({
    db,
    dataDir: join(folder, 'data'),
    projectsDir,
    userId: 'local-user',
    aiStack: null,
    process: null,
    credentials: null,
    emit: () => {},
  });
  runtime = createDomainRuntime({
    routers: production.routers,
    syncRouters: production.syncRouters,
    disposers: production.disposers,
    events: createDomainEventSink(),
  });
  url = (await call<{ url: string }>('preview', 'start', { mode: 'static' })).url;
});
afterAll(async () => {
  await runtime?.dispose();
  db?.close();
  if (folder && resolve(folder).startsWith(resolve(tmpdir()) + '\\'))
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
});
describe('D03 production preview/domain/context', () => {
  it('injects only after opening inspection and resolves registered original source through whitelist', async () => {
    expect(await get(url)).toBe(source);
    session = await call('preview', 'inspectionSession', { parentOrigin: 'http://localhost:5173' });
    const html = await get(url);
    const token = /<button data-ec-source="([^"]+)"/.exec(html)![1]!;
    selection = {
      node: {
        nodeId: 'runtime-node-1',
        tag: 'button',
        name: '保存',
        id: null,
        classes: [],
        sourceToken: token,
        rect: { x: 0, y: 0, width: 10, height: 10 },
      },
      ancestors: [],
      documentId: 'document-1',
      route: '/',
      instanceIndex: 0,
      instanceCount: 1,
      boundary: 'dom',
    };
    const mapping = await call<DomMapping>('preview', 'resolveDom', { session, selection });
    expect(mapping.anchor).toMatchObject({
      confidence: 'exact',
      sourceRef: { filePath: 'index.html', startLine: 2 },
    });
    expect(readFileSync(join(folder, 'projects', projectId, 'code/index.html'), 'utf8')).toBe(
      source,
    );
    const fake = await call<DomMapping>('preview', 'resolveDom', {
      session,
      selection: { ...selection, node: { ...selection.node, sourceToken: 'generated-element-E1' } },
    });
    expect(fake.anchor.confidence).toBe('unresolved');
    expect(fake.anchor.sourceRef).toBeNull();
    await expect(
      call('preview', 'resolveDom', { session: { ...session, nonce: 'forged' }, selection }),
    ).rejects.toThrow('会话已失效');
    await expect(
      call('preview', 'resolveDom', {
        session,
        selection: { ...selection, node: { ...selection.node, filePath: '../private' } },
      }),
    ).rejects.toThrow('载荷');
  });
  it('persists notes and appends verified read-only source data to the existing AI context engine', async () => {
    const input = {
      session,
      selection,
      note: '按钮改成中文',
      placement: 'after',
      targetPage: '/',
      sharedConfirmed: false,
    };
    await call('preview', 'saveDomNote', input);
    await call('preview', 'attachDomContext', input);
    expect(await call<unknown[]>('preview', 'domNotes')).toHaveLength(1);
    const context = await call<{ blocks: Array<{ id: string; content: string }> }>(
      'ai-context',
      'assemble',
      { request: { projectId, purpose: 'code' } },
    );
    expect(context.blocks.find((item) => item.id === 'code')?.content).toContain('按钮改成中文');
    expect(context.blocks.find((item) => item.id === 'code')?.content).toContain('WritePipeline');
  });
  it('rechecks source revision before location/context and invalidates HMR/stopped sessions', async () => {
    writeFileSync(join(folder, 'projects', projectId, 'code/index.html'), '\n' + source);
    const stale = await call<DomMapping>('preview', 'resolveDom', { session, selection });
    expect(stale.anchor.confidence).toBe('unresolved');
    expect(stale.anchor.invalidReason).toContain('修订');
    await expect(
      call('preview', 'attachDomContext', {
        session,
        selection,
        note: '',
        placement: 'inside',
        targetPage: '/',
        sharedConfirmed: true,
      }),
    ).rejects.toThrow('修订');
    const context = await call<{ blocks: Array<{ id: string; content: string }> }>(
      'ai-context',
      'assemble',
      { request: { projectId, purpose: 'code' } },
    );
    expect(context.blocks.find((item) => item.id === 'code')?.content ?? '').not.toContain(
      '按钮改成中文',
    );
    await get(url);
    const expired = await call<DomMapping>('preview', 'resolveDom', { session, selection });
    expect(expired.anchor.confidence).toBe('unresolved');
    const previous = session.runtimeId;
    await call('preview', 'stop');
    await call('preview', 'start', { mode: 'static' });
    const next = await call<DomSession>('preview', 'inspectionSession', { parentOrigin: 'null' });
    expect(next.runtimeId).not.toBe(previous);
    await expect(call('preview', 'resolveDom', { session, selection })).rejects.toThrow(
      '会话已失效',
    );
  });
  it('shows component definition and instance scope, requiring confirmation before sharing a target', () => {
    const paths = createProjectPaths({ projectsDir: join(folder, 'projects') });
    const inspection = new DomInspection(
      projectId,
      paths,
      createSettingStore({ db, userId: 'local-user' }),
    );
    const jsx = 'export function Shared(){return <button>确认</button>}';
    writeFileSync(paths.inside(paths.codeRoot(projectId), 'Shared.jsx'), jsx);
    const output = inspection.registry.instrument(jsx, 'Shared.jsx', 'react_compiled');
    const localSession = inspection.open('file://');
    const selected = {
      ...selection,
      instanceCount: 2,
      node: { ...selection.node, sourceToken: /data-ec-source="([^"]+)"/.exec(output)![1]! },
    };
    const mapping = inspection.resolve(selected);
    expect(mapping.anchor.sourceRef).toMatchObject({ filePath: 'Shared.jsx', symbol: 'Shared' });
    expect(mapping.shared).toMatchObject({ renderedInstances: 2, requiresConfirmation: true });
    const input = {
      session: localSession,
      selection: selected,
      note: '',
      placement: 'before',
      targetPage: '/',
    };
    expect(() => inspection.save(input, true)).toThrow('共享组件');
    expect(inspection.save({ ...input, sharedConfirmed: true }, true).attached).toBe(true);
  });
});
