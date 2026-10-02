import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiEndpointSchema, apiRelationSchema } from '@ec/core';
import { newUlid, type ApiIndexSnapshot } from '@ec/registry';
import { createDomainEventSink } from '@ec/shell-api';
import { openBusinessDb } from '../domain/db';
import { createDomainRuntime } from '../domain/runtime';
import { createNavDomain } from '../domain/domains/nav-domain';
import { writeCodeRootPointer } from '../domain/code-root';
import { createProjectPaths } from '../domain/paths';
import { createApiIndex } from '../domain/api-index';
import { createCodeDomain } from '../domain/domains/code-domain';

const runFile = promisify(execFile);
let root: string, projectsDir: string, codeRoot: string, projectId: string, db: Database.Database;
let runtime: ReturnType<typeof createDomainRuntime>;
function file(path: string, content: string): void {
  const full = join(codeRoot, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}
async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await runtime.invoke({
    requestId: newUlid(),
    domain: 'nav',
    method,
    params: { projectId, ...params },
  });
  if (!response.ok) throw new Error(`${response.error?.code}: ${response.error?.message}`);
  return response.result as T;
}
const git = async (...args: string[]): Promise<string> =>
  (
    await runFile('git', args, {
      cwd: codeRoot,
      windowsHide: true,
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_DATE: '2025-01-02T03:04:05Z',
        GIT_COMMITTER_DATE: '2025-01-02T03:04:05Z',
      },
    })
  ).stdout;
const express = (path: string): string =>
  `import express from 'express'; const app=express(); app.get('${path}', loadUser); app.listen(3001);`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-d04-'));
  projectsDir = join(root, 'projects');
  projectId = newUlid();
  codeRoot = join(projectsDir, projectId, 'code');
  mkdirSync(codeRoot, { recursive: true });
  db = openBusinessDb({ dataDir: join(root, 'data') });
  db.prepare(
    "INSERT INTO project(id,user_id,name,status,created_at,updated_at) VALUES(?,'local-user','接口夹具','active',?,?)",
  ).run(projectId, Date.now(), Date.now());
  runtime = createDomainRuntime({
    routers: { nav: createNavDomain({ db, projectsDir, readRequestLogs: () => [] }) },
    events: createDomainEventSink(),
  });
});
afterEach(async () => {
  await runtime.dispose();
  db.close();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows SQLite handle release */
  }
});

