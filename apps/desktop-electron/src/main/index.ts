import { app, BrowserWindow, ipcMain, safeStorage, clipboard, dialog, shell } from 'electron';
import path from 'node:path';
import { registerAllIpc, type RegisteredIpc } from './ipc';
import type { IpcDependencies } from './types';
import { createHeadlessRuntime, type HeadlessRuntime } from './runtime/bootstrap';

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
/**
 * 业务运行时（域 + AI 栈）。
 *
 * **不再自己拼装**：装配逻辑统一在 `runtime/bootstrap.ts` 的 `createHeadlessRuntime()`，
 * 与 Tauri 形态的侧车**共用同一份**。两处各写一份的后果不是"多写几行"，
 * 而是两形态的域装配会各自漂移（一侧加了域、另一侧忘了），而这正是 D-01「功能等价」被侵蚀的方式。
 */
let runtime: HeadlessRuntime | null = null;

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
    ...(runtime?.ai ? { aiHost: runtime.ai } : {}),
    ...(runtime ? { domainHost: runtime.domain } : {}),
    openExternal: (url) => shell.openExternal(url),
  };
}

/**
 * 装配业务运行时（15 个域 + AI 栈）。
 *
 * **本函数只做"外壳侧注入"，装配逻辑全在 `runtime/bootstrap.ts`** —— 那份逻辑
 * 与 Tauri 形态的侧车**共用同一份代码**。这里是 Electron 独有的部分：
 * 数据目录取自 `app.getPath('userData')`、密钥原语用 `safeStorage`（DPAPI）、
 * 外链与剪贴板接 Electron 的系统实现。
 *
 * 为什么必须共用：两处各写一份装配不是"多写几行"，而是两形态的域装配会各自漂移
 * （一侧加了域、另一侧忘了），而这正是 D-01「功能等价」被侵蚀的方式。
 * 装配内部的两条纪律（AI 栈失败不连坐域运行时、事件 sink 先于域工厂创建）
 * 也只在 bootstrap 里维护一次。
 */
async function buildRuntime(): Promise<HeadlessRuntime> {
  const userData = app.getPath('userData');
  return createHeadlessRuntime({
    dataDir: path.join(userData, 'data'),
    cacheDir: path.join(userData, 'cache'),
    defaultWorkspaceRoot: path.join(userData, 'workspace'),
    secureDir: path.join(userData, 'secure'),
    safeStorage: safeStorage ?? null,
    // AI 栈的 SQLite 迁移目录：开发期在仓库里，打包后由 prepare-production.mjs
    // 复制到 app.asar/dist/migrations。给错路径也不会静默失效——
    // 取不到时 `resolveMigrations` 会逐级上溯探测，仍找不到才报错。
    migrationsDir: isDev
      ? // dist/main/index.cjs → 上溯 4 层到仓库根。
        path.join(__dirname, '..', '..', '..', '..', 'packages', 'data', 'migrations')
      : path.join(__dirname, '..', 'migrations'),
    userId: 'local-user',
    ports: {
      openExternal: (url) => shell.openExternal(url),
      writeClipboard: (text) => clipboard.writeText(text),
      onNotice: (message) => console.warn(`[domain] ${message}`),
    },
  });
}

void app.whenReady().then(async () => {
  try {
    runtime = await buildRuntime();
    const descriptors = await runtime.descriptors();
    const installed = descriptors.filter((item) => item.available).map((item) => item.kind);
    console.info(`[domain] 已装配域=[${installed.join(', ') || '无'}]`);
    /**
     * AI 栈装配失败**不抛错**：`createHeadlessRuntime` 会把它记成 `aiError` 并继续装域。
     * 这是刻意的——AI 依赖 DPAPI，在无桌面会话/无加密可用性的环境里会整体失败，
     * 而设置 / 工作台 / 文档 / 记忆这些域不该被它连坐。这里只把原因留痕。
     */
    if (runtime.ai === null) {
      console.warn(`[AI] 主进程 AI 栈未装配：${runtime.aiError ?? '未知原因'}`);
    }
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
  /**
   * 一次 `dispose()` 收掉全部：域路由、事件 sink、AI 栈、预览后端子进程、
   * SQLite 连接（顺序见 `runtime/bootstrap.ts` 的 `disposers`）。
   *
   * 不要在这里再单独 dispose AI 栈：它已经是域运行时 disposers 里的一项，
   * 重复释放会让 AI 栈的 `db.close()` 跑两遍（第二次抛错被吞掉，但掩盖真实失败）。
   */
  void runtime?.dispose();
  runtime = null;
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
