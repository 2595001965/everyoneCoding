import { app, BrowserWindow, ipcMain } from 'electron';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { openBusinessDb } from '../../apps/desktop-electron/src/main/domain/db';
import {
  createProductionDomains,
  type AiStackHandle,
} from '../../apps/desktop-electron/src/main/domain/domain-factories';
import { createWorkspaceDomain } from '../../apps/desktop-electron/src/main/domain/workspace';
import { createDomainRuntime } from '../../apps/desktop-electron/src/main/domain/runtime';
import { registerDomainIpc } from '../../apps/desktop-electron/src/main/ipc/domain';
import type { QueueState } from '@ec/pipeline';

// Only the external model is deterministic. Window, preload, IPC, ports, SQLite and files are production code.
const folder = process.env['EC_PIPELINE_TEST_DIR']!;
const phase = Number(process.env['EC_PIPELINE_TEST_PHASE']);
app.setPath('userData', join(folder, 'profile'));
const dataDir = join(folder, 'data');
let s5Calls = 0;
const ai: AiStackHandle = {
  gateway: {
    chat(input) {
      return (async function* () {
        if (input.purpose === 'code') {
          s5Calls += 1;
          await delay(300);
          yield {
            type: 'delta',
            text: JSON.stringify({
              files: [
                {
                  path: `src/node-${phase}-${s5Calls}.ts`,
                  content: 'export const ready = true;\n',
                },
              ],
            }),
          };
        } else if (input.purpose === 'techdoc') {
          yield {
            type: 'delta',
            text: '# 技术文档\n## 技术选型\nReact\n## 接口设计\nopenapi: 3.0.0\n## 功能：任务管理（f-1）\n## 功能：成员管理（f-2）\n## 功能：报告（f-3）',
          };
        } else {
          yield {
            type: 'delta',
            text: '# 需求文档\n## 项目背景\n轻量工作台\n## 目标用户\n团队\n## 功能清单\n- P0：任务管理\n## 用户故事\n作为成员，我希望跟踪任务\n## 业务流程图\n创建任务到完成\n## 验收标准\n- [ ] 任务可查询\n## 非功能要求\n单元测试\n## 风险与假设\n离线运行',
          };
        }
        yield { type: 'done' };
      })();
    },
  },
};

async function run(): Promise<void> {
  await app.whenReady();
  const db = openBusinessDb({ dataDir });
  const projectsDir = join(folder, 'projects');
  const production = createProductionDomains({
    db,
    dataDir,
    projectsDir,
    userId: 'local-user',
    aiStack: ai,
    process: null,
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
  let projectId: string;
  if (phase === 1) {
    const created = await runtime.invoke({
      requestId: 'create',
      domain: 'workspace',
      method: 'createProject',
      params: { input: { name: 'Electron真实流水线' } },
    });
    assert.equal(created.ok, true);
    projectId = (created.result as { id: string }).id;
    writeFileSync(join(folder, 'project-id'), projectId);
  } else projectId = readFileSync(join(folder, 'project-id'), 'utf8');
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 1000,
    webPreferences: {
      preload: join(folder, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on('console-message', (_event, _level, message) =>
    console.warn('[renderer]', message),
  );
  await win.loadFile(join(folder, 'index.html'), { query: { projectId } });
  const js = <T>(expression: string): Promise<T> =>
    win.webContents.executeJavaScript(expression, true);
  const waitFor = async (expression: string): Promise<void> => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (await js<boolean>(expression)) return;
      await delay(40);
    }
    throw new Error(
      'UI timeout: ' + expression + '\n' + (await js<string>('document.body.innerText')),
    );
  };
  const click = async (selector: string): Promise<void> => {
    await waitFor(
      `document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`,
    );
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await delay(60);
  };
  const textButton = async (text: string): Promise<void> => {
    const finder = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`;
    await waitFor(`!!(${finder})`);
    await js(`(${finder}).click()`);
    await delay(70);
  };
  const snapshot = `globalThis.__EC_PIPELINE__.snapshot(${JSON.stringify(projectId)})`;
  const queue = `globalThis.__EC_PIPELINE__.getQueueState(${JSON.stringify(projectId)})`;
  const confirmAdvance = async (): Promise<void> => {
    await click('[data-testid="stage-confirm"]');
    await click('[data-testid="stage-advance"]');
  };
  try {
    await waitFor('!!document.querySelector("[data-testid=pipeline-workspace]")');
    if (phase === 1) {
      await js(
        `(() => {const el=document.querySelector('[data-testid=idea-input]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'为团队开发离线任务工作台，支持任务、成员及报告。');el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await click('[data-testid="idea-generate"]');
      await confirmAdvance();
      await click('#design-page');
      await waitFor("document.getElementById('design-page').textContent === '设计页已保存'");
      await click('[data-testid="stage-generate"]');
      await confirmAdvance();
      assert.equal(await js(`${snapshot}.S3.status`), 'pending');
      await click('[role="dialog"] input[type="checkbox"]');
      await textButton('下一步');
      await textButton('下一步');
      await textButton('完成');
      await waitFor('!document.querySelector("[role=dialog]")');
      await click('[data-testid="stage-advance"]');
      await click('[data-testid="stage-generate"]');
      await confirmAdvance();
      await click('[data-testid="stage-generate"]');
      await confirmAdvance();
      await textButton('开始生成');
      await waitFor(`${queue}?.stats.running === 1`);
      await textButton('暂停队列');
      await waitFor(`${queue}?.currentId === null && ${queue}?.stats.success === 1`);
      assert.equal(s5Calls, 1);
      writeFileSync(
        join(folder, 'phase1.json'),
        JSON.stringify({ projectId, queue: await js(queue), snapshot: await js(snapshot) }),
      );
    } else {
      await waitFor('!!document.querySelector("[data-testid=s5-queue]")');
      assert.equal((await js<QueueState>(queue)).stats.success, 1);
      await textButton('从断点继续');
      await waitFor(`${snapshot}.S5.status === 'awaiting_confirm'`);
      assert.equal((await js<QueueState>(queue)).stats.success, 3);
      assert.equal(s5Calls, 2);
      assert.equal(
        await js(
          `globalThis.__EC_PIPELINE__.getTechChoice(${JSON.stringify(projectId)}).targets[0]`,
        ),
        'web',
      );
      await confirmAdvance();
      // S6/S7 reports are real versioned artifacts and remain reviewable like earlier stages.
      for (const stage of ['S6', 'S7']) {
        await click('[data-testid="stage-generate"]');
        await js(
          `(() => {const el=document.querySelector('[data-testid=manual-edit-area]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify('验证报告：通过')});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
        await click('[data-testid="manual-edit-save"]');
        if (stage === 'S6') await confirmAdvance();
        else await click('[data-testid="stage-confirm"]');
      }
      writeFileSync(
        join(folder, 'phase2.json'),
        JSON.stringify({ projectId, queue: await js(queue), snapshot: await js(snapshot) }),
      );
    }
    await runtime.dispose();
    db.close();
    win.destroy();
    app.exit(0);
  } catch (error) {
    await runtime.dispose();
    db.close();
    throw error;
  }
}
void run().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
