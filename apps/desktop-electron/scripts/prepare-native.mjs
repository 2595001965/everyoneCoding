/**
 * 为 Electron 主进程准备原生模块绑定（better-sqlite3）。
 *
 * 背景：`better-sqlite3` 是 ABI 相关的原生模块。仓库里 Node 侧（vitest）用的是
 * Node ABI 版本，而 Electron 内置的 Node 版本不同（Electron 33 → Node 20.18 → ABI 130），
 * 两者不能共用同一个 `.node` 文件。直接把 Node 版替换掉会连带弄坏全仓单测基线。
 *
 * 解决方式（两套共存，互不影响）：
 * - Node 侧继续用 `node_modules/.pnpm/better-sqlite3@<版本>/…/build/Release/better_sqlite3.node`；
 * - Electron 侧把 Electron ABI 的绑定放到 `apps/desktop-electron/build/Release/`。
 *   esbuild 会把 better-sqlite3 的 JS 内联进主进程产物，`bindings` 的 module_root
 *   因此解析为应用根目录 —— 该路径正是它的候选之一（目录已在 .gitignore 的 `build/` 内）。
 *
 * 用法：node scripts/prepare-native.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const bindingDir = join(appRoot, 'build', 'Release');
const bindingFile = join(bindingDir, 'better_sqlite3.node');
const abiStamp = join(appRoot, 'build', '.electron-abi');

/**
 * 优先国内镜像，失败回退 GitHub（发布产物在 WiseLibs/better-sqlite3 releases）。
 * 两处的目录/tag 段都是 `v<版本>`，而文件名是 `<包名>-v<版本>-electron-v<abi>-<平台>-<架构>.tar.gz`。
 */
const MIRRORS = [
  (version, name, abi) => `https://registry.npmmirror.com/-/binary/better-sqlite3/v${version}/${name}-electron-v${abi}-win32-x64.tar.gz`,
  (version, name, abi) => `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${name}-electron-v${abi}-win32-x64.tar.gz`,
];

function electronBin() {
  // 通过 workspace 的 node_modules 解析 electron 包（pnpm 会软链到 .pnpm 实际目录）
  const pkgJson = join(appRoot, 'node_modules', 'electron', 'package.json');
  if (!existsSync(pkgJson)) throw new Error('未找到 electron 依赖，请先执行 pnpm install');
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  const distDir = join(dirname(pkgJson), 'dist');
  if (!existsSync(distDir)) {
    throw new Error(
      'Electron 二进制缺失（pnpm 默认阻止其安装脚本）。请先执行：\n' +
        '  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm rebuild electron\n' +
        '或在仓库根设置 ELECTRON_MIRROR 后重装依赖。',
    );
  }
  const exe = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  return { version: pkg.version, path: join(distDir, exe) };
}

/** 以 ELECTRON_RUN_AS_NODE 模式让 Electron 自报 ABI 号，避免硬编码版本映射表。 */
function detectAbi(exePath) {
  const out = execFileSync(exePath, ['-p', 'process.versions.modules'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const abi = Number(out.trim());
  if (!Number.isInteger(abi) || abi <= 0) throw new Error(`无法解析 Electron ABI：${out}`);
  return abi;
}

function download(url, dest) {
  const script = `const fs=require('fs');(async()=>{const r=await fetch(process.argv[1]);if(!r.ok)throw new Error('HTTP '+r.status);fs.writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()));})().catch(e=>{console.error(e.message);process.exit(1)});`;
  execFileSync(process.execPath, ['-e', script, url, dest], { stdio: ['ignore', 'inherit', 'inherit'] });
}

function main() {
  const { version, path: exe } = electronBin();
  const abi = detectAbi(exe);

  const stampOk = existsSync(abiStamp) && readFileSync(abiStamp, 'utf8').trim() === String(abi);
  if (existsSync(bindingFile) && stampOk) {
    console.log(`[native] better-sqlite3 Electron 绑定已就绪（electron ${version} / ABI ${abi}）`);
    return;
  }

  const bs3Pkg = JSON.parse(readFileSync(join(appRoot, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8'));
  const bs3Version = bs3Pkg.version;
  const name = `better-sqlite3-v${bs3Version}`;
  const tmpTgz = join(appRoot, 'build', 'better-sqlite3-electron.tgz');

  mkdirSync(bindingDir, { recursive: true });
  console.log(`[native] 获取 better-sqlite3 ${bs3Version} 的 Electron 绑定（ABI ${abi}）…`);

  let lastError;
  for (const build of MIRRORS) {
    const url = build(bs3Version, name, abi);
    try {
      download(url, tmpTgz);
      // 覆盖前先删旧文件：Windows 下正在被运行中的 Electron 占用时 tar 会报
      // "File exists"；先删能给出更清晰的状态（占用时会在此处报 EBUSY）。
      rmSync(bindingFile, { force: true });
      // 注意：必须用**相对路径**并指定 cwd。Git for Windows 自带的 GNU tar 会把
      // 绝对路径里的盘符（D:\…）误判为 `host:path` 远程语法而报
      // "Cannot connect to D: resolve failed"；相对路径可完全规避该问题。
      execFileSync('tar', ['-xzf', 'build/better-sqlite3-electron.tgz', 'build/Release/better_sqlite3.node'], {
        cwd: appRoot,
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      console.log(`[native] 镜像失败，尝试下一个：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  rmSync(tmpTgz, { force: true });

  if (lastError || !existsSync(bindingFile)) {
    throw new Error(
      `无法获取 Electron ABI ${abi} 的 better-sqlite3 预编译绑定。\n` +
        '可改用源码编译（需 MSVC C++ 生成工具）：\n' +
        `  cd node_modules/.pnpm/better-sqlite3@${bs3Version}/node_modules/better-sqlite3\n` +
        `  npx prebuild-install --runtime=electron --target=${version} --arch=x64 --platform=win32\n` +
        '  然后把 build/Release/better_sqlite3.node 复制到 apps/desktop-electron/build/Release/',
    );
  }

  writeFileSync(abiStamp, String(abi));
  console.log(`[native] 完成 → build/Release/better_sqlite3.node（electron ${version} / ABI ${abi}）`);
}

main();
