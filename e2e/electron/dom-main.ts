import { app, BrowserWindow, ipcMain, type WebFrameMain } from 'electron';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { openBusinessDb } from '../../apps/desktop-electron/src/main/domain/db';
import { createProductionDomains } from '../../apps/desktop-electron/src/main/domain/domain-factories';
import { createWorkspaceDomain } from '../../apps/desktop-electron/src/main/domain/workspace';
import { createDomainRuntime } from '../../apps/desktop-electron/src/main/domain/runtime';
import { registerDomainIpc } from '../../apps/desktop-electron/src/main/ipc/domain';
import { sourceHash, type DomMapping, type DomSelection, type DomSession } from '@ec/preview';
import {
  createControlledProcessHost,
  type ControlledProcessHost,
} from '../../apps/desktop-electron/src/main/domain/process-host';

const folder = process.env['EC_DOM_TEST_DIR']!;
let processes: ControlledProcessHost | null = null;
app.setPath('userData', join(folder, 'profile'));
async function run(): Promise<void> {
  await app.whenReady();
  const dataDir = join(folder, 'data');
  const projectsDir = join(folder, 'projects');
  const db = openBusinessDb({ dataDir });
  processes = createControlledProcessHost({ allowedRoot: projectsDir });
  const production = createProductionDomains({
    db,
    dataDir,
    projectsDir,
    userId: 'local-user',
    aiStack: null,
    process: processes,
    credentials: null,
    emit: () => {},
  });
  const runtime = createDomainRuntime({
    routers: {
      workspace: createWorkspaceDomain({ db, dataDir, projectsDir }).router,
      ...production.routers,
    },
    syncRouters: production.syncRouters,
    disposers: production.disposers,
  });
  registerDomainIpc(ipcMain, runtime);
  const created = await runtime.invoke({
    requestId: 'create',
    domain: 'workspace',
    method: 'createProject',
    params: { input: { name: 'DOM 原生验证' } },
  });
  assert.equal(created.ok, true);
  const projectId = (created.result as { id: string }).id;
  const file = join(projectsDir, projectId, 'code/index.html');
  const html = `<!doctype html><html><body style="margin:0">
<form id="form"><input id="password" type="password" value="secret-password"><button id="submit">提交</button></form>
<button id="delete">删除</button><a id="link" href="/other">导航</a><button id="add">新增节点</button>
<div style="height:700px"></div><button id="scroll">滚动元素</button><div style="height:700px"></div>
<script>window.counts={submit:0,remove:0};document.querySelector('#form').onsubmit=e=>{e.preventDefault();counts.submit++};document.querySelector('#delete').onclick=()=>counts.remove++;document.querySelector('#add').onclick=()=>{const b=document.createElement('button');b.id='dynamic';b.textContent='动态节点';document.body.prepend(b)};</script>
</body></html>`;
  writeFileSync(file, html);
  await runtime.invoke({
    requestId: 'start',
    domain: 'preview',
    method: 'start',
    params: { projectId, mode: 'static' },
  });
  const win = new BrowserWindow({
    show: false,
    width: 1300,
    height: 1000,
    webPreferences: {
      preload: join(folder, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 || /error|not defined|cors/i.test(message)) console.error(message);
  });
  await win.loadFile(join(folder, 'index.html'), { query: { projectId } });
  win.webContents.debugger.attach('1.3');
  win.webContents.focus();
  const host = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code);
  const wait = async (predicate: () => Promise<boolean>, label: string): Promise<void> => {
    for (let i = 0; i < 120; i++) {
      if (await predicate()) return;
      await delay(100);
    }
    console.error('DOM failure frames', win.webContents.mainFrame.frames.map(frame=>frame.url));
    console.error('DOM failure last event', await host('window.__lastEvent'));
    throw new Error(`${label}: ${await host('document.body.innerText')}`);
  };
  const button = (text: string): Promise<void> =>
    host(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)})?.click()`,
    );
  const child = (): WebFrameMain =>
    win.webContents.mainFrame.frames.find((frame) => frame.url.startsWith('http://127.0.0.1:'))!;
  const click = async (selector: string): Promise<void> => {
    const rect = (await child().executeJavaScript(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}})()`,
    )) as { x: number; y: number; width: number };
    const outer = await host<{ x: number; y: number; scale: number }>(
      `(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y,scale:r.width/${rect.width}}})()`,
    );
    const position = {
      x: Math.round(outer.x + rect.x * outer.scale),
      y: Math.round(outer.y + rect.y * outer.scale),
    };
    const targets = (await win.webContents.debugger.sendCommand('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    const target = targets.targetInfos.find(
      (item) => item.type === 'iframe' && item.url === child().url,
    );
    let sessionId: string | undefined;
    if (target) {
      const attached = (await win.webContents.debugger.sendCommand('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      })) as { sessionId: string };
      sessionId = attached.sessionId;
    }
    const coordinates = sessionId ? { x: rect.x, y: rect.y } : position;
    console.info(
      'DOM E2E: pointer target',
      selector,
      coordinates,
      target?.type ?? 'main',
      await host(`document.elementFromPoint(${position.x},${position.y})?.tagName`),
    );
    await win.webContents.debugger.sendCommand(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', ...coordinates },
      sessionId,
    );
    await win.webContents.debugger.sendCommand(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', button: 'left', clickCount: 1, ...coordinates },
      sessionId,
    );
    await win.webContents.debugger.sendCommand(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', button: 'left', clickCount: 1, ...coordinates },
      sessionId,
    );
    if (sessionId)
      await win.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId });
    await delay(100);
  };
  const snapshot = (): Promise<DomSelection> => host('window.__lastEvent.payload');
  const key = async (key: string, code: number): Promise<void> => {
    const targets = (await win.webContents.debugger.sendCommand('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    const target = targets.targetInfos.find(
      (item) => item.type === 'iframe' && item.url === child().url,
    )!;
    const attached = (await win.webContents.debugger.sendCommand('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };
    await win.webContents.debugger.sendCommand(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key, windowsVirtualKeyCode: code },
      attached.sessionId,
    );
    await win.webContents.debugger.sendCommand(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key, windowsVirtualKeyCode: code },
      attached.sessionId,
    );
    await win.webContents.debugger.sendCommand('Target.detachFromTarget', {
      sessionId: attached.sessionId,
    });
  };
  await wait(
    () =>
      host(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='选取'&&!b.disabled)`,
      ),
    'selector ready',
  );
  assert.deepEqual(
    await child().executeJavaScript(
      '[typeof require,typeof ecShell,typeof window.__TAURI_INTERNALS__]',
    ),
    ['undefined', 'undefined', 'undefined'],
  );
  await button('选取');
  await delay(100);
  console.info(
    'DOM E2E: selector mode',
    await host('window.__lastEvent?.type'),
    await child().executeJavaScript(`!!document.querySelector('[data-ec-inspector]')`),
  );
  await click('#delete');
  console.info(
    'DOM E2E: native click',
    await host('window.__lastEvent?.type'),
    await child().executeJavaScript('window.counts'),
  );
  await wait(
    () => host(`document.body.innerText.includes('index.html:3:')`),
    'original HTML location',
  );
  assert.deepEqual(await child().executeJavaScript('window.counts'), { submit: 0, remove: 0 });
  const first = await snapshot();
  assert.equal(first.node.tag, 'button');
  writeFileSync(join(folder, 'native-dom.png'), (await win.webContents.capturePage()).toPNG());
  await button('定位前端源码');
  await wait(
    () =>
      host(
        `window.__testNavTarget()?.filePath==='index.html'&&window.__testNavTarget().line===3&&location.hash==='#/code'`,
      ),
    'production source navigation',
  );
  await host(`document.querySelector('textarea').focus()`);
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '保留备注' });
  await button('保存备注');
  await wait(() => host(`document.body.innerText.includes('备注已保存')`), 'production note save');
  await button('附加到 AI 上下文');
  await wait(
    () => host(`document.body.innerText.includes('已附加到本项目 AI 上下文')`),
    'production context attachment',
  );
  const assembled = await runtime.invoke({
    requestId: 'context',
    domain: 'ai-context',
    method: 'assemble',
    params: { request: { projectId, purpose: 'code' } },
  });
  assert.equal(assembled.ok, true);
  assert(JSON.stringify(assembled.result).includes('保留备注'));
  await host(`document.querySelector('[aria-label="DOM 祖先链"] button').click()`);
  await wait(
    () =>
      host(`window.__lastEvent?.type==='selection'&&window.__lastEvent.payload.node.tag==='body'`),
    'ancestor selection',
  );
  await click('#submit');
  await click('#link');
  assert.deepEqual(await child().executeJavaScript('window.counts'), { submit: 0, remove: 0 });
  assert(!child().url.includes('/other'));
  await click('#password');
  assert(!JSON.stringify(await snapshot()).includes('secret-password'));
  await child().executeJavaScript(`document.querySelector('#password').focus()`);
  await key('Enter', 13);
  assert.equal(
    ((await child().executeJavaScript('window.counts')) as { submit: number }).submit,
    0,
  );
  await key('Escape', 27);
  await wait(
    () =>
      host(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='交互').getAttribute('aria-pressed')==='true'`,
      ),
    'escape exit',
  );
  await delay(100);
  await click('#delete');
  assert.equal(
    ((await child().executeJavaScript('window.counts')) as { remove: number }).remove,
    1,
  );
  await click('#add');
  await button('选取');
  await delay(100);
  await click('#dynamic');
  await wait(() => host(`document.body.innerText.includes('unresolved')`), 'unmapped dynamic node');
  assert.equal(
    await host(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='定位前端源码').disabled`,
    ),
    true,
  );
  await child().executeJavaScript('scrollTo(0,500)');
  await click('#scroll');
  const aligned = await child().executeJavaScript(
    `(()=>{const a=document.querySelector('#scroll').getBoundingClientRect(),o=document.querySelector('[data-ec-inspector]').getBoundingClientRect();return Math.abs(a.x-o.x)<1&&Math.abs(a.y-o.y)<1&&Math.abs(a.width-o.width)<1})()`,
  );
  assert.equal(aligned, true);
  win.webContents.setZoomFactor(1.25);
  assert.equal(
    await child().executeJavaScript(
      `(()=>{const a=document.querySelector('#scroll').getBoundingClientRect(),o=document.querySelector('[data-ec-inspector]').getBoundingClientRect();return Math.abs(a.y-o.y)<1})()`,
    ),
    true,
  );
  win.webContents.setZoomFactor(1);
  assert.equal(readFileSync(file, 'utf8'), html);
  writeFileSync(file, '\n' + html.replace('滚动元素', '源码更新'));
  await wait(
    () => host(`document.body.innerText.includes('源码修订已变化')`),
    'stale source revision',
  );
  assert.equal(
    await host(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='附加到 AI 上下文').disabled`,
    ),
    true,
  );
  await child().executeJavaScript(`history.pushState({},'', '/route-changed')`);
  await wait(
    () =>
      host(
        `document.body.innerText.includes('请重新选取')&&!document.querySelector('[aria-label="选中元素卡片"]')`,
      ),
    'SPA invalidation',
  );
  const configs = JSON.parse(readFileSync(join(folder, 'vite-configs.json'), 'utf8')) as Array<{
    name: string;
    file: string;
  }>;
  const frameworks: Array<{
    name: string;
    first: DomSelection;
    updated: DomSelection;
    mapping: DomMapping;
    initialMapping: DomMapping;
    staleMapping: DomMapping;
    contentHash: string;
    productionRuntime: boolean;
  }> = [];
  for (const config of configs) {
    const invoke = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const response = await runtime.invoke({
        requestId: `vite-${method}`,
        domain: 'preview',
        method,
        params,
      });
      if (!response.ok) {
        const logs = await runtime.invoke({requestId:'failure-logs',domain:'preview',method:'logs',params:{projectId:params['projectId']}});
        console.error('Vite production logs', (logs.result as Array<{text:string}> | undefined)?.map(line=>line.text).join('\n'));
      }
      assert.equal(response.ok, true, response.error?.message ?? '');
      return response.result as T;
    };
    const created = await runtime.invoke({
      requestId: `create-${config.name}`,
      domain: 'workspace',
      method: 'createProject',
      params: { input: { name: `DOM ${config.name} production` } },
    });
    assert.equal(created.ok, true);
    const viteProjectId = (created.result as { id: string }).id;
    const codeRoot = join(projectsDir, viteProjectId, 'code');
    const fixtureRoot = join(folder, config.name);
    const sourceFile = config.name === 'react' ? 'Shared.jsx' : 'Shared.vue';
    for (const name of ['package.json', 'vite.config.mjs', 'index.html', 'main.js', sourceFile])
      copyFileSync(join(fixtureRoot, name), join(codeRoot, name));
    await invoke('confirmRunPlan', {
      projectId: viteProjectId,
      plans: [
        {
          cwd: '.',
          services: [
            {
              serviceId: 'frontend',
              role: 'frontend',
              command: 'npm run dev',
              args: ['--host', '127.0.0.1', '--strictPort'],
              portHint: null,
            },
          ],
          startupOrder: ['frontend'],
          envVarNames: [],
        },
      ],
    });
    const run = await invoke<{ runtimeId: string; status: string }>('startRun', {
      projectId: viteProjectId,
    });
    assert.equal(run.status, 'ready');
    const state = await invoke<{ url: string; runtimeId: string }>('state', {
      projectId: viteProjectId,
    });
    assert.equal(state.runtimeId, run.runtimeId);
    await host(
      `window.__lastEvent=null;window.__testInspect(${JSON.stringify(viteProjectId)},${JSON.stringify(state.url)},${JSON.stringify(state.runtimeId)})`,
    );
    await wait(
      () => host(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='选取'&&!b.disabled)`),
      `${config.name} selector ready`,
    );
    await button('选取');
    await wait(
      () => host(`window.__lastEvent?.type==='mode'&&window.__lastEvent.payload===true`),
      `${config.name} mode`,
    );
    await wait(
      async () =>
        (await child().executeJavaScript(
          `document.querySelectorAll('button.shared').length===2`,
        )) === true,
      `${config.name} render`,
    );
    await click('button.shared');
    const frameworkFirst = await snapshot();
    assert.equal(frameworkFirst.instanceCount, 2);
    assert.equal(await child().executeJavaScript('window.business??0'), 0);
    await wait(
      () =>
        host(
          `document.body.innerText.includes('Shared 组件定义')&&document.body.innerText.includes('exact')`,
        ),
      `${config.name} shared source UI`,
    );
    assert.equal(
      await host(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='附加到 AI 上下文').disabled`,
      ),
      true,
    );
    const session = await host<DomSession>(
      `window.__lastEvent && ({projectId:window.__lastEvent.projectId,runtimeId:window.__lastEvent.runtimeId,nonce:window.__lastEvent.nonce,parentOrigin:location.origin})`,
    );
    const initialMapping = await invoke<DomMapping>('resolveDom', {
      projectId: viteProjectId,
      session,
      selection: frameworkFirst,
    });
    const productionFile = join(codeRoot, sourceFile);
    const content = readFileSync(productionFile, 'utf8');
    writeFileSync(productionFile, content.replace('Shared action', 'HMR updated'));
    await wait(
      async () =>
        (await child().executeJavaScript(
          `document.querySelector('button.shared')?.textContent==='HMR updated'`,
        )) === true,
      `${config.name} HMR`,
    );
    await wait(
      () =>
        host(
          `window.__domEvents.some(e=>e.type==='invalidated'||e.type==='ready'&&e.documentId!==${JSON.stringify(frameworkFirst.documentId)})`,
        ),
      `${config.name} selection invalidated`,
    );
    if (
      await host(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='选取')!==undefined`,
      )
    )
      await button('选取');
    await click('button.shared');
    const updated = await snapshot();
    assert.notEqual(updated.node.sourceToken, frameworkFirst.node.sourceToken);
    const mapping = await invoke<DomMapping>('resolveDom', {
      projectId: viteProjectId,
      session,
      selection: updated,
    });
    const staleMapping = await invoke<DomMapping>('resolveDom', {
      projectId: viteProjectId,
      session,
      selection: frameworkFirst,
    });
    assert.equal(
      (await fetch(new URL('/__ec_dom_compile', state.url), { method: 'POST' })).status,
      403,
    );
    frameworks.push({
      name: config.name,
      first: frameworkFirst,
      updated,
      mapping,
      initialMapping,
      staleMapping,
      contentHash: sourceHash(readFileSync(productionFile, 'utf8')),
      productionRuntime: true,
    });
    await invoke('stopRuntime', { projectId: viteProjectId, runtimeId: run.runtimeId });
    const expired = await runtime.invoke({
      requestId: 'expired',
      domain: 'preview',
      method: 'resolveDom',
      params: { projectId: viteProjectId, session, selection: updated },
    });
    assert.equal(expired.ok, false);
  }
  writeFileSync(
    join(folder, 'result.json'),
    JSON.stringify({
      static: {
        safeSelection: true,
        interaction: true,
        keyboard: true,
        ancestor: true,
        navigation: true,
        noteContext: true,
        isolatedBridge: true,
        dynamic: true,
        privacy: true,
        scrollZoom: true,
        staleSource: true,
        routeInvalidation: true,
        unchangedSource: true,
      },
      frameworks,
    }),
  );
  win.destroy();
  await runtime.dispose();
  await processes.dispose();
  db.close();
  app.quit();
}
void run().catch(async (error) => {
  console.error(error);
  await processes?.dispose();
  process.exit(1);
});
