import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { QueueState, PipelineStageSnapshot } from '@ec/pipeline';
import type * as Esbuild from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const appRoot = join(root, 'apps/desktop-electron');
const require = createRequire(join(appRoot, 'package.json'));
const electron = require('electron') as string;
const { build } = require('esbuild') as typeof Esbuild;
let folder: string;

beforeAll(async () => {
  folder = mkdtempSync(join(appRoot, '.tmp-pipeline-e2e-'));
  mkdirSync(join(folder, 'build/Release'), { recursive: true });
  copyFileSync(
    join(appRoot, 'build/Release/better_sqlite3.node'),
    join(folder, 'build/Release/better_sqlite3.node'),
  );
  writeFileSync(join(folder, 'package.json'), '{"name":"pipeline-electron-e2e","version":"1.0.0"}');
  const entry = (name: string): string => join(root, 'e2e/electron', name);
  await build({
    entryPoints: [entry('pipeline-main.ts')],
    outfile: join(folder, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent',
  });
  await build({
    entryPoints: [join(appRoot, 'src/preload/index.ts')],
    outfile: join(folder, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  await build({
    entryPoints: [entry('pipeline-renderer.tsx')],
    outfile: join(folder, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    conditions: ['browser'],
    jsx: 'automatic',
    tsconfig: join(root, 'apps/renderer/tsconfig.json'),
    nodePaths: [join(root, 'apps/renderer/node_modules')],
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
    alias: {
      '@ec/ui/tokens.css': join(root, 'packages/ui/src/tokens.css'),
      '@ec/ui/styles.css': join(root, 'packages/ui/src/styles.css'),
      '@ec/core': join(root, 'packages/core/src/browser.ts'),
      '@ec/ai': join(root, 'packages/ai/src/browser.ts'),
      '@ec/pipeline': join(root, 'packages/pipeline/src/browser.ts'),
      '@ec/data': join(root, 'packages/data/src/browser.ts'),
    },
    define: { 'process.env.NODE_ENV': '"test"' },
    loader: { '.woff2': 'dataurl' },
  });
  writeFileSync(
    join(folder, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>',
  );
}, 60000);

afterAll(() => {
  if (!folder) return;
  // Only remove the unique directory made by this test, within the Electron workspace.
  if (
    !resolve(folder).startsWith(resolve(appRoot) + '\\') &&
    !resolve(folder).startsWith(resolve(appRoot) + '/')
  )
    throw new Error('Unexpected test directory');
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function launch(phase: number): Promise<void> {
  const env = {
    ...process.env,
    EC_PIPELINE_TEST_DIR: folder,
    EC_PIPELINE_TEST_PHASE: String(phase),
  };
  delete env['ELECTRON_RUN_AS_NODE'];
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(electron, [join(folder, 'main.cjs')], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron phase ${phase} timed out\n${output}`));
    }, 45000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun();
      else reject(new Error(`Electron phase ${phase}: ${code}\n${output}`));
    });
  });
}

it('real Electron UI/IPC: S1→S5, pause, quit process, relaunch and continue through S7', async () => {
  await launch(1);
  await launch(2);
  const first = JSON.parse(readFileSync(join(folder, 'phase1.json'), 'utf8')) as {
    projectId: string;
    queue: QueueState;
  };
  const second = JSON.parse(readFileSync(join(folder, 'phase2.json'), 'utf8')) as {
    projectId: string;
    queue: QueueState;
    snapshot: PipelineStageSnapshot;
  };
  expect(second.projectId).toBe(first.projectId);
  expect(first.queue.stats.success).toBe(1);
  expect(second.queue.stats.success).toBe(3);
  expect(Object.values(second.snapshot).every((stage) => stage.status === 'confirmed')).toBe(true);
}, 100000);