describe('V2-D04 生产索引/持久化/边界', () => {
  it('真实白名单 RPC 索引源码而不是 DSL，未知创建时间和多个调用方', async () => {
    file('app.ts', express('/users/:id'));
    file(
      'view.ts',
      "fetch('/users/7'); fetch('/users/8'); fetch('https://external.example/users');",
    );
    const network = vi.spyOn(globalThis, 'fetch');
    const scanned = await call<ApiIndexSnapshot>('apiRescan');
    expect(network).not.toHaveBeenCalled();
    expect(scanned.endpoints).toHaveLength(1);
    const endpoint = scanned.endpoints[0]!;
    expect(apiEndpointSchema.safeParse(endpoint).success).toBe(true);
    expect(endpoint).toMatchObject({
      createdAt: null,
      createdAtSource: 'unknown',
      normalizedPath: '/users/{id}',
      status: 'active',
    });
    expect(scanned.calls.filter((c) => c.status === 'resolved')).toHaveLength(2);
    expect(scanned.calls.filter((c) => c.status === 'external')).toHaveLength(1);
    expect(scanned.relations.every((r) => apiRelationSchema.safeParse(r).success)).toBe(true);
    expect((await call<ApiIndexSnapshot>('apiList')).stale).toBe(false);
    const reverse = await call<string[]>('apiReverse', { filePath: 'view.ts', line: 1 });
    expect(reverse).toContain(endpoint.endpointId);
    const graph = await call<{ nodes: Array<{ id: string }> }>('relationGraph');
    expect(graph.nodes.some((n) => n.id.includes(endpoint.endpointId))).toBe(true);
    await expect(
      call('apiNavigate', { sourceRef: { filePath: '../private.ts', startLine: 1 } }),
    ).rejects.toThrow('PATH_ESCAPE');
    network.mockRestore();
  });
  it('人工分类和稳定 ID 持久化，路径修改留历史，删除留历史对象', async () => {
    file('app.ts', express('/users/:id'));
    file('view.ts', "fetch('/users/1');");
    let scanned = await call<ApiIndexSnapshot>('apiRescan');
    const id = scanned.endpoints[0]!.endpointId;
    const originalRelationId = scanned.relations[0]!.relationId;
    await call('apiClassify', {
      endpointId: id,
      revision: scanned.endpoints[0]!.revision,
      group: '用户管理',
      tags: ['核心'],
    });
    await expect(
      call('apiClassify', { endpointId: id, revision: 1, group: '过期', tags: [] }),
    ).rejects.toThrow('版本');
    file('app.ts', express('/members/:id'));
    expect((await call<ApiIndexSnapshot>('apiList')).stale).toBe(true);
    scanned = await call<ApiIndexSnapshot>('apiRescan');
    const e = scanned.endpoints[0]!;
    expect(e.endpointId).toBe(id);
    expect(e.classification).toMatchObject({ group: '用户管理', source: 'user', revision: 1 });
    expect(e.routeHistory[0]!.path).toBe('/users/{id}');
    const reopened = createApiIndex({ db, paths: createProjectPaths({ projectsDir }) }).snapshot(
      projectId,
    );
    expect(reopened.endpoints[0]!.manualClassification?.tags).toEqual(['核心']);
    file('app.ts', `import express from 'express'; const app=express();`);
    scanned = await call<ApiIndexSnapshot>('apiRescan');
    expect(scanned.endpoints[0]!.status).toBe('removed');
    expect(scanned.endpoints[0]!.endpointId).toBe(id);
    expect(scanned.relations.find((r) => r.relationId === originalRelationId)?.active).toBe(false);
    const graph = await call<{ nodes: Array<{ id: string }> }>('relationGraph');
    expect(graph.nodes.some((n) => n.id.includes(id))).toBe(false);
  });
  it('多服务/动态待确认，人工关系重扫保留，证据变化后重新确认', async () => {
    file('a/app.ts', express('/users/:id'));
    file('b/app.ts', express('/users/:id'));
    file('view.ts', 'fetch(url); fetch(`/users/${id}`);');
    let scanned = await call<ApiIndexSnapshot>('apiRescan');
    expect(scanned.endpoints).toHaveLength(2);
    expect(scanned.calls.every((c) => c.status === 'pending_confirmation')).toBe(true);
    expect(scanned.calls[1]!.endpointIds).toHaveLength(2);
    const dynamic = scanned.calls[0]!,
      endpointId = scanned.endpoints[0]!.endpointId;
    await call('apiConfirmCall', {
      callId: dynamic.callId,
      revision: dynamic.revision,
      endpointId,
    });
    scanned = await call<ApiIndexSnapshot>('apiRescan');
    expect(scanned.calls[0]).toMatchObject({
      confirmedByUser: true,
      status: 'resolved',
      endpointIds: [endpointId],
    });
    file('view.ts', 'fetch(otherUrl); fetch(`/users/${id}`);');
    await expect(
      call('apiConfirmCall', { callId: dynamic.callId, revision: 2, endpointId }),
    ).rejects.toThrow('失效');
    scanned = await call<ApiIndexSnapshot>('apiRescan');
    expect(scanned.calls[0]).toMatchObject({
      confirmedByUser: false,
      status: 'pending_confirmation',
      confirmedEndpointId: endpointId,
    });
    expect(scanned.calls[0]!.reason).toContain('变化');
  });
  it('坏源码重扫不误删，源码只读且不执行 package 脚本', async () => {
    file('app.ts', express('/users'));
    file('view.ts', "fetch('/users');");
    file('package.json', JSON.stringify({ scripts: { preinstall: 'echo DO_NOT_RUN' } }));
    const original = readFileSync(join(codeRoot, 'app.ts'), 'utf8');
    const before = await call<ApiIndexSnapshot>('apiRescan');
    expect(readFileSync(join(codeRoot, 'app.ts'), 'utf8')).toBe(original);
    file('app.ts', 'import express from "express"; const app = express(;');
    file('view.ts', 'fetch(;');
    const scanned = await call<ApiIndexSnapshot>('apiRescan');
    expect(scanned.endpoints[0]!.status).toBe('pending_confirmation');
    expect(scanned.stale).toBe(true);
    expect(scanned.warnings.join()).toContain('语法错误');
    expect(scanned.calls[0]).toMatchObject({
      status: 'pending_confirmation',
      callId: before.calls[0]!.callId,
      revision: before.calls[0]!.revision + 1,
    });
    expect(scanned.relations[0]!.active).toBe(false);
    file('app.ts', express('/users'));
    file('view.ts', "fetch('/users');");
    file('another-service.ts', 'const app=express(;');
    const incomplete = await call<ApiIndexSnapshot>('apiRescan');
    expect(incomplete.calls[0]!.status).toBe('pending_confirmation');
    expect(incomplete.calls[0]!.reason).toContain('扫描不完整');
  });
  it('外置代码根复用既有指针，详情导航能读取该源码', async () => {
    const external = join(root, '中文 源码');
    mkdirSync(external, { recursive: true });
    writeCodeRootPointer(join(projectsDir, projectId), external);
    codeRoot = external;
    file('nested/app.ts', express('/outside-root'));
    const scanned = await call<ApiIndexSnapshot>('apiRescan');
    expect(scanned.endpoints[0]!.normalizedPath).toBe('/outside-root');
    const ref = scanned.endpoints[0]!.sourceRef;
    expect(await call('apiNavigate', { sourceRef: ref })).toMatchObject({
      filePath: 'nested/app.ts',
    });
    const code = createCodeDomain({
      db,
      projectsDir,
      userId: 'local-user',
      aiStack: null,
      emit: () => {},
    });
    const ctx = { requestId: 'read', domain: 'code' as const, emit: () => {} };
    expect(await code.router('readFile', { projectId, path: 'nested/app.ts' }, ctx)).toContain(
      'outside-root',
    );
    expect(await code.router('listFiles', { projectId }, ctx)).toContainEqual({
      path: 'nested/app.ts',
      language: 'typescript',
    });
    await code.dispose();
  });
});

