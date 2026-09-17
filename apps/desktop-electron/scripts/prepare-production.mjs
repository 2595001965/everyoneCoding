/**
 * 构建并收集 Electron 安装包运行所需的静态资源。
 * renderer 使用相对资源路径，SQL 迁移与主进程产物一起进入 app.asar。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(appRoot, '..', '..');
const rendererRoot = join(repoRoot, 'apps', 'renderer');
const viteBin = join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js');

if (!existsSync(viteBin)) throw new Error('未找到 Vite，请先执行 pnpm install');

const build = spawnSync(process.execPath, [viteBin, 'build'], {
  cwd: rendererRoot,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const targets = [
  {
    source: join(rendererRoot, 'dist'),
    target: join(appRoot, 'dist', 'renderer'),
  },
  {
    source: join(repoRoot, 'packages', 'data', 'migrations'),
    target: join(appRoot, 'dist', 'migrations'),
  },
];

for (const { source, target } of targets) {
  if (!existsSync(source)) throw new Error(`生产资源不存在：${source}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
}

const nativeSource = join(appRoot, 'build', 'Release', 'better_sqlite3.node');
const nativeTarget = join(appRoot, 'dist', 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(nativeSource)) {
  throw new Error('Electron 原生绑定不存在，请先运行 node scripts/prepare-native.mjs');
}
mkdirSync(dirname(nativeTarget), { recursive: true });
cpSync(nativeSource, nativeTarget);

const sourcePackage = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
writeFileSync(
  join(appRoot, 'dist', 'package.json'),
  `${JSON.stringify(
    {
      name: sourcePackage.name,
      version: sourcePackage.version,
      description: sourcePackage.description,
      author: 'EveryoneCoding',
      private: true,
      main: 'main/index.cjs',
    },
    null,
    2,
  )}\n`,
);

console.log('[production] renderer 与数据库迁移资源已复制到 dist');
