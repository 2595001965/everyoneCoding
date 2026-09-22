import {
  createDomainEventSink,
  isDomainKind,
  type AiControlServiceHost,
  type DomainControlServiceHost,
  type DomainEventSink,
  type DomainKind,
} from '@ec/shell-api';

import { createElectronAiRuntime } from '../ai/runtime';
import { createAuthDomain } from '../domain/auth';
import { createDocsDomain } from '../domain/docs';
import { openBusinessDb, resolveMigrationsDir } from '../domain/db';
import { createProductionDomains, type AiStackHandle } from '../domain/domain-factories';
import { createGitCredentialStore } from '../domain/git-credentials';
import { createControlledProcessHost } from '../domain/process-host';
import { UNAVAILABLE_DOMAIN_REASONS } from '../domain/reasons';
import { createDomainRuntime } from '../domain/runtime';
import { resolveProjectsDir } from '../domain/settings-file';
import { createSettingsDomain } from '../domain/settings';
import { createWorkspaceDomain } from '../domain/workspace';
import type { SafeStorageLike } from '../secure-storage';

/**
 * 与外壳无关的「业务运行时」装配（双形态共用）。
 *
 * ## 为什么必须有这一层（D-01 双形态功能等价的关键）
 *
 * Electron 形态的运行时原本直接写在 `main/index.ts` 的 `buildDomainRuntime()` 里，
 * 而那个文件 `import { app, safeStorage, ... } from 'electron'` —— 于是这套装配
 * **只可能在 Electron 进程里存在**。Tauri 形态要么重写一份（必然漂移，且等于
 * 放弃 `@ec/*` 领域内核），要么就没有域端口（就是本轮之前的状态：`NOT_SUPPORTED`）。
 *
 * 本模块把装配**抽成不依赖任何 Electron API 的纯函数**：一切外壳特性
 * （数据目录、DPAPI 原语、打开外链、剪贴板）都以参数注入。
 * 于是同一份装配可以跑在：
 *
 * - Electron 主进程（注入 `app.getPath()` 与 `safeStorage`）；
 * - 侧车进程（`src/sidecar/index.ts`，注入宿主经握手协商后回传的 DPAPI 原语）。
 *
 * 这保证了「同一套渲染层 + 同一套领域包」（RELEASE §5）在两种形态下**真的是同一份代码**，
 * 而不是两套看起来像的实现。
 *
 * ## 纪律（与 `main/index.ts` 完全一致，不得放松）
 *
 * - `describe()` 只回答「这个域装配好了没」，未装配的域如实报 false；
 * - 事件 sink **必须先于**域工厂创建：code 域的外部改动监视器由 `fs.watch` 触发，
 *   不属于任何一次 RPC 请求，需要一条独立投递路径；
 * - AI 栈与域运行时**各自独立装配**：AI 依赖 DPAPI，无加密可用性时整体装配失败，
 *   而设置 / 工作台 / 文档这些域不该被它连坐。
 */

/** 无所属请求的域事件所用信封 id（渲染层按 `domain + payload.type` 过滤，不依赖它匹配） */
export const WATCHER_EVENT_REQUEST_ID = 'domain-watcher-event';

/**
 * 外壳必须提供的端口（侧车由宿主经协议回传，Electron 直接给系统实现）。
 *
 * `writeClipboard` 刻意是**同步签名**：它对应 `AuthDomainOptions.writeClipboard`，
 * 只用于把授权码放到剪贴板这种「发了就不用管」的场景。跨进程实现允许 fire-and-forget，
 * 但**不得**伪造结果（见侧车侧实现）。
 */
export interface HeadlessRuntimePorts {
  openExternal(url: string): Promise<void>;
  writeClipboard(text: string): void;
  /** 非致命提示（settings 域的数据目录迁移等） */
  onNotice?(message: string): void;
}

export interface HeadlessRuntimeOptions {
  /** 数据目录（SQLite / settings.json / 附件落点） */
  dataDir: string;
  /** 缓存目录 */
  cacheDir: string;
  /** 默认工作区根（用户未在设置里另配时使用） */
  defaultWorkspaceRoot: string;
  /** 密钥文件根目录 */
  secureDir: string;
  /**
   * DPAPI 加密原语。`null` = 系统加密不可用（或宿主未提供）：
   * auth 域**不装配**并如实上报原因，git 凭据类方法报 `NOT_SUPPORTED`，绝不落明文。
   */
  safeStorage: SafeStorageLike | null;
  /** AI 栈的 SQLite 迁移目录；缺省自动探测仓库布局 */
  migrationsDir?: string;
  userId?: string;
  /** 账号服务基址（缺省取 `EC_ACCOUNT_BASE_URL`，再缺省为本机自建服务） */
  accountBaseUrl?: string;
  ports: HeadlessRuntimePorts;
}

