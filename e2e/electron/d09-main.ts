import { app, BrowserWindow, ipcMain } from 'electron';
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore, type GenerationOutput } from '@ec/ai';
import { newUlid } from '@ec/data';
import { createCliGitBackend, createNodeGitRunner } from '@ec/git';
import { createDomainEventSink } from '@ec/shell-api';
import { openBusinessDb } from '../../apps/desktop-electron/src/main/domain/db';
import { createNavDomain } from '../../apps/desktop-electron/src/main/domain/domains/nav-domain';
import { createCodeDomain } from '../../apps/desktop-electron/src/main/domain/domains/code-domain';
import { createDomainRuntime } from '../../apps/desktop-electron/src/main/domain/runtime';
import { registerDomainIpc } from '../../apps/desktop-electron/src/main/ipc/domain';
import { TaskWriteService } from '../../apps/desktop-electron/src/main/domain/task-write-service';
import { taskFileSystem } from '../../apps/desktop-electron/src/main/domain/task-file-system';
import type { AiStackHandle } from '../../apps/desktop-electron/src/main/domain/domain-factories';

const folder = process.env['EC_D09_TEST_DIR']!;
const evidenceDir = process.env['EC_D09_EVIDENCE_DIR']!;
app.setPath('userData', join(folder, 'profile'));
const patch = [
  '@@ -1,2 +1,25 @@',
  "-export async function requestOrders() { return fetch('/api/orders', { credentials: 'include' }); }",
  '-export function Orders() { return <section><h1>Orders</h1></section>; }',
  "+import { useRef, useState } from 'react';",
  '+type Order = { id: string; label: string };',
  "+export async function requestOrders() { return fetch('/api/orders', { credentials: 'include' }); }",
  '+export function Orders() {',
  '+  const [orders, setOrders] = useState<Order[]>([]);',
  '+  const [loading, setLoading] = useState(false);',
  "+  const [error, setError] = useState('');",
  '+  const [unauthorized, setUnauthorized] = useState(false);',
  '+  const pending = useRef(false);',
  '+  async function refresh() {',
  '+    if (pending.current) return;',
  '+    pending.current = true;',
  "+    setLoading(true); setError(''); setUnauthorized(false);",
  '+    try {',
  '+      const response = await requestOrders();',
  '+      if (response.status === 401 || response.status === 403) { setUnauthorized(true); return; }',
  "+      if (!response.ok) throw new Error('Request failed');",
  '+      setOrders(await response.json() as Order[]);',
  "+    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed'); }",
  '+    finally { pending.current = false; setLoading(false); }',
  '+  }',
  '+  return <section><h1>Orders</h1><button disabled={loading} onClick={() => void refresh()}>{loading ? \'Loading…\' : \'Refresh orders\'}</button>{error && <><p role="alert">{error}</p><button disabled={loading} onClick={() => void refresh()}>Retry</button></>}{unauthorized && <p role="alert">No permission</p>}{!loading && orders.length === 0 && <p>No orders</p>}<ul>{orders.map((order) => <li key={order.id}>{order.label}</li>)}</ul></section>;',
  '+}',
].join('\n');
const output: GenerationOutput = {
  files: [{ path: 'orders.tsx', content: patch, action: 'patch', language: 'typescript' }],
  anchors: [],
  summary: 'Add an order refresh feature at the indexed API call site',
  notes: '',
  decision: {
    referencedMemory: [],
    rationale: 'Focused UI addition at the selected API caller',
    risks: [],
    uncovered: [],
  },
};