describe('V2-D04 可追溯时间（真实本地 Git）', () => {
  async function commitFixture(): Promise<void> {
    await git('init');
    await git('config', 'user.name', 'D04 Fixture');
    await git('config', 'user.email', 'd04@example.invalid');
    file('app.ts', express('/users/:id'));
    await git('add', 'app.ts');
    await git('commit', '-m', 'explicit route');
  }
  it('首次出现 Git 推断，不采用 mtime；重命名降级解释时间', async () => {
    await commitFixture();
    let scanned = await call<ApiIndexSnapshot>('apiRescan');
    expect(scanned.endpoints[0]).toMatchObject({
      createdAtSource: 'git_inferred',
      createdAt: Date.parse('2025-01-02T03:04:05Z'),
    });
    await git('mv', 'app.ts', 'renamed.ts');
    await git('commit', '-m', 'rename route file');
    scanned = await call<ApiIndexSnapshot>('apiRescan');
    const renamed = scanned.endpoints.find((e) => e.status === 'active')!;
    expect(renamed.createdAt).toBeNull();
    expect(renamed.timeReason).toContain('重命名');
  }, 30_000);
  it('浅克隆与未提交新路由的创建时间未知，未自动 fetch', async () => {
    await commitFixture();
    expect((await call<ApiIndexSnapshot>('apiRescan')).endpoints[0]!.createdAtSource).toBe(
      'git_inferred',
    );
    const original = codeRoot,
      clone = join(root, 'shallow');
    await runFile(
      'git',
      ['clone', '--depth=1', new URL(`file:///${original.replace(/\\/g, '/')}`).href, clone],
      { windowsHide: true, timeout: 10_000 },
    );
    writeCodeRootPointer(join(projectsDir, projectId), clone);
    codeRoot = clone;
    let scanned = await call<ApiIndexSnapshot>('apiRescan');
    expect(scanned.endpoints[0]!.timeReason).toContain('浅克隆');
    expect(scanned.endpoints[0]!.createdAt).toBeNull();
    writeCodeRootPointer(join(projectsDir, projectId), original);
    codeRoot = original;
    file('app.ts', express('/uncommitted'));
    scanned = await call<ApiIndexSnapshot>('apiRescan');
    const newRoute = scanned.endpoints.find((e) => e.status === 'active')!;
    expect(newRoute.createdAt).toBeNull();
    expect(newRoute.createdAtSource).toBe('unknown');
  }, 30_000);
});
