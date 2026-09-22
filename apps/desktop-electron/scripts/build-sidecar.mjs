import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

/**
 * 构建 Tauri 形态的业务运行时侧车（受控 sidecar）。
 *
 * 产物：
 * - `dist/sidecar/everyone-coding-sidecar.cjs` —— 自包含 bundle（`better-sqlite3` 保持 external）
 * - `dist/sidecar/migrations/` —— SQLite 迁移（bundle 不含，但运行时必须有）
 * - `dist/sidecar/sidecar-manifest.json` —— 供 Rust 宿主在做**升级兼容**判定时读取
 *
 * 关于 `better-sqlite3` 为什么必须是 external：它是原生模块（`.node`），
 * esbuild 无法把它打进 JS。这也意味着**侧车与 Node 运行时 ABI 必须匹配**——
 * 仓库里已同时存在 Node 侧（ABI 137）与 Electron 侧（ABI 130）两套绑定，
 * 侧车用的是 Node 侧那一套（见 `package.json` 的 `prepare:native`）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const repoRoot = join(packageRoot, '..', '..');
const outDir = join(packageRoot, 'dist', 'sidecar');
const entry = join(packageRoot, 'src', 'sidecar', 'index.ts');
const migrationsSrc = join(repoRoot, 'packages', 'data', 'migrations');

/**
 * 协议版本必须与 `src/sidecar/protocol.ts` 一致。
 *
 * 这里**从源码里读**而不是再写一个常量：两个地方各写一份必然漂移，
 * 而漂移的后果是宿主与侧车握手失败、Tauri 形态整体不可用——
 * 属于"发版才发现"的故障。读不到就直接构建失败。
 */
function readProtocolVersion() {
  const source = readFileSync(join(packageRoot, 'src', 'sidecar', 'protocol.ts'), 'utf8');
  const match = /export const PROTOCOL_VERSION = (\d+)/.exec(source);
  if (!match) {
    throw new Error('无法从 src/sidecar/protocol.ts 读取 PROTOCOL_VERSION（正则失配）');
  }
  return Number(match[1]);
}

async function build() {
  if (!existsSync(entry)) throw new Error(`侧车入口不存在：${entry}`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: join(outDir, 'everyone-coding-sidecar.cjs'),
    // 原生模块与宿主注入的全局不打包
    external: ['better-sqlite3', 'electron'],
    logOverride: { 'empty-import-meta': 'silent' },
    sourcemap: false,
    metafile: true,
    logLevel: 'warning',
  });

  // 迁移目录必须随产物走：侧车自己找不到它会直接拒绝启动
  if (!existsSync(join(migrationsSrc, '0001_init.sql'))) {
    throw new Error(`迁移目录不完整（缺 0001_init.sql）：${migrationsSrc}`);
  }
  cpSync(migrationsSrc, join(outDir, 'migrations'), { recursive: true });

  const protocol = readProtocolVersion();
  const bundle = join(outDir, 'everyone-coding-sidecar.cjs');
  const manifest = {
    protocol,
    runtime: 'everyone-coding-sidecar',
    entry: 'everyone-coding-sidecar.cjs',
    // 宿主据此判断"这个侧车产物是否需要宿主提供 DPAPI 能力"
    hostCapabilities: ['secure.encrypt', 'secure.decrypt', 'shell.openExternal', 'clipboard.writeText'],
    // 侧车要求的 Node 主版本（better-sqlite3 的 ABI 与之绑定）
    nodeMajor: 22,
    migrations: 'migrations',
  };
  writeFileSync(join(outDir, 'sidecar-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const sizeKb = Math.round(statSync(bundle).size / 1024);
  // 模块计数进日志：体积门禁（RELEASE §2）看的只是安装包总大小，
  // 侧车 bundle 的构成要单独盯——它每涨 1MB 都直接进 Tauri 安装包。
  const moduleCount = Object.keys(result.metafile?.inputs ?? {}).length;
  console.log(
    `[sidecar] 产物就绪 protocol=${protocol} bundle=${sizeKb}KB modules=${moduleCount} → ${relative(repoRoot, outDir)}`,
  );
}

await build();
