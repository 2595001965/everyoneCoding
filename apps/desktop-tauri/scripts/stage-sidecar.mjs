import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(packageRoot, '..', '..');
const electronRoot = join(repoRoot, 'apps', 'desktop-electron');
const source = join(electronRoot, 'dist', 'sidecar');
const target = join(packageRoot, 'src-tauri', 'resources', 'sidecar');
const require = createRequire(join(electronRoot, 'package.json'));

if (!existsSync(join(source, 'everyone-coding-sidecar.cjs')))
  throw new Error('侧车未构建；请先执行 @ec/desktop-electron build:sidecar');
const manifest = JSON.parse(readFileSync(join(source, 'sidecar-manifest.json'), 'utf8'));
const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeAbi = Number(process.versions.modules);
if (manifest.nodeMajor !== nodeMajor || manifest.nodeAbi !== nodeAbi)
  throw new Error(`Node ABI 不匹配：sidecar=${manifest.nodeMajor}/${manifest.nodeAbi} 当前=${nodeMajor}/${nodeAbi}`);

// Confirm this exact Node runtime can load the ABI-matched native dependency.
const Database = require('better-sqlite3');
const probe = new Database(':memory:');
probe.prepare('select 1 as ok').get();
probe.close();
const sqliteRoot = dirname(dirname(require.resolve('better-sqlite3')));
const sqliteRequire = createRequire(require.resolve('better-sqlite3'));
const bindingsEntry = sqliteRequire.resolve('bindings');
const bindingsRoot = dirname(bindingsEntry);
const fileUriRoot = dirname(createRequire(bindingsEntry).resolve('file-uri-to-path'));
const sqliteBinding = join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(sqliteBinding)) throw new Error(`缺少 Node ABI ${nodeAbi} 的 better-sqlite3 原生绑定：${sqliteBinding}`);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
cpSync(process.execPath, join(target, 'node.exe'));
const modules = join(target, 'node_modules');
mkdirSync(modules, { recursive: true });
for (const [name, root] of [
  ['better-sqlite3', sqliteRoot],
  ['bindings', bindingsRoot],
  ['file-uri-to-path', fileUriRoot],
]) cpSync(root, join(modules, name), { recursive: true, dereference: true });
const stagedManifest = { ...manifest, nodeMajor, nodeAbi };
writeFileSync(join(target, 'sidecar-manifest.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`);

const smoke = spawnSync(join(target, 'node.exe'), ['-e', "const D=require('better-sqlite3');const d=new D(':memory:');if(d.prepare('select 1 as ok').get().ok!==1)process.exit(2);d.close()"], {
  cwd: target,
  encoding: 'utf8',
});
if (smoke.status !== 0) throw new Error(`staged Node/better-sqlite3 smoke failed: ${smoke.stderr || smoke.stdout}`);
console.log(`[tauri-sidecar] staged node=${nodeMajor}/${nodeAbi} native=${statSync(join(modules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')).size} bytes → ${target}`);