async function run(): Promise<void> {
  await app.whenReady();
  const projectsDir = join(folder, 'projects');
  const projectId = newUlid();
  const codeRoot = join(projectsDir, projectId, 'code');
  mkdirSync(codeRoot, { recursive: true });
  const write = (path: string, value: string): void => {
    const full = join(codeRoot, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, value, 'utf8');
  };
  write(
    'server.ts',
    `import express from 'express';\nconst app=express();\napp.get('/api/orders', listOrders);\napp.listen(3001);\n`,
  );
  write(
    'orders.tsx',
    `export async function requestOrders() { return fetch('/api/orders', { credentials: 'include' }); }\nexport function Orders() { return <section><h1>Orders</h1></section>; }\n`,
  );
  const db = openBusinessDb({ dataDir: join(folder, 'data') });
  db.prepare(
    "INSERT INTO project(id,user_id,name,status,created_at,updated_at) VALUES(?,'local-user','D09 preview fixture','active',?,?)",
  ).run(projectId, Date.now(), Date.now());
  const agentStore = new AgentStore(db, 'd09-electron-preview', 1_500);
  const aiStack = {
    agentStore,
    gateway: {
      chat: () =>
        (async function* () {
          yield { type: 'delta', text: JSON.stringify(output), model: 'isolated-d09-preview' };
          yield { type: 'done', finishReason: 'stop', partial: false };
        })(),
    },
  } as unknown as AiStackHandle;
  const taskWrites = new TaskWriteService({
    storageDir: join(folder, 'task-writes'),
    codeRoot: (id) => join(projectsDir, id, 'code'),
    git: createCliGitBackend({ runner: createNodeGitRunner() }),
    owner: {
      assertOwner: () => agentStore.assertOwner(),
      fencingToken: () => {
        if (agentStore.token === null) throw new Error('AgentStore owner is not ready');
        return agentStore.token;
      },
      write: <T>(action: () => T): T => agentStore.write(action),
    },
    validate: async (root, changed) => {
      const fs = taskFileSystem(root);
      return Promise.all(
        changed.map(async (path) => ({
          name: 'D09-preview-integrity',
          ok: await fs.exists(path),
          detail: `verified ${path}`,
        })),
      );
    },
  });
  const code = createCodeDomain({
    db,
    projectsDir,
    userId: 'local-user',
    aiStack,
    agentStore,
    taskWrites,
    emit: () => {},
  });
  const nav = createNavDomain({ db, projectsDir, readRequestLogs: () => [] });
  const runtime = createDomainRuntime({
    routers: { nav, code: code.router },
    events: createDomainEventSink(),
    disposers: [code.dispose],
  });
  registerDomainIpc(ipcMain, runtime);
  while (agentStore.token === null) await delay(25);

  const win = new BrowserWindow({
    show: process.env['EC_D09_INTERACTIVE'] === '1',
    width: 1500,
    height: 1050,
    title: 'EveryoneCoding D09 定点接口功能预览',
    webPreferences: {
      preload: join(folder, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  await win.loadFile(join(folder, 'index.html'), { query: { projectId } });
  const host = <T>(script: string): Promise<T> => win.webContents.executeJavaScript(script);
  const wait = async (predicate: () => Promise<boolean>, label: string): Promise<void> => {
    for (let n = 0; n < 200; n++) {
      if (await predicate()) return;
      await delay(100);
    }
    throw new Error(`${label}: ${await host('document.body.innerText')}`);
  };
  const settlePaint = async (): Promise<void> => {
    await host(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await delay(900);
  };
  const clickText = async (label: string): Promise<void> => {
    const clicked = await host<boolean>(
      `(()=>{const button=Array.from(document.querySelectorAll('button')).find((item)=>item.textContent?.trim()===${JSON.stringify(label)});button?.click();return !!button})()`,
    );
    assert(clicked, `Could not find button: ${label}`);
  };
  await wait(() => host(`document.querySelectorAll('.ec-api-row').length===1`), 'API index ready');
  await host(`document.querySelector('.ec-api-row').click()`);
  await wait(
    () =>
      host(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='以此调用点新增页面功能')`,
      ),
    'resolved API call is available as target',
  );
  await clickText('以此调用点新增页面功能');
  await wait(
    () =>
      host(
        `document.querySelector('[data-testid="ec-api-edit-target"]')?.textContent.includes('依据接口在调用页面新增功能')`,
      ),
    'CodePage received the API caller target',
  );
  await host(`document.querySelector('[aria-label="确认任务基线"]').click()`);
  await wait(
    () =>
      host(
        `(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='按定点目标生成安全计划');return !!b&&!b.disabled})()`,
      ),
    'D09 target is validated and ready',
  );
  await clickText('按定点目标生成安全计划');
  await wait(
    () =>
      host(
        `(()=>{const plan=document.querySelector('[data-testid="ec-write-plan"]');const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='按定点目标生成安全计划');return !!plan&&plan.innerText.includes('pending.current')&&!!button&&!button.disabled&&button.getAttribute('aria-busy')!=='true'&&getComputedStyle(plan).display!=='none'})()`,
      ),
    'focused patch preview rendered',
  );
  await settlePaint();
  const previewText = await host<string>(
    `document.querySelector('[data-testid="ec-write-plan"]').innerText`,
  );
  for (const marker of ['orders.tsx', '401', '403', 'No orders', 'disabled={loading}', 'Retry'])
    assert(previewText.includes(marker), `Preview is missing state/target marker: ${marker}`);
  mkdirSync(evidenceDir, { recursive: true });
  await host(
    `document.querySelector('[data-testid="ec-write-plan"]').scrollIntoView({block:'center'})`,
  );
  await settlePaint();
  assert(
    await host(
      `(()=>{const plan=document.querySelector('[data-testid="ec-write-plan"]');return !!plan&&!!plan.querySelector('.ec-apply-bar')&&!plan.innerText.includes('暂无待应用的写入计划')})()`,
    ),
    'captured preview frame must show the focused diff, not a loading/empty placeholder',
  );
  writeFileSync(
    join(evidenceDir, 'd09-code-plan-preview.png'),
    (await win.webContents.capturePage()).toPNG(),
  );
  await clickText('应用变更');
  await wait(
    () =>
      host(
        `document.querySelector('[data-testid="ec-code-apply-result"]')?.textContent.includes('已应用 1 个文件')`,
      ),
    'isolated D07 merge completed',
  );
  await wait(
    () =>
      host(
        `(()=>{const result=document.querySelector('[data-testid="ec-apply-result"]');const button=document.querySelector('[aria-label="应用变更"]');return result?.getAttribute('data-apply-ok')==='true'&&!!button&&!button.disabled&&button.getAttribute('aria-busy')!=='true'&&!button.querySelector('.ec-button__spinner')})()`,
      ),
    'renderer received the completed apply result',
  );
  await host(
    `document.querySelector('[data-testid="ec-apply-result"]').scrollIntoView({block:'center'})`,
  );
  await settlePaint();
  const settledApply = await host(
    `(()=>{const result=document.querySelector('[data-testid="ec-apply-result"]');const button=document.querySelector('[aria-label="应用变更"]');return result?.getAttribute('data-apply-ok')==='true'&&!!button&&!button.disabled&&button.getAttribute('aria-busy')!=='true'&&!button.querySelector('.ec-button__spinner')})()`,
  );
  assert(settledApply, 'captured apply frame must show the settled D07 merge result');
  const applied = readFileSync(join(codeRoot, 'orders.tsx'), 'utf8');
  for (const marker of [
    '401',
    '403',
    'No orders',
    'pending.current',
    'Retry',
    "fetch('/api/orders', { credentials: 'include' })",
  ])
    assert(applied.includes(marker), `Merged source is missing: ${marker}`);
  assert.equal(
    (applied.match(/fetch\(/g) ?? []).length,
    1,
    'the existing authenticated request wrapper was reused',
  );
  writeFileSync(
    join(evidenceDir, 'd09-code-applied-preview.png'),
    (await win.webContents.capturePage()).toPNG(),
  );
  writeFileSync(
    join(evidenceDir, 'result.json'),
    JSON.stringify(
      {
        actualElectronWindow: true,
        actualCodePage: true,
        existingApiCallTarget: true,
        visibleFocusedDiff: true,
        loadingAndDuplicateSubmit:
          applied.includes('disabled={loading}') && applied.includes('pending.current'),
        emptyErrorAndUnauthorizedStates:
          applied.includes('No orders') && applied.includes('setUnauthorized(true)'),
        isolatedSafeMerge: true,
        noLiveApiDeleteRequest: true,
      },
      null,
      2,
    ),
  );
  win.destroy();
  await runtime.dispose();
  db.close();
  app.quit();
}

void run().catch((error) => {
  console.error(error);
  app.exit(1);
});
