/**
 * Electron 更新宿主 × **真实 electron-updater**（NsisUpdater）× 本机静态更新源。
 *
 * 不 mock 更新库：检查、blockmap 差分下载、sha512 校验、Authenticode 发布者校验、
 * 拉起安装器的参数，全是 electron-updater 自己的代码在跑。只替换两处"必须有 Electron 才能跑"的东西：
 * - HTTP 执行器：`ElectronHttpExecutor` 依赖 `electron.net`，换成 Node `http` 实现（同一基类）；
 * - `quitAndInstall` 之后对 `require('electron').autoUpdater` 的一次 emit：拦截成空事件源。
 * 安装器本身不真的执行（`spawnLog` 记录参数），真实安装与重启见 `e2e/update/`。
 */

import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, NsisUpdater } from 'electron-updater';

import { classifyUpdateError } from '@ec/core';

/**
 * 本地静态更新源（`ci/update-feed-server.mts`）。本包 tsconfig 不开 allowImportingTsExtensions，
 * 故按运行时路径动态加载，类型只声明用到的部分。
 */
interface FeedServer {
  url: string;
  requests: Array<{ path: string; range: string | null }>;
  setFault(pattern: RegExp, fault: 'truncate' | 'drop' | 'stall' | 'corrupt' | '500' | null): void;
  clearFaults(): void;
  close(): Promise<void>;
}
const FEED_SERVER_MODULE = '../../../../../../ci/update-feed-server.mts';
async function startFeedServer(options: { dir: string }): Promise<FeedServer> {
  const mod = (await import(/* @vite-ignore */ FEED_SERVER_MODULE)) as {
    startFeedServer(options: { dir: string }): Promise<FeedServer>;
  };
  return mod.startFeedServer(options);
}
import {
  createElectronUpdaterHost,
  type ElectronUpdaterHost,
  type NsisUpdaterLike,
} from '../electron-updater-host';

const nodeRequire = createRequire(import.meta.url);
const updaterRequire = createRequire(nodeRequire.resolve('electron-updater'));
const runtime = updaterRequire('builder-util-runtime') as {
  HttpExecutor: new () => object;
  configureRequestUrl(url: URL, options: object): void;
  configureRequestOptions(options: object): void;
};

interface ExecutorBase {
  createRequest(
    options: http.RequestOptions,
    callback: (res: http.IncomingMessage) => void,
  ): unknown;
  doDownload(requestOptions: object, options: object, redirectCount: number): void;
}

/**
 * 与 `ElectronHttpExecutor` 逐行对应：同一个 HttpExecutor 基类、同一套 `doDownload`
 * （sha512 校验、进度、重定向都在基类里），只把 `electron.net.request` 换成 Node `http.request`。
 */
class NodeHttpExecutor extends (runtime.HttpExecutor as unknown as new () => ExecutorBase) {
  override createRequest(
    options: http.RequestOptions,
    callback: (res: http.IncomingMessage) => void,
  ) {
    return http.request(options, callback);
  }

  async download(
    url: URL,
    destination: string,
    options: {
      headers?: object;
      cancellationToken: {
        createPromise: <T>(
          fn: (
            resolve: (v: T) => void,
            reject: (e: Error) => void,
            onCancel: (h: () => void) => void,
          ) => void,
        ) => Promise<T>;
      };
    },
  ): Promise<string> {
    return options.cancellationToken.createPromise<string>((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers ?? undefined };
      runtime.configureRequestUrl(url, requestOptions);
      runtime.configureRequestOptions(requestOptions);
      this.doDownload(
        requestOptions,
        {
          destination,
          options,
          onCancel,
          callback: (error: Error | null) => (error == null ? resolve(destination) : reject(error)),
          responseHandler: null,
        },
        0,
      );
    });
  }
}

