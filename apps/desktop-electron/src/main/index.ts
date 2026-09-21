import { app, BrowserWindow, ipcMain, safeStorage, clipboard, dialog, shell } from 'electron';
import path from 'node:path';
import { createDomainEventSink, type DomainKind } from '@ec/shell-api';
import { registerAllIpc, type RegisteredIpc } from './ipc';
import type { IpcDependencies } from './types';
import { createElectronAiRuntime } from './ai/runtime';
import { createDomainRuntime } from './domain/runtime';
import { createSettingsDomain } from './domain/settings';
import { createWorkspaceDomain } from './domain/workspace';
import { createDocsDomain } from './domain/docs';
import { createAuthDomain, type SafeStorageLike } from './domain/auth';
import { createGitCredentialStore } from './domain/git-credentials';
import { createControlledProcessHost } from './domain/process-host';
import { openBusinessDb } from './domain/db';
import { resolveProjectsDir } from './domain/settings-file';
import { UNAVAILABLE_DOMAIN_REASONS } from './domain/reasons';
import { createProductionDomains, type AiStackHandle } from './domain/domain-factories';

/**
 * Electron 主进程入口。
 *
 * 安全基线（硬约束）：
 * - sandbox: true / nodeIntegration: false / contextIsolation: true
 * - preload 仅暴露与 ShellHost 一一对应的白名单通道
 * - 渲染层拿不到任何 Node 全局对象
 */

// esbuild CJS bundle 里 import.meta.url 为 undefined（会注入空 import_meta 对象），
// 不能用 fileURLToPath。__dirname 为 esbuild CJS 输出的原生注入全局，直接用。
declare const __dirname: string;
const isDev = !app.isPackaged;
const userDataOverride = process.env['EC_ELECTRON_USER_DATA_DIR'];
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

/**
 * 是否自动打开 DevTools。默认关闭。
 *
 * DevTools 前端会往控制台吐一批与应用无关的告警，最典型的两条：
 * - `Unknown VE context: language-mismatch` —— DevTools 视觉埋点（visual elements）内部告警
 * - `Request Autofill.enable failed` / `Autofill.setAddresses failed` —— Electron 未暴露 Autofill 协议域
 *
 * 它们带 `ERROR:CONSOLE` 前缀、`source: devtools://...`，极易被误判成应用故障，故不再默认弹出。
 * 开发模式下 DevTools 依然可用（Ctrl+Shift+I 或视图菜单）；需要启动即弹出时设 EC_ELECTRON_DEVTOOLS=1。
 */
const shouldAutoOpenDevTools = isDev && process.env['EC_ELECTRON_DEVTOOLS'] === '1';

let mainWindow: BrowserWindow | null = null;
let registered: RegisteredIpc | null = null;
let aiRuntime: Awaited<ReturnType<typeof createElectronAiRuntime>> | null = null;
let domainRuntime: ReturnType<typeof createDomainRuntime> | null = null;

/**
 * 无所属请求的域事件所用信封 id（见 `buildDomainRuntime` 的 emit 绑定）。
 * 渲染层按 `domain + payload.type` 过滤这类事件，不依赖 requestId 匹配；
 * 但 preload 会丢弃缺 requestId 的载荷，故必须给一个非空哨兵。
 */
const WATCHER_EVENT_REQUEST_ID = 'domain-watcher-event';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      devTools: isDev,
    },
  });

  if (isDev) {
    // 渲染层 dev server 没起来时，Electron 只会给一个白窗口，真正的原因藏在 DevTools 里。
    // 这里显式报出来，避免把"忘了起 5173"误判成应用故障。
    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        console.error(`[main] 渲染层加载失败：${validatedURL}（${errorCode} ${errorDescription}）`);
        console.error('[main] 请确认渲染层 dev server 已在 http://localhost:5173 运行');
      },
    );
    void win.loadURL('http://localhost:5173');
    if (shouldAutoOpenDevTools) win.webContents.openDevTools({ mode: 'bottom' });
  } else {
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    mainWindow = null;
  });
  return win;
}

