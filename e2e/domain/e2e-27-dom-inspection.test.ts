import { spawn } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build as viteBuild, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import {
  DomSourceRegistry,
  createDomInspectionPlugin,
  type DomMapping,
  type DomSelection,
  type DomSession,
} from '@ec/preview';
import type * as Esbuild from '../../apps/desktop-electron/node_modules/esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const appRoot = join(root, 'apps/desktop-electron');
const electronRequire = createRequire(join(appRoot, 'package.json'));
const previewRequire = createRequire(join(root, 'packages/preview/package.json'));
const rendererRequire = createRequire(join(root, 'apps/renderer/package.json'));
const electron = electronRequire('electron') as string;
const { build } = electronRequire('esbuild') as typeof Esbuild;
let folder: string;
const fixtures: Array<{
  name: string;
  file: string;
}> = [];
beforeAll(async () => {
  folder = mkdtempSync(join(appRoot, '.tmp-dom-e2e-'));
  mkdirSync(join(folder, 'build/Release'), { recursive: true });
  copyFileSync(
    join(appRoot, 'build/Release/better_sqlite3.node'),
    join(folder, 'build/Release/better_sqlite3.node'),
  );
  writeFileSync(
    join(folder, 'package.json'),
    '{"name":"dom-electron-e2e","version":"1.0.0","type":"module"}',
  );
  const vue = (await import(pathToFileURL(previewRequire.resolve('@vitejs/plugin-vue')).href))
    .default as () => Plugin;
  for (const name of ['react', 'vue']) {
    const fixtureRoot = join(folder, name);
    mkdirSync(fixtureRoot);
    writeFileSync(
      join(fixtureRoot, 'index.html'),
      '<!doctype html><html><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>',
    );
    const file = join(fixtureRoot, name === 'react' ? 'Shared.jsx' : 'Shared.vue');
    writeFileSync(
      file,
      name === 'react'
        ? 'export default function Shared(){\nreturn <button className="shared" onClick={()=>window.business=(window.business??0)+1}>Shared action</button>\n}'
        : '<script setup>function click(){window.business=(window.business??0)+1}</script>\n<template><button class="shared" @click="click">Shared action</button></template>',
    );
    writeFileSync(
      join(fixtureRoot, 'main.js'),
      name === 'react'
        ? `import React from 'react';import {createRoot} from 'react-dom/client';import Shared from './Shared.jsx';createRoot(document.getElementById('app')).render(React.createElement('div',null,React.createElement(Shared),React.createElement(Shared)));`
        : `import {createApp,h} from 'vue';import Shared from './Shared.vue';createApp({render:()=>h('div',[h(Shared),h(Shared)])}).mount('#app');`,
    );
    const registry = new DomSourceRegistry();
    const session: DomSession = {
      projectId: 'vite-fixture',
      runtimeId: `vite-${name}`,
      nonce: `nonce-${name}`,
      parentOrigin: 'file://',
    };
    const aliases =
      name === 'react'
        ? [
            {
              find: /^react-dom\/client$/,
              replacement: rendererRequire.resolve('react-dom/client'),
            },
            { find: /^react-dom$/, replacement: rendererRequire.resolve('react-dom') },
            {
              find: /^react\/jsx-dev-runtime$/,
              replacement: rendererRequire.resolve('react/jsx-dev-runtime'),
            },
            {
              find: /^react\/jsx-runtime$/,
              replacement: rendererRequire.resolve('react/jsx-runtime'),
            },
            { find: /^react$/, replacement: rendererRequire.resolve('react') },
          ]
        : [
            {
              find: /^vue$/,
              replacement: previewRequire.resolve('vue/dist/vue.runtime.esm-bundler.js'),
            },
          ];
    const plugin = createDomInspectionPlugin({ root: fixtureRoot, registry, session });
    const compilerUrl = pathToFileURL(
      name === 'react'
        ? rendererRequire.resolve('@vitejs/plugin-react')
        : previewRequire.resolve('@vitejs/plugin-vue'),
    ).href;
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      JSON.stringify({ name: `dom-${name}`, type: 'module', scripts: { dev: 'vite' } }),
    );
    writeFileSync(
      join(fixtureRoot, 'vite.config.mjs'),
      `import compiler from ${JSON.stringify(compilerUrl)};export default {plugins:[compiler()],resolve:{alias:[${aliases.map((a) => `{find:${a.find.toString()},replacement:${JSON.stringify(a.replacement)}}`).join(',')}]},server:{host:'127.0.0.1',fs:{allow:${JSON.stringify([folder, join(root, 'node_modules'), join(root, 'apps/renderer/node_modules'), join(root, 'packages/preview/node_modules')])}}}};`,
    );
    const config = {
      root: fixtureRoot,
      configFile: false as const,
      logLevel: 'warn' as const,
      plugins: [plugin, name === 'react' ? react() : vue()],
      resolve: { alias: aliases },
      server: {
        host: '127.0.0.1',
        port: 0,
        fs: {
          allow: [
            folder,
            join(root, 'node_modules'),
            join(root, 'apps/renderer/node_modules'),
            join(root, 'packages/preview/node_modules'),
          ],
        },
      },
    };
    const original = readFileSync(file, 'utf8');
    await viteBuild({
      ...config,
      build: { outDir: join(fixtureRoot, 'production'), emptyOutDir: true },
    });
    const scan = (dir: string): string =>
      readdirSync(dir, { withFileTypes: true })
        .map((entry) =>
          entry.isDirectory()
            ? scan(join(dir, entry.name))
            : readFileSync(join(dir, entry.name), 'utf8'),
        )
        .join('\n');
    expect(scan(join(fixtureRoot, 'production'))).not.toMatch(
      /data-ec-source|ec-dom-v1|ec-local-dom-inspection/,
    );
    expect(readFileSync(file, 'utf8')).toBe(original);
    fixtures.push({
      name,
      file,
    });
  }
  writeFileSync(join(folder, 'vite-configs.json'), JSON.stringify(fixtures));
  await build({
    entryPoints: [join(root, 'e2e/electron/dom-main.ts')],
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
  await build({
    entryPoints: [join(root, 'e2e/electron/dom-renderer.tsx')],
    outfile: join(folder, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    conditions: ['browser'],
    jsx: 'automatic',
    tsconfig: join(root, 'apps/renderer/tsconfig.json'),
    nodePaths: [join(root, 'apps/renderer/node_modules')],
    alias: {
      '@ec/core': join(root, 'packages/core/src/browser.ts'),
      '@ec/ai': join(root, 'packages/ai/src/browser.ts'),
      '@ec/preview': join(root, 'packages/preview/src/browser.ts'),
      '@ec/pipeline': join(root, 'packages/pipeline/src/browser.ts'),
      '@ec/data': join(root, 'packages/data/src/browser.ts'),
    },
    define: { 'process.env.NODE_ENV': '"test"' },
    logLevel: 'silent',
  });
  writeFileSync(
    join(folder, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><style>body{margin:8px;font:14px sans-serif}.ec-preview-frame{width:800px;height:400px;border:0;display:block}button,input,select,textarea{margin:3px}p{margin:6px}</style><div id="root"></div><script src="renderer.js"></script>',
  );
}, 60000);
afterAll(async () => {
  if (folder) {
    if (
      !resolve(folder).startsWith(resolve(appRoot) + '\\') &&
      !resolve(folder).startsWith(resolve(appRoot) + '/')
    )
      throw new Error('Unexpected test directory');
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
it('real Electron DOM/UI/IPC and React/Vue dev HMR, with clean production builds', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, EC_DOM_TEST_DIR: folder };
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
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) resolveRun();
      else reject(new Error(`DOM Electron ${timedOut ? 'timed out' : code}\n${output}`));
    });
  });
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8')) as {
    static: Record<string, boolean>;
    frameworks: Array<{
      name: string;
      first: DomSelection;
      updated: DomSelection;
      mapping: DomMapping;
      initialMapping: DomMapping;
      staleMapping: DomMapping;
      contentHash: string;
      productionRuntime: boolean;
    }>;
  };
  expect(Object.values(result.static).every(Boolean)).toBe(true);
  for (const item of result.frameworks) {
    expect(item.first.instanceCount).toBe(2);
    expect(item.productionRuntime).toBe(true);
    expect(item.initialMapping.anchor.confidence).toBe('exact');
    expect(item.initialMapping.shared.requiresConfirmation).toBe(true);
    expect(item.staleMapping.anchor.confidence).toBe('unresolved');
    expect(item.mapping.anchor.confidence).toBe('exact');
    expect(item.mapping.anchor.sourceRef).toMatchObject({
      filePath: item.name === 'react' ? 'Shared.jsx' : 'Shared.vue',
      startLine: 2,
      symbol: 'Shared',
    });
    expect(item.mapping.anchor.sourceRevision?.contentHash).toBe(item.contentHash);
  }
  const evidence = join(root, '.tmp-v2-d03-evidence');
  mkdirSync(evidence, { recursive: true });
  copyFileSync(join(folder, 'native-dom.png'), join(evidence, 'dom-selection.png'));
  copyFileSync(join(folder, 'result.json'), join(evidence, 'result.json'));
}, 80000);
