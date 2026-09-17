/**
 * 数据库初始化与三段式迁移执行。
 * 迁移文件命名与既有约定一致：-- migration: 0001_xxx / -- up / -- down。
 * 启动时按文件名排序、幂等（已执行则跳过）执行 up 段。
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type SqliteDatabase = InstanceType<typeof Database>;

interface ParsedMigration {
  name: string;
  up: string;
  down: string;
}

function parseMigration(content: string, fallbackName: string): ParsedMigration {
  const migrationMatch = content.match(/--\s*migration:\s*(\S+)/);
  const name = migrationMatch?.[1] ?? fallbackName;
  const upIdx = content.indexOf('-- up');
  const downIdx = content.indexOf('-- down');
  const upStart = upIdx >= 0 ? upIdx + '-- up'.length : 0;
  const upEnd = downIdx >= 0 ? downIdx : content.length;
  const up = content.slice(upStart, upEnd);
  const down = downIdx >= 0 ? content.slice(downIdx + '-- down'.length) : '';
  return { name, up, down };
}

export function openDatabase(dbPath: string): SqliteDatabase {
  const resolved = dbPath === ':memory:' ? ':memory:' : dbPath;
  if (resolved !== ':memory:') {
    const dir = dirname(resolved);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function runMigrations(db: SqliteDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY NOT NULL,
       applied_at INTEGER NOT NULL
     )`,
  );
  const applied = new Set<string>(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((r: unknown) => (r as { name: string }).name),
  );

  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const insertApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  );

  const migrate = db.transaction((items: ParsedMigration[]) => {
    for (const item of items) {
      if (applied.has(item.name)) continue;
      db.exec(item.up);
      insertApplied.run(item.name, Date.now());
    }
  });

  const parsed: ParsedMigration[] = files.map((f) =>
    parseMigration(readFileSync(join(migrationsDir, f), 'utf8'), f),
  );
  migrate(parsed);
}
