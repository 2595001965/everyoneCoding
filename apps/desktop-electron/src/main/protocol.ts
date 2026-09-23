/**
 * OAuth 自定义协议通道（`everyonecoding://oauth`）的外壳接线。
 *
 * ## 为什么需要这一层
 *
 * 回环监听（`http://127.0.0.1:<port>/oauth/callback`）是 OAuth 的主通道：
 * 它不依赖任何系统级注册，回调直达进程内。但它有两个真实失效场景：
 *
 * 1. **企业策略 / 安全软件阻断本机回环监听**（部分终端管控直接禁掉 127.0.0.1 的
 *    `listen`，`server.listen()` 直接报错）；
 * 2. **远程桌面 / 无本地浏览器的环境**下，回环地址虽然通，但浏览器侧无法回到应用。
 *
 * 此时必须有一条能"把浏览器里的回调送进进程"的辅通道 —— 自定义协议。
 * 它需要外壳做三件事，缺一不可：
 *
 * - `setAsDefaultProtocolClient('everyonecoding')`：把 scheme 注册到操作系统
 *   （Windows 写注册表 `HKCU\Software\Classes\everyonecoding`，macOS 写 Info.plist）；
 * - **单实例锁** `requestSingleInstanceLock()`：协议拉起的是"第二个进程"，
 *   必须让它把 URL 交给已在运行的实例，否则会出现两个应用实例各持一半状态；
 * - `second-instance`（Windows/Linux）/ `open-url`（macOS）事件转发。
 *
 * ## 为什么单独成模块
 *
 * 这三件事全是 Electron 特有 API，但**判定逻辑（从 argv 里挑出应用自己的 URL、
 * 回调早于注册时先排队）是纯的**——抽出来就能在没有 Electron 的测试环境里
 * 完整验证"协议回调最终真的交到了 auth 域"，而不是只测到 `app.on` 被调用。
 */

/** 自定义协议 scheme（与 `AuthClient` 回退通道使用的 redirectUri 必须逐字一致） */
export const OAUTH_PROTOCOL_SCHEME = 'everyonecoding';

/** 协议回调 URL 前缀，形如 `everyonecoding://oauth?code=...&state=...` */
export const OAUTH_PROTOCOL_PREFIX = `${OAUTH_PROTOCOL_SCHEME}://`;

/**
 * 从命令行参数里挑出本应用的协议 URL。
 *
 * **必须逐字匹配 `scheme://` 前缀**：Windows 会把 `everyonecoding://oauth?...`
 * 原样作为一个 argv 元素传进来，但同一批 argv 里还有 Electron 自己的开关
 * （`--allow-file-access-from-files` 等）和用户的工作目录。用 `includes('everyonecoding')`
 * 之类的宽松判定会把"路径里恰好含该词"的目录误判成回调。
 *
 * 大小写不敏感：协议 scheme 在 URL 规范里是大小写不敏感的，Windows 注册表拉起时
 * 可能保留用户输入的大小写。
 */
export function extractProtocolUrl(
  argv: readonly string[],
  scheme: string = OAUTH_PROTOCOL_SCHEME,
): string | null {
  const prefix = `${scheme}://`.toLowerCase();
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    if (arg.toLowerCase().startsWith(prefix)) return arg;
  }
  return null;
}

/**
 * 协议回调的投递桥。
 *
 * 存在的理由是**时序**：协议 URL 可能在 auth 域注册处理器之前就到达 ——
 * 冷启动场景下 OS 把 URL 放在 `process.argv` 里，此刻运行时尚在装配；
 * 而 `registerProtocol` 只在 `beginOAuth` 发现回环不可用时才被调用。
 * 直接"没处理器就丢弃"会让这条通道在某些时序下静默失效，故先排队、注册后补投。
 */
export interface ProtocolBridge {
  /**
   * auth 域申请接管协议回调。返回 `true` = 已接管（并把此前排队的 URL 立即补投）。
   *
   * 重复注册时**后来者生效**：每次 `beginOAuth` 都会带上新的闭包（内含当次握手的
   * `codeVerifier`），沿用旧闭包会用错的 PKCE 去换令牌。
   */
  register(handler: (url: string) => void): boolean;
  /** 外壳收到协议 URL 时调用（second-instance / open-url / 冷启动 argv 统一入口） */
  deliver(url: string): void;
  /** 尚未投递的 URL 条数（诊断与测试用） */
  pendingCount(): number;
}

/** 排队上限：协议 URL 只在"一次进行中的授权"窗口内有意义，超出必然是异常输入 */
const MAX_PENDING = 8;