function buildDependencies(): IpcDependencies {
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  const secureDir = path.join(userData, 'secure');

  return {
    dialog: dialog as unknown as IpcDependencies['dialog'],
    getWindow: () => mainWindow,
    clipboard,
    safeStorage: safeStorage ?? null,
    updater: null, // electron-updater 在 build 阶段接入；未配置时显式 NOT_SUPPORTED
    app: {
      getName: () => app.getName(),
      getVersion: () => app.getVersion(),
      getLocale: () => app.getLocale(),
      isPackaged: app.isPackaged,
      getPath: (name) => app.getPath(name),
    },
    dataDir,
    secureDir,
    ...(aiRuntime ? { aiHost: aiRuntime } : {}),
    ...(domainRuntime ? { domainHost: domainRuntime } : {}),
    openExternal: (url) => shell.openExternal(url),
  };
}

/**
 * 装配域运行时。
 *
 * 与 AI 栈**刻意分离**：AI 栈依赖 `safeStorage`（DPAPI），在无加密可用性的环境下会整体装配失败；
 * 而设置/工作台/文档这些域不该被它连坐，故各自独立装配、各自在 `describe()` 里如实上报。
 *
 * 域内共用**一个**业务库连接（workspace / docs 都要读同一份 SQLite），随域运行时一起释放。
 */
function buildDomainRuntime(
  dataDir: string,
  cacheDir: string,
  aiStackHandle: AiStackHandle | null,
  secureDir: string,
  safeStorageLike: SafeStorageLike | null,
): ReturnType<typeof createDomainRuntime> {
  const defaultWorkspaceRoot = path.join(app.getPath('userData'), 'workspace');
  const projectsDir = resolveProjectsDir(dataDir, defaultWorkspaceRoot);
  const db = openBusinessDb({ dataDir });

  const settings = createSettingsDomain({
    dataDir,
    cacheDir,
    defaultWorkspaceRoot,
    projectsDir,
    db,
    onNotice: (message) => console.warn(`[domain] ${message}`),
  });

  const workspace = createWorkspaceDomain({ db, dataDir, projectsDir });
  const docs = createDocsDomain({ db });
  // auth 域依赖系统加密能力（DPAPI）保存凭据：不可用时**不装配**并如实上报原因，
  // 而不是装配一个"所有动作都报错"的端口。可用时基址取环境变量，缺省为本机自建账号服务。
  let auth: ReturnType<typeof createAuthDomain> | null = null;
  const encryptionAvailable =
    safeStorage !== null &&
    typeof safeStorage.isEncryptionAvailable === 'function' &&
    safeStorage.isEncryptionAvailable();
  if (encryptionAvailable) {
    auth = createAuthDomain({
      baseUrl: process.env['EC_ACCOUNT_BASE_URL'] ?? 'http://127.0.0.1:3000',
      safeStorage: safeStorage as SafeStorageLike,
      secureDir: path.join(app.getPath('userData'), 'secure'),
      openExternal: (url) => shell.openExternal(url),
      writeClipboard: (text) => clipboard.writeText(text),
    });
  }

  const unavailableReasons = { ...UNAVAILABLE_DOMAIN_REASONS };
  if (!auth) {
    unavailableReasons.auth =
      '系统加密能力不可用（safeStorage），无法安全保存登录凭据，账号域未装配';
  }

  // 域事件 sink 必须先于域工厂创建：code 域的外部改动监视器由 fs.watch 触发，
  // 不属于任何一次 RPC 请求，需要一条独立的事件投递路径（见下方 emit 绑定）。
  const events = createDomainEventSink();

  /**
   * 受控进程端口（T12-04）：预览后端的唯一启动通道。
   *
   * `allowedRoot = projectsDir` 是硬约束——渲染层递上来的 cwd 必须落在工程根内，
   * 否则域内直接拒绝 spawn（避免"预览"变成"在任意目录跑任意命令"）。
   */
  const processHost = createControlledProcessHost({ allowedRoot: projectsDir });
  /**
   * Git 凭据（DPAPI）。safeStorage 不可用时为 null，git 域的凭据方法如实报 NOT_SUPPORTED，
   * 而不是降级成明文文件。
   */
  const credentials =
    safeStorageLike === null
      ? null
      : createGitCredentialStore({ secureDir, safeStorage: safeStorageLike });

  // T12-01 生产端口总装：十一个生产能力域（memory/pipeline/git/preview/rename/
  // ai-context/code/nav/designer/usage/package）一次性装配。AI 栈未就绪时
  // aiStack 传 null，域内按此如实降级（生成类方法报 NOT_SUPPORTED + 引导）。
  const production = createProductionDomains({
    db,
    projectsDir,
    dataDir,
    userId: 'local-user',
    aiStack: aiStackHandle,
    process: processHost,
    credentials,
    /**
     * 非请求来源的事件发射口（当前消费者：code 域的外部改动监视器、
     * preview 域的后端进程日志、rename 域的迁移流式日志）。
     *
     * 请求内产生的进度事件走 `ctx.emit`（runtime 补齐 requestId/domain）；
     * 这些事件没有所属请求，用固定哨兵 id 作为信封关联字段，并走 `events.broadcast`
     * ——它是**常驻下发**，不依赖"某个 requestId 正在飞"，因此后端进程日志、
     * 外部改动监视、迁移流式日志都真的能到达渲染层。
     * 渲染层按 `domain + payload.type` 过滤，不依赖 requestId 匹配。
     * 哨兵仍必须是**非空字符串**：preload 会丢弃缺 requestId 的事件。
     */
    emit: (domain: DomainKind, payload: unknown) => {
      events.broadcast({ requestId: WATCHER_EVENT_REQUEST_ID, domain, payload });
    },
  });

  return createDomainRuntime({
    routers: {
      settings: settings.router,
      workspace: workspace.router,
      docs: docs.router,
      ...(auth ? { auth: auth.router } : {}),
      ...production.routers,
    },
    // 同步域口：只承载 MemoryApi / PipelineApi 的同步签名方法（见 shell-api 的 DOMAIN_SYNC_METHODS）。
    // 未装配同步路由的域在同步通道上如实返回 NOT_SUPPORTED，渲染层据此不注入对应端口。
    syncRouters: production.syncRouters,
    unavailableReasons: unavailableReasons,
    // 事件 sink 与域工厂共用同一实例：否则监视器类事件会发到另一个 sink 而无人接收
    events,
    disposers: [
      () => settings.dispose(),
      async () => {
        db.close();
      },
      ...production.disposers,
      // 预览后端等外部进程必须在退出前杀干净：否则下次启动会撞端口、留下孤儿进程
      () => processHost.dispose(),
    ],
  });
}