/** electron-builder 自带的 app-builder：用它生成与正式打包完全相同的 .blockmap。 */
const APP_BUILDER = (() => {
  const builderLib = createRequire(nodeRequire.resolve('electron-builder/package.json'));
  const binRequire = createRequire(builderLib.resolve('app-builder-lib/package.json'));
  return path.join(
    path.dirname(binRequire.resolve('app-builder-bin/package.json')),
    'win',
    'x64',
    'app-builder.exe',
  );
})();

function sha512(file: string): string {
  return createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function writeBlockmap(file: string): void {
  execFileSync(APP_BUILDER, ['blockmap', '--input', file, '--output', `${file}.blockmap`]);
}

function writeLatestYml(feedDir: string, version: string, file: string): void {
  const full = path.join(feedDir, file);
  const hash = sha512(full);
  const size = fs.statSync(full).size;
  fs.writeFileSync(
    path.join(feedDir, 'latest.yml'),
    [
      `version: ${version}`,
      'files:',
      `  - url: ${file}`,
      `    sha512: ${hash}`,
      `    size: ${size}`,
      `path: ${file}`,
      `sha512: ${hash}`,
      `releaseDate: '2026-09-30T00:00:00.000Z'`,
      `releaseNotes: 修复更新流程`,
      '',
    ].join('\n'),
  );
}

let root: string;
let feedDir: string;
let server: FeedServer;
let oldInstaller: Buffer;
let spawned: Array<{ cmd: string; args: string[] }>;
let quitCalls: number;

/** 拦截 electron-updater 在 quitAndInstall 之后对 `require('electron')` 的访问。 */
const Module = nodeRequire('node:module') as { _load: (...args: unknown[]) => unknown };
const originalLoad = Module._load;

beforeAll(async () => {
  Module._load = function patched(this: unknown, ...args: unknown[]) {
    if (args[0] === 'electron') return { autoUpdater: new EventEmitter() };
    return originalLoad.apply(this, args);
  };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-updater-'));
  feedDir = path.join(root, 'feed');
  fs.mkdirSync(feedDir, { recursive: true });

  // 旧版安装包（本机已装版本，由 NSIS 留在 updater 缓存目录）与新版：新版只改了中间 64KB
  oldInstaller = randomBytes(4 * 1024 * 1024);
  const newInstaller = Buffer.from(oldInstaller);
  randomBytes(64 * 1024).copy(newInstaller, 2 * 1024 * 1024);

  const oldName = 'EveryoneCoding-0.1.0-x64-setup.exe';
  const newName = 'EveryoneCoding-0.1.1-x64-setup.exe';
  fs.writeFileSync(path.join(feedDir, oldName), oldInstaller);
  fs.writeFileSync(path.join(feedDir, newName), newInstaller);
  writeBlockmap(path.join(feedDir, oldName));
  writeBlockmap(path.join(feedDir, newName));
  fs.rmSync(path.join(feedDir, oldName));
  writeLatestYml(feedDir, '0.1.1', newName);

  server = await startFeedServer({ dir: feedDir });
});

afterAll(async () => {
  Module._load = originalLoad;
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

interface Harness {
  host: ElectronUpdaterHost;
  updater: NsisUpdater;
  cacheDir: string;
  logs: string[];
}

function createHarness(
  options: {
    publisherName?: string;
    seedInstalled?: boolean;
    feedUrl?: string;
    appVersion?: string;
  } = {},
): Harness {
  const appDir = fs.mkdtempSync(path.join(root, 'app-'));
  const baseCachePath = path.join(appDir, 'cache');
  const cacheDir = path.join(baseCachePath, 'everyonecoding-updater');
  fs.mkdirSync(cacheDir, { recursive: true });
  if (options.seedInstalled !== false) {
    // NSIS 安装时把自身安装包存为 installer.exe（electron-builder 模板行为），差分以它为旧文件
    fs.writeFileSync(path.join(cacheDir, 'installer.exe'), oldInstaller);
  }
  const configPath = path.join(appDir, 'app-update.yml');
  fs.writeFileSync(
    configPath,
    [
      'provider: generic',
      `url: ${server.url}/`,
      'updaterCacheDirName: everyonecoding-updater',
      ...(options.publisherName === undefined
        ? []
        : [`publisherName:`, `  - ${options.publisherName}`]),
      '',
    ].join('\n'),
  );

  const updater = new NsisUpdater(null, {
    version: options.appVersion ?? '0.1.0',
    name: 'EveryoneCoding',
    isPackaged: true,
    appUpdateConfigPath: configPath,
    userDataPath: path.join(appDir, 'userData'),
    baseCachePath,
    whenReady: () => Promise.resolve(),
    relaunch: () => undefined,
    quit: () => {
      quitCalls += 1;
    },
    onQuit: () => undefined,
  });
  const internals = updater as unknown as {
    httpExecutor: unknown;
    spawnLog: (cmd: string, args: string[]) => Promise<boolean>;
  };
  internals.httpExecutor = new NodeHttpExecutor();
  internals.spawnLog = async (cmd, args) => {
    spawned.push({ cmd, args });
    return true;
  };

  const logs: string[] = [];
  const host = createElectronUpdaterHost({
    updater: updater as unknown as NsisUpdaterLike,
    feedUrl: options.feedUrl ?? `${server.url}/`,
    enabled: true,
    log: (line) => logs.push(line),
    installGraceMs: 200,
    stallTimeoutMs: 1500,
    createCancellationToken: () => new CancellationToken(),
  });
  return { host, updater, cacheDir, logs };
}

beforeEach(() => {
  spawned = [];
  quitCalls = 0;
  server.requests.length = 0;
  server.clearFaults();
});

afterEach(() => {
  server.clearFaults();
});

describe('electron-updater 真实链路：检查 → 差分下载 → 校验 → 拉起安装器重启', () => {
  it('检查：从 latest.yml 读出新版本与更新说明', async () => {
    const { host } = createHarness();
    expect(await host.check()).toEqual({
      version: '0.1.1',
      notes: '修复更新流程',
      releaseDate: '2026-09-30T00:00:00.000Z',
    });
  });

  it('差分下载：只按区间拉变化的块，sha512 通过后以静默 + 重启参数拉起安装器', async () => {
    const { host, cacheDir } = createHarness();
    const progress: Array<{ phase: string; percent?: number; message?: string }> = [];
    host.onProgress((item) => progress.push(item));

    expect(await host.download()).toMatchObject({ version: '0.1.1' });
    const stats = host.lastDownloadStats();
    expect(stats?.differential).toBe(true);
    // 4MB 里只改了 64KB：实际下载量远小于整包
    expect(stats?.downloadKb).toBeLessThan((stats?.fullKb ?? 0) / 4);
    const rangeRequests = server.requests.filter(
      (request) => request.path.endsWith('0.1.1-x64-setup.exe') && request.range !== null,
    );
    expect(rangeRequests.length).toBeGreaterThan(0);
    expect(
      server.requests.some((request) => request.path.endsWith('.exe') && request.range === null),
    ).toBe(false);
    expect(progress.some((item) => item.message?.startsWith('差分下载') === true)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: 'downloading', percent: 100 });

    const pending = path.join(cacheDir, 'pending', 'EveryoneCoding-0.1.1-x64-setup.exe');
    expect(sha512(pending)).toBe(sha512(path.join(feedDir, 'EveryoneCoding-0.1.1-x64-setup.exe')));

    await host.installAndRestart();
    expect(spawned).toEqual([{ cmd: pending, args: ['--updated', '/S', '--force-run'] }]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(quitCalls).toBe(1);
  });

  it('本机没有旧安装包（首次手动安装的 zip 版等）：差分回退整包，照样通过校验', async () => {
    const { host, logs } = createHarness({ seedInstalled: false });
    expect(await host.download()).toMatchObject({ version: '0.1.1' });
    expect(host.lastDownloadStats()?.differential).toBe(false);
    expect(
      server.requests.some(
        (request) => request.path.endsWith('0.1.1-x64-setup.exe') && request.range === null,
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes('整包'))).toBe(true);
  });

  it('半包（服务器上的安装包只有一半）：sha512 不符被拒，不拉起安装器', async () => {
    const { host } = createHarness({ seedInstalled: false });
    server.setFault(/0\.1\.1-x64-setup\.exe$/, 'truncate');
    const error = await host.download().catch((cause: unknown) => cause);
    expect(classifyUpdateError(error).kind).toBe('integrity');
    await expect(host.installAndRestart()).rejects.toThrow(/UPDATE_INSTALL/);
    expect(spawned).toEqual([]);
  });

  it('下载停滞（连接挂着但不给数据）：停滞看门狗中止并归类为 network，不拉起安装器', async () => {
    const { host } = createHarness({ seedInstalled: false });
    // 服务端只发开头一小段就静默挂起：错误不会到达，只有停滞看门狗能中止下载
    server.setFault(/0\.1\.1-x64-setup\.exe$/, 'stall');
    const error = await host.download().catch((cause: unknown) => cause);
    expect(String(error)).toMatch(/UPDATE_NETWORK: 下载停滞/);
    expect(classifyUpdateError(error).kind).toBe('network');
    expect(spawned).toEqual([]);
  }, 20_000);

  it('下载中途连接被掐断（服务端主动断开，错误先于看门狗到达）：归类为 network，不拉起安装器', async () => {
    const { host } = createHarness({ seedInstalled: false });
    server.setFault(/0\.1\.1-x64-setup\.exe$/, 'drop');
    const error = await host.download().catch((cause: unknown) => cause);
    // 服务端 destroy 后错误立即到达，文案取决于底层报文（aborted / socket hang up 等），不断言具体字样
    expect(String(error)).toMatch(/UPDATE_NETWORK:/);
    expect(classifyUpdateError(error).kind).toBe('network');
    expect(spawned).toEqual([]);
  });

  it('内容被篡改（长度不变）：差分拼出的文件 sha512 不符，被拒', async () => {
    const { host } = createHarness();
    server.setFault(/0\.1\.1-x64-setup\.exe$/, 'corrupt');
    const error = await host.download().catch((cause: unknown) => cause);
    expect(classifyUpdateError(error).kind).toBe('integrity');
    expect(spawned).toEqual([]);
  });

  it('签名错误：配置了发布者而安装包未签名 → Authenticode 校验拒绝（ERR_UPDATER_INVALID_SIGNATURE）', async () => {
    const { host } = createHarness({
      seedInstalled: false,
      publisherName: 'EveryoneCoding Release Signing',
    });
    const error = await host.download().catch((cause: unknown) => cause);
    expect(String(error)).toMatch(/UPDATE_SIGNATURE: .*not signed by the application owner/);
    expect(classifyUpdateError(error).kind).toBe('signature');
    expect(spawned).toEqual([]);
  }, 60_000);

  it('网络失败：更新源不可达时检查报 network，不抛未归类异常', async () => {
    const { host } = createHarness({ feedUrl: 'http://127.0.0.1:9/' });
    const error = await host.check().catch((cause: unknown) => cause);
    expect(classifyUpdateError(error).kind).toBe('network');
  });

  it('清单 5xx：归类为 network', async () => {
    const { host } = createHarness();
    server.setFault(/latest\.yml$/, '500');
    const error = await host.check().catch((cause: unknown) => cause);
    expect(classifyUpdateError(error).kind).toBe('network');
  });

  it('没有更新（清单版本不比当前新）：check / download 返回 null', async () => {
    const { host } = createHarness({ appVersion: '0.1.1' });
    expect(await host.check()).toBeNull();
    expect(await host.download()).toBeNull();
  });

  it('未配置更新源（开发期）：如实报 not-configured', async () => {
    const updater = {
      on: () => undefined,
      setFeedURL: () => undefined,
    } as unknown as NsisUpdaterLike;
    const host = createElectronUpdaterHost({
      updater,
      feedUrl: null,
      enabled: false,
      log: () => undefined,
    });
    const error = await host.check().catch((cause: unknown) => cause);
    expect(classifyUpdateError(error).kind).toBe('not-configured');
  });
});