export function createProtocolBridge(): ProtocolBridge {
  let handler: ((url: string) => void) | null = null;
  const pending: string[] = [];

  return {
    register(next) {
      handler = next;
      // 补投时先清空队列再回调：回调内部可能同步再次 deliver（例如渲染层上送），
      // 不清空会把新到的事件也当成"历史积压"重复投递。
      const backlog = pending.splice(0, pending.length);
      for (const url of backlog) next(url);
      return true;
    },

    deliver(url) {
      if (typeof url !== 'string' || url.length === 0) return;
      if (handler !== null) {
        handler(url);
        return;
      }
      // 尚无接管方：只留最近若干条，避免异常输入把内存撑起来
      pending.push(url);
      if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
    },

    pendingCount: () => pending.length,
  };
}

/**
 * 外壳可注入的最小 Electron `app` 表面。
 *
 * 用结构化最小接口而不是直接依赖 `Electron.App`：`app.on` 在 Electron 类型里有
 * 十余个重载，直接依赖会让本模块无法在无 Electron 的测试环境导入。
 */
export interface ProtocolAppLike {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  setAsDefaultProtocolClient(scheme: string, execPath?: string, args?: string[]): boolean;
}

export interface InstallOAuthProtocolOptions {
  app: ProtocolAppLike;
  /** 打包态。开发态注册协议必须显式带 execPath + 入口脚本，否则注册的是 electron.exe 自身 */
  isPackaged: boolean;
  /** `process.execPath` */
  execPath: string;
  /** `process.argv[1]`：开发态要补的启动参数（应用入口脚本） */
  entryScript?: string | undefined;
  /** 收到第二个实例时聚焦已有窗口（主窗口被最小化时尤其重要） */
  focusWindow?: (() => void) | undefined;
  /** 冷启动时进程自己的 argv（默认 `process.argv`） */
  argv?: readonly string[] | undefined;
  scheme?: string | undefined;
  logger?: { info(message: string): void; warn(message: string): void } | undefined;
}

/**
 * 安装协议通道，返回投递桥（供 auth 域注入为 `registerProtocolHandler`）。
 *
 * 单一实例锁的语义：**拿不到锁说明已有实例在跑**，此时本进程必须立刻退出，
 * 把 URL 留给那个实例（OS 会触发它的 `second-instance`）。
 * 这不是优化，而是正确性前提 —— 两个实例各自持有内存态会话，
 * 用户在第二个实例里点了"完成授权"，第一个实例的界面不会有任何反应。
 */
export function installOAuthProtocol(options: InstallOAuthProtocolOptions): ProtocolBridge {
  const { app } = options;
  const scheme = options.scheme ?? OAUTH_PROTOCOL_SCHEME;
  const log = options.logger ?? { info: () => undefined, warn: () => undefined };
  const bridge = createProtocolBridge();

  const focus = (): void => options.focusWindow?.();

  // ---- 1. 第二实例 / macOS open-url：把 URL 交给已在运行的实例 ----
  app.on('second-instance', (...args: unknown[]) => {
    // Electron 签名：(event, argv, workingDirectory, additionalData)
    const argv = Array.isArray(args[1]) ? (args[1] as string[]) : [];
    focus();
    const url = extractProtocolUrl(argv, scheme);
    if (url === null) return;
    log.info(`[protocol] 第二实例回调：${url}`);
    bridge.deliver(url);
  });

  app.on('open-url', (...args: unknown[]) => {
    // macOS 签名：(event, url)。必须 preventDefault，否则系统会用默认处理器再开一次。
    const event = args[0] as { preventDefault?: () => void } | undefined;
    const url = typeof args[1] === 'string' ? (args[1] as string) : '';
    event?.preventDefault?.();
    if (url.length === 0) return;
    log.info(`[protocol] open-url 回调：${url}`);
    bridge.deliver(url);
  });

  // ---- 2. 注册 scheme 到操作系统 ----
  try {
    const registered = options.isPackaged
      ? app.setAsDefaultProtocolClient(scheme)
      : // 开发态：electron.exe 自己不是应用，必须显式指明"用哪个可执行文件 + 哪个入口"，
        // 否则 OS 会把 `everyonecoding://` 关联到一个没有入口脚本的裸 electron.exe。
        app.setAsDefaultProtocolClient(
          scheme,
          options.execPath,
          options.entryScript === undefined ? [] : [options.entryScript],
        );
    if (registered) {
      log.info(`[protocol] 已注册 ${scheme}:// 处理器`);
    } else {
      // 如实降级：不阻止启动，但要留痕，否则"点了授权没反应"会变成无解问题
      log.warn(
        `[protocol] ${scheme}:// 注册失败（可能被系统策略拒绝）：` +
          'OAuth 将仅使用本机回环通道；若回环也被禁用，第三方登录不可用。',
      );
    }
  } catch (error) {
    log.warn(
      `[protocol] ${scheme}:// 注册异常：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // ---- 3. 冷启动：本次进程就是被协议拉起的（或 URL 已在 argv 里） ----
  const initial = extractProtocolUrl(options.argv ?? process.argv, scheme);
  if (initial !== null) {
    log.info(`[protocol] 冷启动回调：${initial}`);
    bridge.deliver(initial);
  }

  return bridge;
}
