import Database from 'better-sqlite3';
import type { ShellHost } from '@ec/shell-api';

/**
 * SQLite 连接单例封装。
 *
 * 约定：
 * - 连接开启即设置 WAL、busy_timeout、foreign_keys ON（NFR-P-03 / 数据一致性）
 * - 数据目录通过 Shell API 获取，业务层不自行拼接 AppData 路径
 * - 同进程只应存在一个指向同一文件的 DataClient
 */

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export const DEFAULT_DB_FILE_NAME = 'everyonecoding.sqlite';

export interface DataClientOptions {
  /** 数据库文件路径；缺省为 ':memory:' */
  filePath?: string;
  readonly?: boolean;
  /** 默认 true；内存库会自动降级为 memory 日志模式 */
  enableWal?: boolean;
  busyTimeoutMs?: number;
  /** 关闭 foreign_keys，仅供迁移等特殊场景使用 */
  disableForeignKeys?: boolean;
}

export class DataClient {
  private readonly database: Database.Database;
  private closed = false;

  private constructor(database: Database.Database) {
    this.database = database;
  }

  static open(options: DataClientOptions = {}): DataClient {
    const filePath = options.filePath ?? ':memory:';
    const database = new Database(filePath, {
      readonly: options.readonly ?? false,
      // 原生模块内部抛错时带上 SQL 上下文，便于定位
    });

    if (options.enableWal ?? true) {
      try {
        database.pragma('journal_mode = WAL');
      } catch {
        // 只读库或内存库可能不支持 WAL，忽略即可
      }
    }
    database.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    database.pragma(options.disableForeignKeys ?? false ? 'foreign_keys = OFF' : 'foreign_keys = ON');

    return new DataClient(database);
  }

  /** 通过外壳 API 获取数据目录后打开（数据本地优先，路径由外壳决定） */
  static async openFromShell(
    shell: ShellHost,
    fileName: string = DEFAULT_DB_FILE_NAME,
    options: Omit<DataClientOptions, 'filePath'> = {},
  ): Promise<DataClient> {
    const dataDir = await shell.appInfo.getDataDir();
    await shell.fs.mkdir(dataDir, { recursive: true });
    const filePath = shell.path.join(dataDir, fileName);
    return DataClient.open({ ...options, filePath });
  }

  /** 供测试与迁移框架使用的底层句柄 */
  get raw(): Database.Database {
    if (this.closed) throw new Error('DataClient 已关闭，无法继续使用');
    return this.database;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** 外键完整性检查，返回违规行（正常为空数组） */
  foreignKeyCheck(): string[] {
    const rows = this.raw.pragma('foreign_key_check') as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => JSON.stringify(row));
  }

  /** 关闭连接；可重复调用 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
