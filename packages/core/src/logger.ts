import { maskObject } from './redaction';

/**
 * 结构化日志。
 *
 * - 分级：debug / info / warn / error
 * - 输出前统一脱敏（NFR-S-04），明文 Key / Token / 邮箱 / 手机号不会进入日志
 * - 支持多 transport，文件 transport 按段文件轮转
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  level: LogLevel;
  scope: string;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface LogTransport {
  write(entry: LogEntry): void | Promise<void>;
}

export interface LoggerOptions {
  scope?: string;
  level?: LogLevel;
  transports?: LogTransport[];
}

export class Logger {
  readonly scope: string;
  private level: LogLevel;
  private readonly transports: LogTransport[];

  constructor(options: LoggerOptions = {}) {
    this.scope = options.scope ?? 'app';
    this.level = options.level ?? 'info';
    this.transports = options.transports ?? [consoleTransport()];
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  addTransport(transport: LogTransport): void {
    this.transports.push(transport);
  }

  /** 派生子日志器，继承 transport 与级别 */
  child(scope: string): Logger {
    const child = new Logger({ scope: `${this.scope}:${scope}`, level: this.level });
    for (const transport of this.transports) child.addTransport(transport);
    return child;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.level];
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const entry: LogEntry = {
      level,
      scope: this.scope,
      message: maskObject(message),
      timestamp: Date.now(),
      ...(data !== undefined ? { data: maskObject(data) } : {}),
    };
    for (const transport of this.transports) void transport.write(entry);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }
}

export function consoleTransport(): LogTransport {
  return {
    write(entry) {
      const prefix = `[${new Date(entry.timestamp).toISOString()}] [${entry.level.toUpperCase()}] [${entry.scope}]`;
      const line = `${prefix} ${entry.message}`;
      /* eslint-disable no-console */
      if (entry.level === 'error') console.error(line, entry.data ?? '');
      else if (entry.level === 'warn') console.warn(line, entry.data ?? '');
      else console.info(line, entry.data ?? '');
      /* eslint-enable no-console */
    },
  };
}

export interface MemoryTransportOptions {
  limit?: number;
}

/** 内存 transport：测试断言与"复制日志"功能使用 */
export function memoryTransport(options: MemoryTransportOptions = {}): LogTransport & {
  entries: LogEntry[];
  clear(): void;
  text(): string;
} {
  const entries: LogEntry[] = [];
  const limit = options.limit ?? 500;
  return {
    entries,
    write(entry) {
      entries.push(entry);
      if (entries.length > limit) entries.shift();
    },
    clear() {
      entries.length = 0;
    },
    text() {
      return entries.map((e) => `${e.level} ${e.scope} ${e.message}`).join('\n');
    },
  };
}

/**
 * 文件 transport：按段文件轮转（每达到 maxBytes 或显式 flush 时落一个段文件，
 * 超过 maxFiles 的旧段被删除）。落盘走原子写，断电不产生半截日志。
 */
export function fileTransport(options: {
  writeFile: (path: string, content: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
}): LogTransport & { flush(): Promise<void> } {
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const maxFiles = options.maxFiles ?? 5;
  let buffer: string[] = [];
  const segments: string[] = [];
  let size = 0;

  const rotate = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const content = `${buffer.join('\n')}\n`;
    const segment = `${options.dir}/app-${Date.now()}.log`;
    await options.writeFile(segment, content);
    segments.push(segment);
    buffer = [];
    size = 0;
    while (segments.length > maxFiles) {
      const oldest = segments.shift();
      if (oldest) await options.removeFile(oldest);
    }
  };

  return {
    async write(entry) {
      const line = `${new Date(entry.timestamp).toISOString()} ${entry.level.toUpperCase()} ${entry.scope} ${entry.message}${
        entry.data ? ` ${JSON.stringify(entry.data)}` : ''
      }`;
      buffer.push(line);
      size += line.length;
      if (size >= maxBytes) await rotate();
    },
    flush: rotate,
  };
}

/** 默认日志器实例 */
export const logger = new Logger();
