// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { AgentStore, type GenerationOutput } from '@ec/ai';
import { newUlid } from '@ec/data';
import { createProjectPaths } from '../domain/paths';
import { openBusinessDb } from '../domain/db';
import { createApiIndex } from '../domain/api-index';
import { createCodeDomain } from '../domain/domains/code-domain';
import type { AiStackHandle } from '../domain/domain-factories';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const USER_ID = 'local-user';
const ROUTES = `import express from 'express';
const app=express();
app.get('/users', loadUsers);
app.listen(3001);
`;
const CALLER = `fetch('/users');
`;
const generation = (
  path: string,
  content: string,
  action: 'patch' | 'create' = 'patch',
): GenerationOutput => ({
  files: [{ path, content, action, language: 'typescript' }],
  anchors: [],
  summary: 'D09 isolated source patch',
  notes: '',
  decision: { referencedMemory: [], rationale: 'Scoped API target', risks: [], uncovered: [] },
});

describe('V2-D09 API-target source generation', () => {
  let root: string;
  let projectsDir: string;
  let codeRoot: string;
  let projectId: string;
  let db: Database.Database;
  let domain: ReturnType<typeof createCodeDomain>;
  let currentOutput: GenerationOutput;
  let modelCalls: number;

  const write = (path: string, content: string): void => {
    const full = join(codeRoot, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };
  const generate = async (apiEditTarget: Record<string, unknown>): Promise<unknown> =>
    domain.router(
      'generate',
      {
        projectId,
        sessionId: newUlid(),
        idempotencyKey: newUlid(),
        request: {
          system: 'Generate a focused source patch.',
          user: 'Apply the selected API change.',
          target: 'backend-code',
          apiEditTarget,
          baseline: 'current',
        },
      },
      { requestId: newUlid(), emit: () => {} },
    );

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ec-v2-d09-'));
    projectsDir = join(root, 'projects');
    projectId = newUlid();
    codeRoot = join(projectsDir, projectId, 'code');
    mkdirSync(codeRoot, { recursive: true });
    write('app.ts', ROUTES);
    db = openBusinessDb({ dataDir: join(root, 'data') });
    db.prepare(
      "INSERT INTO project(id,user_id,name,status,created_at,updated_at) VALUES(?,'local-user','D09 fixture','active',?,?)",
    ).run(projectId, Date.now(), Date.now());
    modelCalls = 0;
    currentOutput = generation(
      'app.ts',
      "@@ -3,1 +3,2 @@\n app.get('/users', loadUsers);\n+app.post('/orders', createOrder);",
    );
    const agentStore = new AgentStore(db, 'v2-d09-fixture', 1_500);
    const aiStack = {
      agentStore,
      gateway: {
        chat: () =>
          (async function* () {
            modelCalls += 1;
            yield { type: 'delta', text: JSON.stringify(currentOutput), model: 'fixture-model' };
            yield { type: 'done', finishReason: 'stop', partial: false };
          })(),
      },
    } as unknown as AiStackHandle;
    domain = createCodeDomain({
      db,
      projectsDir,
      userId: USER_ID,
      aiStack,
      agentStore,
      emit: () => {},
    });
  });

  afterEach(async () => {
    await domain.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('在选定 Router 中生成并通过补丁后真实接口扫描', async () => {
    const index = createApiIndex({ db, paths: createProjectPaths({ projectsDir }) });
    const snapshot = await index.rescan(projectId);
    const endpoint = snapshot.endpoints.find((item) => item.status === 'active')!;
    const result = (await generate({
      mode: 'add-endpoint',
      locationEndpointId: endpoint.endpointId,
      expectedEndpointRevision: endpoint.revision,
      method: 'POST',
      path: '/orders',
    })) as { status: string; plan: { taskId?: string; entries: Array<{ path: string }> } };

    expect(modelCalls).toBe(1);
    expect(result.status).toBe('planned');
    expect(result.plan.entries.map((entry) => entry.path)).toEqual(['app.ts']);
    expect(result.plan.taskId).toBeUndefined();
  });

  it('索引过期时在调用模型前拒绝目标', async () => {
    const index = createApiIndex({ db, paths: createProjectPaths({ projectsDir }) });
    const snapshot = await index.rescan(projectId);
    const endpoint = snapshot.endpoints.find((item) => item.status === 'active')!;
    write('app.ts', ROUTES.replace('/users', '/accounts'));

    await expect(
      generate({
        mode: 'add-endpoint',
        locationEndpointId: endpoint.endpointId,
        expectedEndpointRevision: endpoint.revision,
        method: 'POST',
        path: '/orders',
      }),
    ).rejects.toThrow(/索引未扫描或已过期/);
    expect(modelCalls).toBe(0);
  });

  it('删除接口时输出路由和全部已知调用方，接口索引预扫描确认删除', async () => {
    write('consumer.ts', CALLER);
    const index = createApiIndex({ db, paths: createProjectPaths({ projectsDir }) });
    const snapshot = await index.rescan(projectId);
    const endpoint = snapshot.endpoints.find((item) => item.status === 'active')!;
    currentOutput = {
      files: [
        {
          path: 'app.ts',
          content: "@@ -3,1 +3,0 @@\n-app.get('/users', loadUsers);",
          action: 'patch',
          language: 'typescript',
        },
        {
          path: 'consumer.ts',
          content: "@@ -1,1 +1,0 @@\n-fetch('/users');",
          action: 'patch',
          language: 'typescript',
        },
      ],
      anchors: [],
      summary: 'Remove route and synchronized known caller',
      notes: '',
      decision: {
        referencedMemory: [],
        rationale: 'All indexed local callers are included',
        risks: [],
        uncovered: [],
      },
    };

    const result = (await generate({
      mode: 'delete-endpoint',
      endpointId: endpoint.endpointId,
      expectedEndpointRevision: endpoint.revision,
    })) as { status: string; plan: { entries: Array<{ path: string }> } };

    expect(result.status).toBe('planned');
    expect(result.plan.entries.map((entry) => entry.path).sort()).toEqual([
      'app.ts',
      'consumer.ts',
    ]);
  });

  it('删除目标要求输出同步每个已知调用文件，未同步时不产出计划', async () => {
    write('consumer.ts', CALLER);
    const index = createApiIndex({ db, paths: createProjectPaths({ projectsDir }) });
    const snapshot = await index.rescan(projectId);
    const endpoint = snapshot.endpoints.find((item) => item.status === 'active')!;
    currentOutput = generation('app.ts', "@@ -3,1 +3,0 @@\n-app.get('/users', loadUsers);");

    await expect(
      generate({
        mode: 'delete-endpoint',
        endpointId: endpoint.endpointId,
        expectedEndpointRevision: endpoint.revision,
      }),
    ).rejects.toThrow(/没有同步所有已知影响文件/);
    expect(modelCalls).toBe(1);
    expect(readFileSync(join(codeRoot, 'app.ts'), 'utf8')).toContain("app.get('/users'");
  });
});
