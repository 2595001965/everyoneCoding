/**
 * Electron 形态开发启动器。
 *
 * 相比直接 `electron .`，它处理三件容易踩坑的事：
 *
 * 1. **原生模块 ABI**：先确保 better-sqlite3 的 Electron 绑定就绪（见 prepare-native.mjs）。
 * 2. **ELECTRON_RUN_AS_NODE 污染**：若在 WorkBuddy / VS Code 等自身基于 Electron 的宿主终端里
 *    执行，环境里可能带有 `ELECTRON_RUN_AS_NODE=1`。该变量会让 electron.exe 退化成纯 Node 进程
 *    （`require('electron')` 只返回包路径字符串，`app` 为 undefined），必须移除后再启动。
 * 3. **无 GPU 的宿主环境**：此类嵌入宿主常无 GPU 访问权限，Electron 的 GPU 进程会反复崩溃并
 *    以 `GPU process isn't usable. Goodbye.` 退出。两层兜底：
 *    a) 启发式：检测到嵌入宿主特征时，直接加软件渲染开关；
 *    b) 失败重试：首轮启动若出现 GPU 崩溃特征，自动带软件渲染开关再启一次。
 *    只有 a) 是不够的 —— 从普通终端（独立 cmd、双击 .bat）启动时环境里没有任何嵌入宿主特征，
 *    但 GPU 依然可能不可用（远程会话、驱动异常、虚拟机等），那种情形只有 b) 能救回来。
 *
 * 环境变量：
 * - `EC_ELECTRON_FLAGS`：追加自定义 Chromium 开关（空格分隔）。
 * - `EC_ELECTRON_HEADLESS=1`：强制软件渲染（即使未检测到嵌入宿主），可跳过首次尝试。
 * - `EC_ELECTRON_DEVTOOLS=1`：启动即自动弹出 DevTools。默认不弹——DevTools 前端会往控制台
 *   吐若干与应用无关的告警（`Unknown VE context`、`Autofill.enable wasn't found`），
 *   容易淹没真正的启动日志；开发模式下 Ctrl+Shift+I 仍可随时打开。
 *
 * 用法：node scripts/dev.mjs [传给 Electron 的额外参数]
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeBin = process.execPath;

function run(script) {
  const result = spawnSync(nodeBin, [join(appRoot, 'scripts', script)], { cwd: appRoot, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * 解析 esbuild 可执行文件。
 * esbuild 是显式 devDependency，从其包目录取 `bin/esbuild`（JS 入口），用 node 直接执行，
 * 避免依赖 shell 的 PATH 与平台差异（Windows 下 .cmd 包装器不便于 spawnSync 直调）。
 */
function resolveEsbuild() {
  const require = createRequire(join(appRoot, 'package.json'));
  const pkgJson = require.resolve('esbuild/package.json');
  return join(dirname(pkgJson), 'bin', 'esbuild');
}

function build() {
  const esbuild = resolveEsbuild();
  if (!existsSync(esbuild)) throw new Error('未找到 esbuild，请先执行 pnpm install');
  const targets = [
    ['src/main/index.ts', 'dist/main/index.cjs'],
    ['src/preload/index.ts', 'dist/preload/index.cjs'],
  ];
  for (const [entry, outfile] of targets) {
    const result = spawnSync(
      nodeBin,
      [
        esbuild,
        entry,
        '--bundle',
        '--platform=node',
        '--format=cjs',
        '--external:electron',
        // 包内存在对 import.meta.url 的惰性访问（CJS 下为空值，代码已按此回退），
        // esbuild 会就此发 empty-import-meta 警告，属预期行为，静默以免污染构建输出。
        '--log-override:empty-import-meta=silent',
        `--outfile=${outfile}`,
      ],
      { cwd: appRoot, stdio: 'inherit' },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

/** 嵌入宿主（WorkBuddy / VS Code 等 Electron 应用）通常无 GPU，需软件渲染兜底。 */
function isEmbeddedHost() {
  return process.env['EC_ELECTRON_HEADLESS'] === '1' || process.env['ELECTRON_RUN_AS_NODE'] !== undefined;
}

/** 无 GPU 可用时的软件渲染开关组合（本机实测可稳定起窗口）。 */
const SOFTWARE_RENDER_FLAGS = ['--disable-gpu', '--disable-software-rasterizer', '--no-sandbox'];

/** GPU 进程崩溃时 Electron 会打印这些特征；命中即判定"本环境没有可用 GPU"。 */
const GPU_FAILURE_MARKERS = [
  "GPU process isn't usable",
  'gpu_process_host.cc',
  'GPU process exited unexpectedly',
];

/**
 * 启动 Electron 并转发其输出。
 * stderr 需要在透传的同时做崩溃特征嗅探，故单独 pipe 再手写回 process.stderr。
 */
function launchElectron(exe, flags, env, passthrough) {
  return new Promise((resolve) => {
    const child = spawn(exe, ['.', ...flags, ...passthrough], {
      cwd: appRoot,
      env,
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    let tail = '';
    let gpuFailed = false;
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      // 只保留尾部窗口，避免长时间运行把内存吃满；标记匹配跨 chunk，故留足缓冲。
      tail = (tail + chunk.toString('utf8')).slice(-16384);
      if (!gpuFailed && GPU_FAILURE_MARKERS.some((marker) => tail.includes(marker))) gpuFailed = true;
    });
    child.on('error', (error) => {
      console.error(`[dev] 无法启动 Electron：${error.message}`);
      resolve({ code: 1, gpuFailed });
    });
    child.on('exit', (code) => resolve({ code: code ?? 0, gpuFailed }));
  });
}

async function main() {
  run('prepare-native.mjs');
  build();

  const electronExe = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? join('Electron.app', 'Contents', 'MacOS', 'Electron') : 'electron';
  const exe = join(appRoot, 'node_modules', 'electron', 'dist', electronExe);
  if (!existsSync(exe)) throw new Error(`Electron 二进制缺失：${exe}\n请先设置 ELECTRON_MIRROR 后执行 pnpm rebuild electron`);

  const flags = [];
  if (isEmbeddedHost()) {
    flags.push(...SOFTWARE_RENDER_FLAGS);
    console.log('[dev] 检测到嵌入宿主环境，启用软件渲染');
  }
  const extraFlags = (process.env['EC_ELECTRON_FLAGS'] ?? '').trim().split(/\s+/).filter(Boolean);
  flags.push(...extraFlags);

  // 关键：清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会以纯 Node 模式运行，主进程直接崩。
  const env = { ...process.env };
  delete env['ELECTRON_RUN_AS_NODE'];
  const passthrough = process.argv.slice(2);

  console.log('[dev] 启动 Electron（渲染层需已在 http://localhost:5173 运行）');
  const first = await launchElectron(exe, flags, env, passthrough);
  if (!first.gpuFailed || flags.includes('--disable-gpu')) process.exit(first.code);

  console.warn('[dev] GPU 进程崩溃，改用软件渲染重试（EC_ELECTRON_HEADLESS=1 可跳过首次尝试）');
  const retry = await launchElectron(exe, [...SOFTWARE_RENDER_FLAGS, ...extraFlags], env, passthrough);
  process.exit(retry.code);
}

await main();
