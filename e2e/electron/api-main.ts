import { app, BrowserWindow, ipcMain } from 'electron';
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openBusinessDb } from '../../apps/desktop-electron/src/main/domain/db';
import { createNavDomain } from '../../apps/desktop-electron/src/main/domain/domains/nav-domain';
import { createCodeDomain } from '../../apps/desktop-electron/src/main/domain/domains/code-domain';
import { createDomainRuntime } from '../../apps/desktop-electron/src/main/domain/runtime';
import { registerDomainIpc } from '../../apps/desktop-electron/src/main/ipc/domain';

const folder = process.env['EC_API_TEST_DIR']!;
app.setPath('userData', join(folder, 'profile'));
async function run(): Promise<void> {
  await app.whenReady();
  const projectsDir = join(folder, 'projects'),
    db = openBusinessDb({ dataDir: join(folder, 'data') }),
    projectId = 'D04-native-fixture';
  db.prepare(
    "INSERT OR IGNORE INTO project(id,user_id,name,status,created_at,updated_at) VALUES(?,'local-user','D04 原生验证','active',?,?)",
  ).run(projectId, Date.now(), Date.now());
  const root = join(projectsDir, projectId, 'code');
  const source = (path: string, content: string): void => {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  };
  for (const [name, port] of [
    ['a', 3001],
    ['b', 3002],
  ] as const) {
    source(`${name}/package.json`, '{}');
    source(
      `${name}/app.ts`,
      `import express from 'express';\nconst app=express();\napp.get('/api/users/:id', loadUser);\napp.listen(${port});\n`,
    );
  }
  source(
    'a/openapi.json',
    JSON.stringify({
      openapi: '3.0.0',
      paths: {
        '/api/users/{id}': {
          get: {
            summary: '查询用户',
            operationId: 'getUser',
            tags: ['用户管理'],
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { id: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    }),
  );
  source(
    'view.ts',
    "fetch('/api/users/7');\nfetch(url);\nfetch('https://external.example/users');\n",
  );
  const original = readFileSync(join(root, 'a/app.ts'), 'utf8');
  const code = createCodeDomain({
    db,
    projectsDir,
    userId: 'local-user',
    aiStack: null,
    emit: () => {},
  });
  const runtime = createDomainRuntime({
    routers: {
      nav: createNavDomain({ db, projectsDir, readRequestLogs: () => [] }),
      code: code.router,
    },
    disposers: [code.dispose],
  });
  registerDomainIpc(ipcMain, runtime);
  const interactive = process.env['EC_API_INTERACTIVE'] === '1';
  const win = new BrowserWindow({
    show: interactive,
    width: 1440,
    height: 1000,
    title: 'EveryoneCoding D04 验收',
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
    for (let n = 0; n < 120; n++) {
      if (await predicate()) return;
      await delay(100);
    }
    throw new Error(`${label}: ${await host('document.body.innerText')}`);
  };
  await wait(() => host(`document.querySelectorAll('.ec-api-row').length===2`), 'source indexed');
  if (interactive) {
    win.on('closed', () => {
      void runtime.dispose().then(() => {
        db.close();
        app.quit();
      });
    });
    return;
  }
  const button = (text: string): Promise<void> =>
    host(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)})?.click()`,
    );
  await host(
    `Array.from(document.querySelectorAll('.ec-api-row')).find(b=>b.textContent.includes('查询用户')).click()`,
  );
  await wait(
    () => host(`document.querySelector('[aria-label="接口详情"] form')!==null`),
    'detail ready',
  );
  assert(
    await host(
      `document.querySelector('[aria-label="接口详情"]').textContent.includes('未知')&&document.querySelector('[aria-label="接口详情"]').textContent.includes('首次发现')`,
    ),
  );
  await host(
    `(()=>{const input=document.querySelector('form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'人工业务组');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await button('保存人工覆盖');
  await wait(
    () => host(`document.querySelector('.ec-api-list').textContent.includes('人工业务组')`),
    'manual classification',
  );
  await button('重新扫描源码');
  await wait(
    () =>
      host(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='重新扫描源码'&&!b.disabled)`,
      ),
    'rescan done',
  );
  assert(await host(`document.querySelector('.ec-api-list').textContent.includes('人工业务组')`));
  await button('待确认调用');
  await wait(
    () => host(`document.querySelectorAll('.ec-api-calls select').length===2`),
    'pending calls',
  );
  await host(
    `(()=>{const s=document.querySelector('.ec-api-calls select');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await wait(
    () => host(`document.querySelectorAll('.ec-api-calls select').length===1`),
    'relation confirmation',
  );
  await button('第三方请求');
  assert(
    await host(`document.querySelector('.ec-api-calls').textContent.includes('external.example')`),
  );
  await button('项目接口');
  await host(
    `Array.from(document.querySelectorAll('.ec-api-row')).find(b=>b.textContent.includes('查询用户')).click()`,
  );
  await wait(
    () => host(`document.querySelector('[aria-label="接口详情"] .ec-api-refs button')!==null`),
    'evidence navigation',
  );
  await host(`document.querySelector('[aria-label="接口详情"] .ec-api-refs button').click()`);
  await wait(
    () =>
      host(
        `document.querySelector('[data-testid="ec-code-surface"]')?.textContent.includes("app.get('/api/users/:id'")`,
      ),
    'readonly source navigation',
  );
  assert.equal(
    await host(
      `document.querySelector('[data-testid="ec-code-surface"]').getAttribute('data-file-path')`,
    ),
    'a/app.ts',
  );
  await host(
    `document.querySelector('[data-line="3"]').dispatchEvent(new MouseEvent('click',{ctrlKey:true,bubbles:true}))`,
  );
  await wait(
    () => host(`location.hash==='#/apis'&&document.querySelectorAll('.ec-api-row').length===2`),
    'reverse API navigation',
  );
  await wait(
    () =>
      host(`document.querySelector('[aria-label="接口详情"]').textContent.includes('查询用户')`),
    'reverse detail',
  );
  const png = await win.webContents.capturePage();
  writeFileSync(join(folder, 'api-workbench.png'), png.toPNG());
  assert.equal(readFileSync(join(root, 'a/app.ts'), 'utf8'), original);
  writeFileSync(
    join(folder, 'result.json'),
    JSON.stringify({
      sourceIndex: true,
      manualClassification: true,
      rescanPreserved: true,
      pendingRelation: true,
      externalSeparated: true,
      sourceNavigation: true,
      reverseNavigation: true,
      sourceUnchanged: true,
    }),
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
