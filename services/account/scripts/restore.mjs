import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2).filter((argument) => argument !== '--');
const backupPath = args[0] ? resolve(args[0]) : '';
const databasePath = resolve(process.env.ACCOUNT_DB_PATH || 'data/account.db');
const apply = args.slice(1).includes('--apply');
if (!backupPath || backupPath === databasePath || !existsSync(backupPath)) {
  throw new Error('Usage: node scripts/restore.mjs <verified-backup.sqlite> [--apply]');
}
const walPath = `${databasePath}-wal`;
const shmPath = `${databasePath}-shm`;
const hasSidecars = () => existsSync(walPath) || existsSync(shmPath);

const source = new Database(backupPath, { readonly: true, fileMustExist: true });
try {
  const integrity = source.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`Backup integrity check failed: ${String(integrity)}`);
  const foreignKeys = source.pragma('foreign_key_check');
  if (foreignKeys.length !== 0)
    throw new Error(`Backup has ${foreignKeys.length} foreign-key violations.`);
} finally {
  source.close();
}

if (!apply) {
  process.stdout.write(`Verified backup: ${backupPath}\n`);
  process.stdout.write(`Target database: ${databasePath}\n`);
  if (hasSidecars()) {
    process.stdout.write(
      'WAL/SHM sidecars are present. Stop the service before --apply; the restore will checkpoint SQLite safely.\n',
    );
  }
  process.stdout.write(
    'No files changed. Stop the service, inspect these paths, then repeat with --apply.\n',
  );
  process.exit(2);
}

// --apply is an offline operator action. Checkpoint SQLite through its API instead
// of deleting WAL/SHM files, then refuse to replace the database if frames remain.
if (hasSidecars() && existsSync(databasePath)) {
  const target = new Database(databasePath);
  try {
    const checkpoint = target.pragma('wal_checkpoint(TRUNCATE)')[0];
    if (
      !checkpoint ||
      checkpoint.busy !== 0 ||
      (checkpoint.log >= 0 && checkpoint.log !== checkpoint.checkpointed)
    ) {
      throw new Error(
        'SQLite WAL checkpoint is busy or incomplete. Confirm the service is stopped and retry.',
      );
    }
    const mode = target.pragma('journal_mode = DELETE', { simple: true });
    if (mode !== 'delete') throw new Error(`Could not leave WAL mode safely: ${String(mode)}`);
  } finally {
    target.close();
  }
  if (hasSidecars())
    throw new Error('SQLite WAL/SHM sidecars remain after checkpoint; database was not replaced.');
}

mkdirSync(dirname(databasePath), { recursive: true });
const stagePath = join(
  dirname(databasePath),
  `.${basename(databasePath)}.restore-${process.pid}.tmp`,
);
const timestamp = new Date().toISOString().replaceAll(':', '-');
const safetyPath = `${databasePath}.pre-restore-${timestamp}.sqlite`;
const replacedPath = `${databasePath}.replaced-${timestamp}`;
if (existsSync(stagePath) || existsSync(safetyPath) || existsSync(replacedPath))
  throw new Error('Staging or safety backup path already exists.');

const verifiedSource = new Database(backupPath, { readonly: true, fileMustExist: true });
try {
  await verifiedSource.backup(stagePath);
} finally {
  verifiedSource.close();
}
if (process.platform !== 'win32') chmodSync(stagePath, 0o600);
const staged = new Database(stagePath, { readonly: true, fileMustExist: true });
try {
  if (staged.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw new Error('Staged restore failed SQLite integrity check.');
  }
} finally {
  staged.close();
}

let current = null;
try {
  if (existsSync(databasePath)) {
    current = new Database(databasePath, { readonly: true, fileMustExist: true });
    await current.backup(safetyPath);
    if (process.platform !== 'win32') chmodSync(safetyPath, 0o600);
  }
} finally {
  current?.close();
}

let movedCurrent = false;
try {
  if (existsSync(databasePath)) {
    renameSync(databasePath, replacedPath);
    if (process.platform !== 'win32') chmodSync(replacedPath, 0o600);
    movedCurrent = true;
  }
  renameSync(stagePath, databasePath);
  if (process.platform !== 'win32') chmodSync(databasePath, 0o600);
} catch (error) {
  if (movedCurrent && !existsSync(databasePath)) renameSync(replacedPath, databasePath);
  throw error;
}

process.stdout.write(`Database restored from verified backup: ${databasePath}\n`);
if (movedCurrent)
  process.stdout.write(`Pre-restore snapshots: ${safetyPath} and ${replacedPath}\n`);
process.stdout.write(
  'Start the service to apply any pending migrations, then verify /health and account data.\n',
);