void app.whenReady().then(async () => {
  const deps = buildDependencies();
  try {
    aiRuntime = await createElectronAiRuntime({
      dataDir: deps.dataDir,
      secureDir: deps.secureDir,
      migrationsDir: isDev
        ? // dist/main/index.cjs → 上溯 4 层到仓库根。
          path.join(__dirname, '..', '..', '..', '..', 'packages', 'data', 'migrations')
        : // 打包时由 prepare-production.mjs 复制到 app.asar/dist/migrations。
          path.join(__dirname, '..', 'migrations'),
      safeStorage: deps.safeStorage,
    });
  } catch (error) {
    console.warn(
      `[AI] 主进程 AI 栈未装配：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const userData = app.getPath('userData');
  try {
    // AI 栈桥接属 T12-08：域内生成调用将在该任务接入真实 gateway（共用绑定/预算），
    // 当前传 null，生成类方法如实报 NOT_SUPPORTED + 引导。
    domainRuntime = buildDomainRuntime(
      path.join(userData, 'data'),
      path.join(userData, 'cache'),
      null,
      deps.secureDir,
      deps.safeStorage,
    );
    const descriptors = await domainRuntime.describe();
    const installed = descriptors.filter((item) => item.available).map((item) => item.kind);
    console.info(`[domain] 已装配域=[${installed.join(', ') || '无'}]`);
  } catch (error) {
    console.warn(
      `[domain] 域运行时未装配：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  registered = registerAllIpc(ipcMain, buildDependencies());

  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  registered?.dispose();
  registered = null;
  void aiRuntime?.dispose();
  aiRuntime = null;
  void domainRuntime?.dispose();
  domainRuntime = null;
});

// 外链一律走系统浏览器，禁止在应用内打开任意 web 内容
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    const allowed = isDev ? 'http://localhost:5173' : undefined;
    if (allowed === undefined || !url.startsWith(allowed)) event.preventDefault();
  });
});
