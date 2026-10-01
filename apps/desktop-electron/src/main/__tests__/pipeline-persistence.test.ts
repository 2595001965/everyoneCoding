import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openBusinessDb } from '../domain/db';
import { PipelinePersistence } from '../domain/pipeline-persistence';

let root: string;
let db: ReturnType<typeof openBusinessDb>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ec-pipeline-tx-'));
  db = openBusinessDb({ dataDir: root });
  db.prepare(
    "INSERT INTO project (id,user_id,name,status,created_at,updated_at) VALUES ('p','local-user','test','active',1,1)",
  ).run();
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('pipeline file / SQLite commit recovery', () => {
  it('SQL failure preserves the previous checkpoint and leaves no new files', () => {
    const store = new PipelinePersistence(db, root);
    const snapshot = join(root, 'snapshot.json');
    store.commit('p', '{"version":1}', snapshot, () => {});
    store.begin('p');
    store.write('p', join(root, 'new.md'), 'new');
    store.sql('p', () => {
      throw new Error('sqlite failure');
    });
    expect(() => store.commit('p', '{"version":2}', snapshot, () => {})).toThrow('sqlite failure');
    expect(store.checkpoint('p')).toBe('{"version":1}');
    expect(readFileSync(snapshot, 'utf8')).toBe('{"version":1}');
    expect(readdirSync(root)).not.toContain('new.md');
    expect(readdirSync(join(root, 'pipeline-transactions'))).toEqual([]);
  });

  it.each([false, true])('restart after file publication, SQLite committed=%s', (committed) => {
    const store = new PipelinePersistence(db, root);
    const snapshot = join(root, 'snapshot.json');
    store.commit('p', 'old checkpoint', snapshot, () => {});
    const transactionId = 'interrupted-transaction';
    const file = join(root, 'artifact.md');
    // Reproduce the exact durable boundary: undo journal exists and final file was replaced.
    writeFileSync(file, 'new artifact');
    writeFileSync(
      join(root, 'pipeline-transactions/interrupted.json'),
      JSON.stringify({
        projectId: 'p',
        transactionId,
        files: [{ path: file, before: 'old artifact' }],
      }),
    );
    if (committed)
      db.prepare(
        'INSERT INTO pipeline_commit_receipt (transaction_id,project_id) VALUES (?,?)',
      ).run(transactionId, 'p');
    db.close();
    db = openBusinessDb({ dataDir: root });
    new PipelinePersistence(db, root);
    expect(readFileSync(file, 'utf8')).toBe(committed ? 'new artifact' : 'old artifact');
    expect(readdirSync(join(root, 'pipeline-transactions'))).toEqual([]);
  });
});