export interface HeadlessRuntime {
  /** 域控制宿主（含同步口：memory / pipeline） */
  domain: DomainControlServiceHost;
  /** 事件下发注册表（侧车把 `broadcast` 出去的事件转成协议帧） */
  events: DomainEventSink;
  /** AI 控制宿主；装配失败时为 null（原因见 `aiError`，不抛错、不阻塞其它域） */
  ai: AiControlServiceHost | null;
  aiError: string | null;
  /** 已装配 / 未装配的域及其真实原因（诊断用，与 `domain.describe()` 同源） */
  descriptors(): Promise<Array<{ kind: DomainKind; available: boolean; reason?: string }>>;
  dispose(): Promise<void>;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function createHeadlessRuntime(
  options: HeadlessRuntimeOptions,
): Promise<HeadlessRuntime> {
  const { dataDir, cacheDir, secureDir, ports } = options;
  const userId = options.userId ?? 'local-user';

  const projectsDir = resolveProjectsDir(dataDir, options.defaultWorkspaceRoot);
  const defaultWorkspaceRoot = options.defaultWorkspaceRoot;
  const db = openBusinessDb({ dataDir, userId });

  try {
    const settings = createSettingsDomain({
      dataDir,
      cacheDir,
      defaultWorkspaceRoot,
      projectsDir,
      db,
      onNotice: (message) => ports.onNotice?.(message),
    });

    const workspace = createWorkspaceDomain({ db, dataDir, projectsDir });
    const docs = createDocsDomain({ db });

    // auth 域依赖系统加密能力（DPAPI）保存凭据：不可用时**不装配**并如实上报原因，
    // 而不是装配一个"所有动作都报错"的端口。
    let auth: ReturnType<typeof createAuthDomain> | null = null;
    if (options.safeStorage !== null && options.safeStorage.isEncryptionAvailable()) {
      auth = createAuthDomain({
        baseUrl:
          options.accountBaseUrl ?? process.env['EC_ACCOUNT_BASE_URL'] ?? 'http://127.0.0.1:3000',
        safeStorage: options.safeStorage,
        secureDir,
        openExternal: (url) => ports.openExternal(url),
        writeClipboard: (text) => ports.writeClipboard(text),
      });
    }

    const unavailableReasons = { ...UNAVAILABLE_DOMAIN_REASONS };
    if (!auth) {
      unavailableReasons.auth = '系统加密能力不可用（DPAPI），无法安全保存登录凭据，账号域未装配';
    }

    // 事件 sink 先于域工厂创建：code 域外部改动监视器 / preview 后端日志 / rename 迁移日志
    // 都不属于任何一次请求，必须走 `broadcast` 这条常驻投递路径。
    const events = createDomainEventSink();

    /**
     * 受控进程端口：`allowedRoot = projectsDir` 是硬约束——渲染层递上来的 cwd
     * 必须落在工程根内，否则域内直接拒绝 spawn。
     *
     * 侧车里同样成立：侧车自己是 Node 进程，直接 `child_process.spawn`，
     * 越界判定仍在 TS 侧（与 Electron 一字不差），不需要额外的宿主能力。
     */
    const processHost = createControlledProcessHost({ allowedRoot: projectsDir });

    const credentials =
      options.safeStorage === null
        ? null
        : createGitCredentialStore({ secureDir, safeStorage: options.safeStorage });

    // ---- AI 栈（独立装配：失败不连坐域运行时） ----
    let ai: AiControlServiceHost | null = null;
    let aiError: string | null = null;
    if (options.safeStorage === null || !options.safeStorage.isEncryptionAvailable()) {
      aiError = '系统安全存储不可用（DPAPI），AI Key 不会降级为明文存储，AI 栈未装配';
    } else {
      try {
        ai = await createElectronAiRuntime({
          dataDir,
          secureDir,
          migrationsDir: options.migrationsDir ?? resolveMigrationsDir(),
          safeStorage: options.safeStorage,
          userId,
        });
      } catch (error) {
        // 如实记录并继续：设置 / 工作台 / 文档 / 记忆等域不该被 AI 栈的失败连坐。
        aiError = messageOf(error);
      }
    }

    const aiStackHandle: AiStackHandle | null = ai?.handle ?? null;

    const production = createProductionDomains({
      db,
      projectsDir,
      dataDir,
      userId,
      aiStack: aiStackHandle,
      process: processHost,
      credentials,
      /**
       * 非请求来源的事件发射口。请求内进度走 `ctx.emit`（runtime 补齐 requestId/domain）；
       * 这些事件没有所属请求，用固定哨兵 id 作为信封关联字段并走 `broadcast`。
       * 哨兵必须非空：渲染层会丢弃缺 requestId 的事件载荷。
       */
      emit: (domain: DomainKind, payload: unknown) => {
        if (!isDomainKind(domain)) return;
        events.broadcast({ requestId: WATCHER_EVENT_REQUEST_ID, domain, payload });
      },
    });

    const domain = createDomainRuntime({
      routers: {
        settings: settings.router,
        workspace: workspace.router,
        docs: docs.router,
        ...(auth ? { auth: auth.router } : {}),
        ...production.routers,
      },
      syncRouters: production.syncRouters,
      unavailableReasons,
      events,
      disposers: [
        () => settings.dispose(),
        async () => {
          db.close();
        },
        ...production.disposers,
        // 预览后端等外部进程必须在退出前杀干净：否则下次启动会撞端口、留下孤儿进程
        () => processHost.dispose(),
        async () => {
          await ai?.dispose();
        },
      ],
    });

    return {
      domain,
      events,
      ai,
      aiError,
      descriptors: () => domain.describe(),
      dispose: () => domain.dispose(),
    };
  } catch (error) {
    // 装配中途失败：连接已打开，必须在这里关掉，否则侧车退出时 WAL 里会留半截事务
    try {
      db.close();
    } catch {
      /* 已经关了 */
    }
    throw error;
  }
}
