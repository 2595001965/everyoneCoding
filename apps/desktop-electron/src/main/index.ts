import { app, BrowserWindow, ipcMain, safeStorage, clipboard, dialog, shell } from 'electron';
import path from 'node:path';
import { registerAllIpc, type RegisteredIpc } from './ipc';
import type { IpcDependencies } from './types';
import { createElectronAiRuntime } from './ai/runtime';
import { createDomainRuntime } from './domain/runtime';
import { createSettingsDomain } from './domain/settings';
import { createWorkspaceDomain } from './domain/workspace';
import { createDocsDomain } from './domain/docs';
import { createAuthDomain, type SafeStorageLike } from './domain/auth';
import { openBusinessDb } from './domain/db';
import { resolveProjectsDir } from './domain/settings-file';
import { UNAVAILABLE_DOMAIN_REASONS } from './domain/reasons';

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
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      console.error(`[main] 渲染层加载失败：${validatedURL}（${errorCode} ${errorDescription}）`);
      console.error('[main] 请确认渲染层 dev server 已在 http://localhost:5173 运行');
    });
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
function buildDomainRuntime(dataDir: string, cacheDir: string): ReturnType<typeof createDomainRuntime> {
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
    safeStorage !== null && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable();
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

  return createDomainRuntime({
    routers: {
      settings: settings.router,
      workspace: workspace.router,
      docs: docs.router,
      ...(auth ? { auth: auth.router } : {}),
    },
    unavailableReasons: unavailableReasons,
    disposers: [
      () => settings.dispose(),
      async () => {
        db.close();
      },
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
        // dist/main/index.cjs → 上溯 4 层到仓库根。
        ? path.join(__dirname, '..', '..', '..', '..', 'packages', 'data', 'migrations')
        // 打包时由 prepare-production.mjs 复制到 app.asar/dist/migrations。
        : path.join(__dirname, '..', 'migrations'),
      safeStorage: deps.safeStorage,
    });
  } catch (error) {
    console.warn(`[AI] 主进程 AI 栈未装配：${error instanceof Error ? error.message : String(error)}`);
  }

  const userData = app.getPath('userData');
  try {
    domainRuntime = buildDomainRuntime(path.join(userData, 'data'), path.join(userData, 'cache'));
    const descriptors = await domainRuntime.describe();
    const installed = descriptors.filter((item) => item.available).map((item) => item.kind);
    console.info(`[domain] 已装配域=[${installed.join(', ') || '无'}]`);
  } catch (error) {
    console.warn(`[domain] 域运行时未装配：${error instanceof Error ? error.message : String(error)}`);
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
