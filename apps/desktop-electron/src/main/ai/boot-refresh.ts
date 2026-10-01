import type { AiControlServiceHost } from '@ec/shell-api';

/**
 * 启动时静默刷新远程配置源（FR-MDL-06 / T12-08）。
 *
 * 三条硬约束：
 * - **不阻塞窗口**：调用方在建窗之后 `void` 掉本函数；这里再套一层让出（`setTimeout`），
 *   保证即便调用方写成同步链路，首帧也不会等网络；
 * - **绝不抛错**：远程源不可达 / 签名失败 / 超时都只记结果，本地缓存继续可用；
 * - **有总时限**：单源拉取自带 15s 超时，这里再加总闸，防止多个慢源串行拖住退出流程。
 *
 * 每个源的「上次拉取时间 / 状态 / 失败原因」由 `fetchRemoteSource` 落在
 * `remote_config_source` 表里，设置页直接读，不依赖本函数的返回值。
 */

export interface BootRefreshSummaryItem {
  id: string;
  name: string;
  ok: boolean;
  status: string;
  message: string;
  usingCache: boolean;
  created: string[];
  pendingDefaultModel: { before: string | null; after: string; revision: string } | null;
}

export interface BootRefreshSummary {
  ok: boolean;
  /** 整体失败原因（RPC 失败 / 超时）；逐源原因见 items */
  error: string | null;
  items: BootRefreshSummaryItem[];
  tookMs: number;
}

export interface BootRefreshOptions {
  /** 让出多久再开始（默认 0：下一个宏任务） */
  delayMs?: number;
  /** 总时限（默认 60s） */
  timeoutMs?: number;
  logger?: Pick<Console, 'info' | 'warn'>;
}

export const BOOT_REFRESH_REQUEST_ID = 'boot-remote-config-refresh';

export async function refreshRemoteConfigOnBoot(
  host: Pick<AiControlServiceHost, 'invoke'> | null,
  options: BootRefreshOptions = {},
): Promise<BootRefreshSummary> {
  const started = Date.now();
  const logger = options.logger ?? console;
  if (host === null) {
    return { ok: false, error: 'AI 栈未装配，跳过远程配置刷新', items: [], tookMs: 0 };
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, options.delayMs ?? 0)));

  const timeoutMs = options.timeoutMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    const response = await Promise.race([
      host.invoke({
        requestId: BOOT_REFRESH_REQUEST_ID,
        method: 'refreshRemoteSourcesOnBoot',
        params: {},
      }),
      timeout,
    ]);
    if (response === 'timeout') {
      const error = `远程配置刷新超过 ${Math.round(timeoutMs / 1000)}s 未完成，继续使用本地缓存`;
      logger.warn(`[AI] ${error}`);
      return { ok: false, error, items: [], tookMs: Date.now() - started };
    }
    if (!response.ok) {
      const error = response.error?.message ?? '远程配置刷新失败';
      logger.warn(`[AI] 远程配置刷新失败，继续使用本地缓存：${error}`);
      return { ok: false, error, items: [], tookMs: Date.now() - started };
    }
    const items = toSummaryItems(response.result);
    for (const item of items) {
      if (item.ok) {
        const created = item.created.length > 0 ? `，新增服务 ${item.created.join('、')}` : '';
        logger.info(`[AI] 远程配置源「${item.name}」已刷新${created}`);
      } else {
        logger.warn(
          `[AI] 远程配置源「${item.name}」刷新失败（${item.status}）：${item.message}` +
            (item.usingCache ? '；继续使用上次缓存' : ''),
        );
      }
    }
    return { ok: true, error: null, items, tookMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[AI] 远程配置刷新异常，继续使用本地缓存：${message}`);
    return { ok: false, error: message, items: [], tookMs: Date.now() - started };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function toSummaryItems(result: unknown): BootRefreshSummaryItem[] {
  if (!Array.isArray(result)) return [];
  return result.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const fetch = (item['result'] ?? {}) as Record<string, unknown>;
    const applied = item['applied'] as { created?: unknown } | null | undefined;
    return {
      id: String(item['id'] ?? ''),
      name: String(item['name'] ?? item['id'] ?? ''),
      ok: fetch['ok'] === true,
      status: String(fetch['status'] ?? 'unknown'),
      message: String(fetch['message'] ?? ''),
      usingCache: item['usingCache'] === true,
      created: Array.isArray(applied?.created) ? applied.created.map(String) : [],
      pendingDefaultModel:
        (item['pendingDefaultModel'] as BootRefreshSummaryItem['pendingDefaultModel']) ?? null,
    };
  });
}
