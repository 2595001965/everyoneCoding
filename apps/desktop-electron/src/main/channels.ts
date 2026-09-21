/**
 * IPC 通道名常量：preload 与 main 共用的单一事实源。
 * 通道命名与 ShellHost 方法一一对应（前缀 ec: + 能力 + 方法）。
 */

export const CHANNELS = {
  fs: {
    readText: 'ec:fs:readText',
    readBinary: 'ec:fs:readBinary',
    writeAtomic: 'ec:fs:writeAtomic',
    stat: 'ec:fs:stat',
    readdir: 'ec:fs:readdir',
    mkdir: 'ec:fs:mkdir',
    remove: 'ec:fs:remove',
    copy: 'ec:fs:copy',
    rename: 'ec:fs:rename',
    exists: 'ec:fs:exists',
    watch: 'ec:fs:watch',
    unwatch: 'ec:fs:unwatch',
  },
  dialog: {
    openFile: 'ec:dialog:openFile',
    openDirectory: 'ec:dialog:openDirectory',
    saveFile: 'ec:dialog:saveFile',
    showMessage: 'ec:dialog:showMessage',
    confirm: 'ec:dialog:confirm',
  },
  process: {
    spawn: 'ec:process:spawn',
    write: 'ec:process:write',
    kill: 'ec:process:kill',
    list: 'ec:process:list',
    killAll: 'ec:process:killAll',
    /** 推送事件（stdout/stderr/exit），payload 携带子进程 id */
    stdout: 'ec:process:event:stdout',
    stderr: 'ec:process:event:stderr',
    exit: 'ec:process:event:exit',
  },
  window: {
    setTitle: 'ec:window:setTitle',
    minimize: 'ec:window:minimize',
    maximize: 'ec:window:maximize',
    unmaximize: 'ec:window:unmaximize',
    isMaximized: 'ec:window:isMaximized',
    setFullScreen: 'ec:window:setFullScreen',
    isFullScreen: 'ec:window:isFullScreen',
    setSize: 'ec:window:setSize',
    getSize: 'ec:window:getSize',
    center: 'ec:window:center',
    focus: 'ec:window:focus',
    close: 'ec:window:close',
  },
  secureStore: {
    set: 'ec:secureStore:set',
    get: 'ec:secureStore:get',
    delete: 'ec:secureStore:delete',
    has: 'ec:secureStore:has',
    listKeys: 'ec:secureStore:listKeys',
  },
  updater: {
    check: 'ec:updater:check',
    downloadAndInstall: 'ec:updater:downloadAndInstall',
    onProgress: 'ec:updater:event:progress',
  },
  appInfo: {
    get: 'ec:appInfo:get',
    getDataDir: 'ec:appInfo:getDataDir',
    setWorkspaceRoot: 'ec:appInfo:setWorkspaceRoot',
  },
  clipboard: {
    readText: 'ec:clipboard:readText',
    writeText: 'ec:clipboard:writeText',
    clear: 'ec:clipboard:clear',
  },
  net: {
    fetch: 'ec:net:fetch',
    isHostAllowed: 'ec:net:isHostAllowed',
    setAllowedHosts: 'ec:net:setAllowedHosts',
  },
  ai: {
    invoke: 'ec:ai:invoke',
    stream: 'ec:ai:stream',
    abort: 'ec:ai:abort',
    start: 'ec:ai:stream:start',
  },
  /** 领域端口（工作台 / 文档 / 账号 / 设置）：单通道 + 方法白名单，避免通道表膨胀 */
  domain: {
    invoke: 'ec:domain:invoke',
    /**
     * 同步领域调用（`ipcRenderer.sendSync`）。
     *
     * 只承载同步签名的端口（`MemoryApi` / `PipelineApi`），方法白名单另有
     * `DOMAIN_SYNC_METHODS`；主进程侧用 `ipcMain.on` + `event.returnValue` 应答，
     * 因此它**不做异步等待**，域路由必须是纯 CPU / 本地 IO。
     */
    invokeSync: 'ec:domain:invokeSync',
    describe: 'ec:domain:describe',
    /** 域事件（主进程 → 渲染层单向推送），payload 携带 requestId 供渲染层关联调用 */
    event: 'ec:domain:event',
  },
  openExternal: 'ec:openExternal',
} as const;

/** 仅主进程→渲染层单向推送（无对应 handler）的通道 */
export const EVENT_CHANNELS: readonly string[] = [
  CHANNELS.process.stdout,
  CHANNELS.process.stderr,
  CHANNELS.process.exit,
  CHANNELS.updater.onProgress,
  CHANNELS.ai.stream,
  CHANNELS.domain.event,
];

/**
 * 用 `ipcMain.on` 应答的同步通道（不适用 `ipcMain.handle`）。
 * 主进程注册完整性校验（`registerAllIpc`）必须把它们排除，否则会要求一个永不存在的 handle。
 */
export const SYNC_CHANNELS: readonly string[] = [CHANNELS.domain.invokeSync];

/** preload 允许暴露到渲染层的顶层命名空间白名单（安全审计依据） */
export const PRELOAD_TOP_LEVEL_KEYS = [
  'fs',
  'dialog',
  'process',
  'window',
  'secureStore',
  'updater',
  'appInfo',
  'clipboard',
  'net',
  'ai',
  'domain',
  'openExternal',
] as const;

/** 每个命名空间下允许暴露的方法名（与 ShellHost 一一对应） */
export const PRELOAD_METHOD_KEYS: Record<string, readonly string[]> = {
  fs: [
    'readText',
    'readBinary',
    'writeAtomic',
    'stat',
    'readdir',
    'mkdir',
    'remove',
    'copy',
    'rename',
    'exists',
    'watch',
  ],
  dialog: ['openFile', 'openDirectory', 'saveFile', 'showMessage', 'confirm'],
  process: ['spawn', 'write', 'kill', 'list', 'killAll', 'onStdout', 'onStderr', 'onExit'],
  window: [
    'setTitle',
    'minimize',
    'maximize',
    'unmaximize',
    'isMaximized',
    'setFullScreen',
    'isFullScreen',
    'setSize',
    'getSize',
    'center',
    'focus',
    'close',
  ],
  secureStore: ['set', 'get', 'delete', 'has', 'listKeys'],
  updater: ['check', 'downloadAndInstall', 'onProgress'],
  appInfo: ['get', 'getDataDir', 'setWorkspaceRoot'],
  clipboard: ['readText', 'writeText', 'clear'],
  net: ['fetch', 'isHostAllowed', 'setAllowedHosts'],
  ai: ['invoke', 'stream', 'abort'],
  domain: ['invoke', 'invokeSync', 'describe', 'onEvent'],
};
