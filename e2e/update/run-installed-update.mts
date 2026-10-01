/**
 * 真实安装包上的更新演练（FR-SET-05 验收）：本地静态更新源 + 已安装的旧版 → 新版。
 *
 * 不是 vitest 用例（要装卸真实安装包、拉起 GUI 进程、等安装器重启应用，单轮一两分钟），
 * 由人在打包之后手动跑；结论以应用自己写的 `update-e2e.log`（JSON Lines）为准，脚本只做判定与汇总。
 *
 * 前置：`--artifacts` 目录里有两个版本、两种形态的安装包（Tauri 的要带 .sig），做法见 docs/RELEASE.md §6。
 * Tauri 包必须是"演练构建"（构建时合并了 dangerousInsecureTransportProtocol，才能连 http://127.0.0.1）。
 *
 *   node --experimental-strip-types e2e/update/run-installed-update.mts \
 *     --artifacts C:\Users\me\AppData\Local\Temp\ec-release\artifacts --old 0.1.0 --new 0.1.1 \
 *     [--shell electron|tauri|both] [--scenario happy,rollback,signature,truncate,network]
 *
 * 场景：
 *   happy     旧版启动 → 检查 → 下载校验 → 安装器重启 → 新版启动并落定健康
 *   rollback  新版被标成"启动即崩"（演练指令 unhealthyVersions）→ 第二次启动判定回滚 →
 *             重跑留档的旧版安装包 → 旧版启动并确认 rolled-back
 *   signature 更新源给出错误签名（Tauri：换成别的文件的 .sig；Electron：安装包被篡改 → sha512 不符）
 *   truncate  更新源上的安装包只有一半（半包）
 *   network   更新源不可达
 * 失败场景都要求：上报归类正确、**没有**安装、旧版照常可用。
 */

