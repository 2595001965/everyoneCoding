import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databasePath = resolve(process.env.ACCOUNT_DB_PATH || 'data/account.db');
const args = process.argv.slice(2).filter((argument) => argument !== '--');
const requested =
  args[0] || `backups/account-${new Date().toISOString().replaceAll(':', '-')}.sqlite`;
const backupPath = resolve(requested);
if (backupPath === databasePath) throw new Error('Backup path must differ from ACCOUNT_DB_PATH.');
if (existsSync(backupPath)) throw new Error(`Backup already exists: ${backupPath}`);
mkdirSync(dirname(backupPath), { recursive: true });

const db = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  await db.backup(backupPath);
} finally {
  db.close();
}

const snapshot = new Database(backupPath, { readonly: true, fileMustExist: true });
try {
  const integrity = snapshot.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
  const foreignKeys = snapshot.pragma('foreign_key_check');
  if (foreignKeys.length !== 0)
    throw new Error(`Backup has ${foreignKeys.length} foreign-key violations.`);
} finally {
  snapshot.close();
}

if (process.platform !== 'win32') chmodSync(backupPath, 0o600);
process.stdout.write(`Verified SQLite snapshot created: ${backupPath}\n`);
