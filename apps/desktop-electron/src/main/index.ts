import { app, BrowserWindow, ipcMain, safeStorage, clipboard, dialog, shell } from 'electron';
import path from 'node:path';
import { registerAllIpc, type RegisteredIpc } from './ipc';
import type { IpcDependencies } from './types';
import { createElectronAiRuntime } from './ai/runtime';

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
    openExternal: (url) => shell.openExternal(url),
  };
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
