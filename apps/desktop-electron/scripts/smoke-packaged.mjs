/** 启动 unpacked 应用，验证 renderer、主进程数据库和生产资源可用。 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const executable = join(appRoot, 'release', 'win-unpacked', 'EveryoneCoding.exe');
if (!existsSync(executable)) throw new Error(`未找到 unpacked 应用：${executable}`);

const userData = mkdtempSync(join(tmpdir(), 'ec-electron-smoke-'));
const env = {
  ...process.env,
  EC_ELECTRON_USER_DATA_DIR: userData,
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(executable, ['--disable-gpu', '--no-sandbox', '--remote-debugging-port=9333'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString('utf8');
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString('utf8');
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  let page = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (child.exitCode !== null) break;
    await delay(500);
    try {
      const response = await fetch('http://127.0.0.1:9333/json/list');
      const targets = await response.json();
      page = targets.find((target) => target.type === 'page') ?? null;
      if (page?.title === 'EveryoneCoding') break;
    } catch {
      // Chromium 调试端口还未就绪。
    }
  }

  if (!page) throw new Error(`未发现 Electron 页面调试目标。\n${output}`);
  if (page.title !== 'EveryoneCoding')
    throw new Error(`renderer 未完成加载，页面标题为：${page.title}`);
  if (!/app\.asar\/renderer\/index\.html/.test(page.url)) {
    throw new Error(`加载了错误页面：${page.url}`);
  }
  if (/主进程 AI 栈未装配|ERR_|Uncaught|Cannot find module/.test(output)) {
    throw new Error(`启动日志包含错误或 AI 栈降级。\n${output}`);
  }

  const database = join(userData, 'data', 'everyonecoding.sqlite');
  if (!existsSync(database)) throw new Error(`启动后未创建本地数据库：${database}`);
  console.log(`[smoke] 页面=${page.title} URL=${page.url}`);
  console.log(`[smoke] 数据库=${database}`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3_000)]);
  }
  await delay(1_000);
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