/* eslint-disable no-console -- 命令行演练脚本，输出即结果 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildRelease } from '../../ci/make-release.mts';
import { startFeedServer, type FeedServer } from '../../ci/update-feed-server.mts';

type ShellKind = 'electron' | 'tauri';
type Scenario = 'happy' | 'rollback' | 'signature' | 'truncate' | 'network';

const argv = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] !== undefined ? (argv[index + 1] as string) : fallback;
};
const artifacts = path.resolve(
  arg('--artifacts', path.join(os.tmpdir(), 'ec-release', 'artifacts')),
);
const OLD = arg('--old', '0.1.0');
const NEW = arg('--new', '0.1.1');
const shells: ShellKind[] =
  arg('--shell', 'both') === 'both' ? ['electron', 'tauri'] : [arg('--shell', 'both') as ShellKind];
const scenarios = arg('--scenario', 'happy,rollback,signature,truncate,network').split(
  ',',
) as Scenario[];
const work = path.resolve(arg('--work', path.join(os.tmpdir(), 'ec-update-e2e')));
const LOCAL = process.env['LOCALAPPDATA'] ?? '';
const ROAMING = process.env['APPDATA'] ?? '';

const installer = (shell: ShellKind, version: string): string =>
  shell === 'tauri'
    ? `EveryoneCoding_${version}_x64-setup.exe`
    : `EveryoneCoding-${version}-x64-setup.exe`;

interface ShellLayout {
  installDir: string;
  exe: () => string;
  dataDir: string;
  backupDir: string;
  env: Record<string, string>;
}

function layout(shell: ShellKind, feedUrl: string): ShellLayout {
  const installDir = path.join(work, `${shell}-app`);
  if (shell === 'electron') {
    // 不能用 EC_ELECTRON_USER_DATA_DIR 重定向：NSIS 装完是经 Shell 以当前用户身份拉起应用的
    // （ExecShellAsUser），进程级环境变量传不到重启后的新版本（实测）。用应用的默认 userData。
    return {
      installDir,
      exe: () => path.join(installDir, 'EveryoneCoding.exe'),
      dataDir: path.join(ROAMING, '@ec', 'desktop-electron', 'data'),
      backupDir: path.join(LOCAL, 'EveryoneCoding-updates', 'electron'),
      env: { EC_UPDATE_URL: `${feedUrl}/` },
    };
  }
  return {
    installDir,
    exe: () => {
      const found = fs
        .readdirSync(installDir)
        .find((name) => name.endsWith('.exe') && !/uninstall/i.test(name));
      if (found === undefined) throw new Error(`安装目录里没有主程序：${installDir}`);
      return path.join(installDir, found);
    },
    // Tauri 的数据目录 = app_data_dir（按 identifier），不能重定向
    dataDir: path.join(ROAMING, 'com.everyonecoding.desktop'),
    backupDir: path.join(LOCAL, 'EveryoneCoding-updates', 'tauri'),
    env: { EC_UPDATE_URL: `${feedUrl}/latest.json` },
  };
}

const E2E_FILES = [
  'update-e2e.json',
  'update-e2e.log',
  'update-runtime.json',
  'update-settings.json',
];

function killApps(): void {
  for (const image of ['EveryoneCoding.exe', 'everyone-coding.exe']) {
    spawnSync('taskkill', ['/F', '/T', '/IM', image], { stdio: 'ignore' });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uninstall(target: ShellLayout): Promise<void> {
  killApps();
  if (fs.existsSync(target.installDir)) {
    const uninstaller = fs
      .readdirSync(target.installDir)
      .find((name) => /uninstall.*\.exe$/i.test(name));
    if (uninstaller !== undefined) {
      spawnSync(path.join(target.installDir, uninstaller), ['/S'], { stdio: 'ignore' });
    }
    // NSIS 卸载器会把自己复制到临时目录后异步删除，目录要等它放手
    for (let attempt = 0; attempt < 30 && fs.existsSync(target.installDir); attempt += 1) {
      try {
        fs.rmSync(target.installDir, { recursive: true, force: true });
      } catch {
        await sleep(1000);
      }
    }
  }
  fs.rmSync(target.backupDir, { recursive: true, force: true });
  // electron-updater 会复用上一轮已校验过的 pending 安装包而不重新下载（正确行为），
  // 故障注入场景必须从空缓存开始，否则根本不会去碰被注入故障的文件
  fs.rmSync(path.join(LOCAL, '@ecdesktop-electron-updater'), { recursive: true, force: true });
  for (const name of E2E_FILES) fs.rmSync(path.join(target.dataDir, name), { force: true });
}

function install(shell: ShellKind, target: ShellLayout, version: string): void {
  const setup = path.join(artifacts, installer(shell, version));
  // NSIS：/S 静默，/D= 必须是最后一个参数且不加引号
  const result = spawnSync(setup, ['/S', `/D=${target.installDir}`], {
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  });
  if (result.status !== 0) throw new Error(`安装 ${setup} 失败（exit ${result.status}）`);
  killApps(); // 部分 NSIS 模板装完会自动启动
}

function launch(target: ShellLayout): void {
  const child = spawn(target.exe(), [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...target.env },
  });
  child.unref();
}

interface LogLine {
  version: string;
  event?: { type: string; kind?: string; toVersion?: string; version?: string; error?: string };
  boot?: { decision: string };
  simulate?: string;
}

function readLog(target: ShellLayout): LogLine[] {
  const file = path.join(target.dataDir, 'update-e2e.log');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogLine);
}

async function waitFor(
  target: ShellLayout,
  what: string,
  predicate: (lines: LogLine[]) => boolean,
  timeoutMs = 240_000,
): Promise<LogLine[]> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const lines = readLog(target);
    if (predicate(lines)) return lines;
    await sleep(1000);
  }
  throw new Error(
    `等待超时：${what}\n日志：\n${readLog(target)
      .map((line) => JSON.stringify(line))
      .join('\n')}`,
  );
}

function prepareFeed(shell: ShellKind, feedDir: string, feedUrl: string): void {
  fs.rmSync(feedDir, { recursive: true, force: true });
  fs.mkdirSync(feedDir, { recursive: true });
  const copy = (name: string): void => {
    const source = path.join(artifacts, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(feedDir, name));
  };
  copy(installer(shell, NEW));
  copy(`${installer(shell, NEW)}.sig`);
  copy(`${installer(shell, NEW)}.blockmap`);
  // 差分下载要用"当前已装版本"的 blockmap
  copy(`${installer(shell, OLD)}.blockmap`);
  const result = buildRelease({
    dir: feedDir,
    version: NEW,
    baseUrl: feedUrl,
    enforceBudget: false,
  });
  if (result.problems.length > 0)
    throw new Error(`更新源清单生成失败：${result.problems.join('；')}`);
}

function writeDirective(target: ShellLayout, directive: Record<string, unknown>): void {
  fs.mkdirSync(target.dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(target.dataDir, 'update-e2e.json'),
    JSON.stringify(directive, null, 2),
  );
}

const events = (lines: LogLine[]): Array<NonNullable<LogLine['event']> & { at: string }> =>
  lines
    .filter((line) => line.event !== undefined)
    .map((line) => ({ ...line.event!, at: line.version }));

async function runScenario(
  shell: ShellKind,
  scenario: Scenario,
  server: FeedServer,
  feedDir: string,
): Promise<string> {
  const target = layout(shell, scenario === 'network' ? 'http://127.0.0.1:9' : server.url);
  await uninstall(target);
  prepareFeed(shell, feedDir, server.url);
  server.clearFaults();
  install(shell, target, OLD);
  const backup = path.join(target.backupDir, installer(shell, OLD));
  if (!fs.existsSync(backup)) throw new Error(`NSIS 钩子没有留档旧版安装包：${backup}`);

  if (scenario === 'signature') {
    if (shell === 'tauri') {
      // 签名本身合法，但签的是另一个文件（旧版安装包）→ 客户端 minisign 验签必须失败
      const latest = JSON.parse(fs.readFileSync(path.join(feedDir, 'latest.json'), 'utf8'));
      const wrong = fs
        .readFileSync(path.join(artifacts, `${installer(shell, OLD)}.sig`), 'utf8')
        .trim();
      for (const key of Object.keys(latest.platforms)) latest.platforms[key].signature = wrong;
      fs.writeFileSync(path.join(feedDir, 'latest.json'), JSON.stringify(latest, null, 2));
    } else {
      server.setFault(new RegExp(`${NEW.replace(/\./g, '\\.')}-x64-setup\\.exe$`), 'corrupt');
    }
  }
  if (scenario === 'truncate')
    server.setFault(new RegExp(`${NEW.replace(/\./g, '\\.')}_?-?x64-setup\\.exe$`), 'truncate');

  writeDirective(target, {
    autoInstall: true,
    healthyAfterMs: 3000,
    ...(scenario === 'rollback' ? { unhealthyVersions: [NEW] } : {}),
  });
  launch(target);

  if (scenario === 'happy') {
    const lines = await waitFor(target, `${NEW} 启动并落定健康`, (all) =>
      all.some((line) => line.version === NEW && line.event?.type === 'health-marked'),
    );
    // 旧版进程交给安装器时即退出，最后几行日志可能来不及写；台账是否带过来以新版的启动判定为准：
    // allow = 新版读到了旧版在退出前落盘的 pending-healthy
    const boot = lines.find((line) => line.version === NEW && line.boot !== undefined);
    if (boot?.boot?.decision !== 'allow') {
      throw new Error(`新版启动判定应为 allow（读到待确认台账），实际 ${boot?.boot?.decision}`);
    }
    killApps();
    return `${OLD} → ${NEW} 检查/下载/校验/重启成功，新版启动判定 allow 并健康落定；留档 ${path.basename(backup)} 就位`;
  }

  if (scenario === 'rollback') {
    await waitFor(target, `${NEW} 首次启动（模拟崩溃）`, (all) =>
      all.some((line) => line.version === NEW && line.simulate === 'crash'),
    );
    await sleep(3000);
    killApps();
    // 用户再次打开应用：第二次启动 → 台账判定回滚 → 重跑留档的旧版安装包
    launch(target);
    const lines = await waitFor(target, `回滚到 ${OLD} 并确认`, (all) =>
      all.some((line) => line.version === OLD && line.event?.type === 'rollback-done'),
    );
    const decision = lines.find(
      (line) => line.version === NEW && line.boot?.decision === 'rollback',
    );
    if (decision === undefined) throw new Error('第二次启动没有判定回滚');
    killApps();
    return `${NEW} 连续两次未落定健康 → 判定回滚 → 重跑留档安装包 → ${OLD} 启动并确认 rolled-back`;
  }

  const expected: Record<Exclude<Scenario, 'happy' | 'rollback'>, string[]> = {
    signature: shell === 'tauri' ? ['signature'] : ['integrity'],
    truncate: shell === 'tauri' ? ['signature', 'integrity', 'network'] : ['integrity', 'network'],
    network: ['network', 'offline'],
  };
  const lines = await waitFor(
    target,
    `${scenario} 失败被上报`,
    (all) =>
      events(all).some((event) => event.type === 'install-failed' || event.type === 'check-failed'),
    120_000,
  );
  const failure = events(lines).find(
    (event) => event.type === 'install-failed' || event.type === 'check-failed',
  )!;
  if (!expected[scenario].includes(failure.kind ?? '')) {
    throw new Error(
      `归类不对：期望 ${expected[scenario].join('/')}，实际 ${failure.kind}（${failure.error}）`,
    );
  }
  await sleep(3000);
  if (readLog(target).some((line) => line.version === NEW))
    throw new Error('失败场景居然装上了新版本');
  killApps();
  return `上报 ${failure.type}/${failure.kind}（${failure.error}），未安装，${OLD} 照常可用`;
}

async function main(): Promise<void> {
  fs.mkdirSync(work, { recursive: true });
  const feedDir = path.join(work, 'feed');
  fs.mkdirSync(feedDir, { recursive: true });
  const server = await startFeedServer({ dir: feedDir });
  const results: Array<{ shell: ShellKind; scenario: Scenario; ok: boolean; detail: string }> = [];
  try {
    for (const shell of shells) {
      for (const scenario of scenarios) {
        process.stdout.write(`[${shell}] ${scenario} … `);
        try {
          const detail = await runScenario(shell, scenario, server, feedDir);
          results.push({ shell, scenario, ok: true, detail });
          console.log(`PASS  ${detail}`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          results.push({ shell, scenario, ok: false, detail });
          console.log(`FAIL  ${detail}`);
          killApps();
        }
      }
      await uninstall(layout(shell, server.url));
    }
  } finally {
    await server.close();
  }
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(results, null, 2));
  console.log(
    `\n结果：${results.filter((item) => item.ok).length}/${results.length} 通过（明细 ${path.join(work, 'result.json')}）`,
  );
  if (results.some((item) => !item.ok)) process.exit(1);
}

await main();
