/**
 * 端口分配：在端口被占用时顺延到下一个可用端口。
 *
 * 纯逻辑（nextFreePort）便于单测；allocatePort 通过注入的 probe 做真实探测。
 */

export const DEFAULT_PREVIEW_PORT = 4173;

/** probe 返回 true 表示端口可用（未占用）。可返回 Promise 或同步值。 */
export interface PortProbe {
  (port: number): Promise<boolean> | boolean;
}

export interface PortAllocation {
  port: number;
  shifted: boolean;
  attempts: number;
  log: string | null;
}

const MAX_PORT = 65535;

/** 纯函数：给定占用集合找下一个可用端口（便于单测）。 */
export function nextFreePort(
  start: number,
  taken: readonly number[],
  maxAttempts = 20,
): PortAllocation | null {
  const occupied = new Set(taken);
  for (let i = 0; i < maxAttempts; i++) {
    const port = start + i;
    if (port > MAX_PORT) return null;
    if (!occupied.has(port)) {
      return {
        port,
        shifted: i > 0,
        attempts: i + 1,
        log: i > 0 ? `端口 ${start} 被占用，顺延至 ${port}` : null,
      };
    }
  }
  return null;
}

/** 异步分配：用注入的 probe 探测端口是否可用，命中占用则顺延。 */
export async function allocatePort(input: {
  start: number;
  probe: PortProbe;
  maxAttempts?: number;
}): Promise<PortAllocation> {
  const maxAttempts = input.maxAttempts ?? 20;
  let lastAttempt = maxAttempts;
  for (let i = 0; i < maxAttempts; i++) {
    const port = input.start + i;
    lastAttempt = i + 1;
    if (port > MAX_PORT) {
      return {
        port: input.start,
        shifted: false,
        attempts: lastAttempt,
        log: `端口超出有效范围（${MAX_PORT}），分配失败`,
      };
    }
    const free = await input.probe(port);
    if (free) {
      return {
        port,
        shifted: i > 0,
        attempts: i + 1,
        log: i > 0 ? `端口 ${input.start} 被占用，顺延至 ${port}` : null,
      };
    }
  }
  return {
    port: input.start,
    shifted: false,
    attempts: lastAttempt,
    log: `在 ${maxAttempts} 次尝试内未找到可用端口`,
  };
}
