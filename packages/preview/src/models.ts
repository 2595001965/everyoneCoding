/**
 * 预览领域基础类型与结构化日志收集器。
 *
 * 约束：
 * - 所有对外日志统一经 PreviewLogCollector，内部调用 @ec/core 的 mask 脱敏，
 *   任何明文密钥/密码/连接串都不会出现在日志里（NFR-S-04）。
 * - 错误只携带 code + 中文说明，不携带敏感原文。
 */

import { mask } from '@ec/core';

export type PreviewLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PreviewLogEntry {
  level: PreviewLogLevel;
  message: string;
  raw?: string;
  at: number;
}

export interface PreviewError {
  code: string;
  message: string;
}

export interface PreviewResult<T> {
  ok: boolean;
  data: T | null;
  logs: PreviewLogEntry[];
  error: PreviewError | null;
}

export function ok<T>(data: T, logs: PreviewLogEntry[] = []): PreviewResult<T> {
  return { ok: true, data, logs, error: null };
}

export function fail<T>(code: string, message: string, logs: PreviewLogEntry[] = []): PreviewResult<T> {
  return { ok: false, data: null, logs, error: { code, message } };
}

/** 结构化日志收集器：统一脱敏 + 分级。clock 可注入以便测试时间确定性。 */
export class PreviewLogCollector {
  private readonly entriesList: PreviewLogEntry[] = [];
  private readonly clock: () => number;

  constructor(opts?: { clock?: () => number }) {
    this.clock = opts?.clock ?? (() => Date.now());
  }

  debug(message: string, raw?: string): void {
    this.push('debug', message, raw);
  }

  info(message: string, raw?: string): void {
    this.push('info', message, raw);
  }

  warn(message: string, raw?: string): void {
    this.push('warn', message, raw);
  }

  error(message: string, raw?: string): void {
    this.push('error', message, raw);
  }

  private push(level: PreviewLogLevel, message: string, raw?: string): void {
    const masked = mask(message);
    this.entriesList.push({
      level,
      message: masked,
      ...(raw !== undefined ? { raw: mask(raw) } : {}),
      at: this.clock(),
    });
  }

  entries(): PreviewLogEntry[] {
    return this.entriesList.slice();
  }
}

export type HttpMethodName = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type DataSourceKind = 'backend' | 'mock' | 'static';

export const DATA_SOURCE_LABELS: Record<DataSourceKind, string> = {
  backend: '后端',
  mock: 'Mock',
  static: '静态假数据',
};
