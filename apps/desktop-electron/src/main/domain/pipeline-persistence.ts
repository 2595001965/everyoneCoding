import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

type Batch = { files: Map<string, string | null>; sql: Array<() => void> };
type Undo = {
  projectId: string;
  transactionId: string;
  files: Array<{ path: string; before: string | null }>;
};

/** Stage IO is buffered until generation succeeds. SQL, the checkpoint and file publication
 * share one commit. A durable undo journal repairs interruption before SQLite commits. */
export class PipelinePersistence {
  private readonly batches = new Map<string, Batch>();
  private readonly journalDir: string;

  constructor(
    private readonly db: Database.Database,
    dataDir: string,
  ) {
    this.journalDir = join(dataDir, 'pipeline-transactions');
    mkdirSync(this.journalDir, { recursive: true });
    for (const name of readdirSync(this.journalDir).filter((file) => file.endsWith('.json'))) {
      const path = join(this.journalDir, name);
      const undo = JSON.parse(readFileSync(path, 'utf8')) as Undo;
      const committed = db
        .prepare('SELECT transaction_id FROM pipeline_commit_receipt WHERE transaction_id = ?')
        .get(undo.transactionId) as { transaction_id: string } | undefined;
      if (!committed) this.restore(undo);
      rmSync(path, { force: true });
      db.prepare('DELETE FROM pipeline_commit_receipt WHERE transaction_id = ?').run(
        undo.transactionId,
      );
    }
  }

  begin(projectId: string): void {
    if (this.batches.has(projectId)) throw new Error('流水线事务正在执行');
    this.batches.set(projectId, { files: new Map(), sql: [] });
  }

  discard(projectId: string): void {
    this.batches.delete(projectId);
  }

  write(projectId: string, path: string, content: string | null): void {
    const batch = this.batches.get(projectId);
    if (!batch) throw new Error('流水线写入必须在事务内');
    batch.files.set(path, content);
  }

  read(projectId: string, path: string): string | null {
    const files = this.batches.get(projectId)?.files;
    if (files?.has(path)) return files.get(path) ?? null;
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }

  sql(projectId: string, action: () => void): void {
    const batch = this.batches.get(projectId);
    if (!batch) throw new Error('流水线 SQL 写入必须在事务内');
    batch.sql.push(action);
  }

  checkpoint(projectId: string): string | null {
    const row = this.db
      .prepare('SELECT envelope_json FROM pipeline_checkpoint WHERE project_id = ?')
      .get(projectId) as { envelope_json: string } | undefined;
    return row?.envelope_json ?? null;
  }

  commit(projectId: string, envelope: string, snapshotPath: string, pointer: () => void): void {
    const batch = this.batches.get(projectId) ?? {
      files: new Map<string, string | null>(),
      sql: [],
    };
    batch.files.set(snapshotPath, envelope);
    const transactionId = randomUUID();
    const undo: Undo = {
      projectId,
      transactionId,
      files: [...batch.files.keys()].map((path) => ({
        path,
        before: existsSync(path) ? readFileSync(path, 'utf8') : null,
      })),
    };
    const journal = join(this.journalDir, `${transactionId}.json`);
    atomicWrite(journal, JSON.stringify(undo));
    try {
      this.db.transaction(() => {
        for (const action of batch.sql) action();
        pointer();
        for (const [path, content] of batch.files) {
          if (content === null) rmSync(path, { force: true });
          else atomicWrite(path, content);
        }
        this.db
          .prepare(
            `INSERT INTO pipeline_checkpoint (project_id, transaction_id, envelope_json)
          VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET transaction_id=excluded.transaction_id, envelope_json=excluded.envelope_json`,
          )
          .run(projectId, transactionId, envelope);
        this.db
          .prepare('INSERT INTO pipeline_commit_receipt (transaction_id, project_id) VALUES (?, ?)')
          .run(transactionId, projectId);
      })();
    } catch (cause) {
      this.restore(undo);
      rmSync(journal, { force: true });
      this.db
        .prepare('DELETE FROM pipeline_commit_receipt WHERE transaction_id = ?')
        .run(transactionId);
      throw cause;
    } finally {
      this.batches.delete(projectId);
    }
    // A committed journal is harmless and is cleaned at next startup if removal fails.
    try {
      rmSync(journal, { force: true });
      this.db
        .prepare('DELETE FROM pipeline_commit_receipt WHERE transaction_id = ?')
        .run(transactionId);
    } catch {
      /* recovered on next startup */
    }
  }

  private restore(undo: Undo): void {
    for (const { path, before } of [...undo.files].reverse()) {
      if (before === null) rmSync(path, { force: true });
      else atomicWrite(path, before);
      rmSync(`${path}.ec-tmp`, { force: true });
    }
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.ec-tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
