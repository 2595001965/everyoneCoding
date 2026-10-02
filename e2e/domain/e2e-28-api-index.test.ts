import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type * as Esbuild from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url)),
  appRoot = join(root, 'apps/desktop-electron');
const requireElectron = createRequire(join(appRoot, 'package.json')),
  electron = requireElectron('electron') as string;
const { build } = requireElectron('esbuild') as typeof Esbuild;
let folder: string;
beforeAll(async () => {
  folder = mkdtempSync(join(appRoot, '.tmp-api-e2e-'));
  mkdirSync(join(folder, 'build/Release'), { recursive: true });
  copyFileSync(
    join(appRoot, 'build/Release/better_sqlite3.node'),
    join(folder, 'build/Release/better_sqlite3.node'),
  );
  writeFileSync(
    join(folder, 'package.json'),
    '{"name":"api-electron-e2e","version":"1.0.0","type":"module"}',
  );
  await build({
    entryPoints: [join(root, 'e2e/electron/api-main.ts')],
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
    logLevel: 'silent',
  });
  const aliases = Object.fromEntries(
    ['core', 'ai', 'registry', 'preview', 'pipeline', 'data'].map((name) => [
      `@ec/${name}`,
      join(root, `packages/${name}/src/browser.ts`),
    ]),
  );
  aliases['@ec/ui/tokens.css'] = join(root, 'packages/ui/src/tokens.css');
  aliases['@ec/ui/styles.css'] = join(root, 'packages/ui/src/styles.css');
  await build({
    entryPoints: [join(root, 'e2e/electron/api-renderer.tsx')],
    outfile: join(folder, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    conditions: ['browser'],
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
    jsx: 'automatic',
    tsconfig: join(root, 'apps/renderer/tsconfig.json'),
    nodePaths: [join(root, 'apps/renderer/node_modules')],
    alias: aliases,
    define: { 'process.env.NODE_ENV': '"test"' },
    logLevel: 'silent',
  });
  writeFileSync(
    join(folder, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>EveryoneCoding D04 验收</title><link rel="stylesheet" href="renderer.css"><style>body{font:14px system-ui;margin:0;background:#f8fafc}.ec-page{padding:24px}button{font:inherit}</style><div id="root"></div><script src="renderer.js"></script>',
  );
}, 60_000);
afterAll(() => {
  if (process.env['EC_API_KEEP'] === '1') {
    writeFileSync(join(root, '.tmp-d04-e2e-path.txt'), folder);
    return;
  }
  if (
    !resolve(folder).startsWith(resolve(appRoot) + '\\') &&
    !resolve(folder).startsWith(resolve(appRoot) + '/')
  )
    throw new Error('Unexpected test directory');
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
it('真实 Electron UI→preload→IPC→源码索引/SQLite，分类/关系和双向导航', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, EC_API_TEST_DIR: folder };
  delete env['ELECTRON_RUN_AS_NODE'];
  await new Promise<void>((done, fail) => {
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
      fail(new Error(`D04 Electron timed out\n${output}`));
    }, 60_000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      fail(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) done();
      else fail(new Error(`D04 Electron ${code}\n${output}`));
    });
  });
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8')) as Record<
    string,
    boolean
  >;
  expect(Object.values(result).every(Boolean)).toBe(true);
}, 80_000);
