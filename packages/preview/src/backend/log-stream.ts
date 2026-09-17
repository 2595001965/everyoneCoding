/**
 * 日志流：把后端/安装/构建的子进程输出统一成结构化日志行，支持分级、过滤、上限裁剪与订阅。
 *
 * 文本统一经 @ec/core 的 mask 脱敏，密钥/密码不落盘明文（NFR-S-04）。
 */

import { mask } from '@ec/core';
import type { PreviewLogLevel } from '../models';

export type LogStreamSource = 'install' | 'run' | 'build' | 'task';

export interface StreamedLogLine {
  id: string;
  source: LogStreamSource;
  level: PreviewLogLevel;
  text: string;
  at: number;
  stream: 'stdout' | 'stderr';
}

const ERROR_RE = /(错误|失败|异常|报错|fatal|exception|error|panic)/i;
const WARN_RE = /(警告|弃用|deprecated|warn|timeout)/i;

export class LogStream {
  private readonly clock: () => number;
  private readonly max: number;
  private linesList: StreamedLogLine[] = [];
  private listeners = new Set<(line: StreamedLogLine) => void>();
  private seq = 0;

  constructor(opts?: { clock?: () => number; max?: number }) {
    this.clock = opts?.clock ?? (() => Date.now());
    this.max = opts?.max ?? 1000;
  }

  /** 分级着色判定：stderr/错误关键字 → error，警告关键字 → warn。 */
  classify(text: string, stream: 'stdout' | 'stderr'): PreviewLogLevel {
    if (stream === 'stderr') return 'error';
    if (ERROR_RE.test(text)) return 'error';
    if (WARN_RE.test(text)) return 'warn';
    return 'info';
  }

  push(input: {
    source: LogStreamSource;
    text: string;
    stream?: 'stdout' | 'stderr';
    raw?: string;
  }): StreamedLogLine {
    const stream = input.stream ?? 'stdout';
    const masked = mask(input.text);
    const line: StreamedLogLine = {
      id: `log-${this.seq}`,
      source: input.source,
      level: this.classify(input.text, stream),
      text: masked,
      at: this.clock(),
      stream,
    };
    this.seq += 1;
    this.linesList.push(line);
    if (this.linesList.length > this.max) {
      this.linesList = this.linesList.slice(this.linesList.length - this.max);
    }
    for (const listener of this.listeners) listener(line);
    return line;
  }

  lines(filter?: { level?: PreviewLogLevel; keyword?: string; source?: LogStreamSource }): StreamedLogLine[] {
    let out = this.linesList;
    if (filter?.level !== undefined) out = out.filter((l) => l.level === filter.level);
    if (filter?.source !== undefined) out = out.filter((l) => l.source === filter.source);
    if (filter?.keyword !== undefined && filter.keyword !== '') {
      const kw = filter.keyword.toLowerCase();
      out = out.filter((l) => l.text.toLowerCase().includes(kw));
    }
    return out.slice();
  }

  clear(): void {
    this.linesList = [];
  }

  subscribe(listener: (line: StreamedLogLine) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 便捷：以 task 来源登记一条信息日志。 */
  info(text: string): void {
    this.push({ source: 'task', text, stream: 'stdout' });
  }

  warn(text: string): void {
    this.push({ source: 'task', text, stream: 'stdout' });
  }

  debug(text: string): void {
    this.push({ source: 'task', text, stream: 'stdout' });
  }

  error(text: string): void {
    this.push({ source: 'task', text, stream: 'stderr' });
  }
}
