import Database from 'better-sqlite3';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentStore } from '@ec/ai';
import { createCliGitBackend, createNodeGitRunner } from '@ec/git';
import { TaskWriteService } from '../../domain/task-write-service';

async function main(): Promise<void> {
const [directory, mode] = process.argv.slice(2);
if (directory === undefined) throw new Error('missing fixture directory');
const db = new Database(join(directory, 'owner.sqlite'));
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS agent_coordinator_lease(data_domain TEXT PRIMARY KEY,owner TEXT,fencing_token INTEGER,acquired_at INTEGER,expiry_at INTEGER)');
const store = new AgentStore(db, 'd07-test', 600);
if (!store.acquire()) throw new Error('owner busy');
const renew = mode === 'crash' ? setInterval(() => store.renew(), 100) : null;
const service = new TaskWriteService({
  storageDir: join(directory, 'tasks'), codeRoot: () => join(directory, 'source'),
  git: createCliGitBackend({ runner: createNodeGitRunner() }),
  owner: { assertOwner: () => store.assertOwner(), fencingToken: () => store.token!, write: (action) => store.write(action) },
  validate: async () => {
    writeFileSync(join(directory, 'applied'), 'ready');
    await new Promise(() => undefined); // parent 强制结束，模拟文件写入后/commit 日志前的崩溃
    return [];
  },
});
const plan = await service.planOutput('p', {
  files: ['a.ts', 'b.ts'].map((path) => ({ path, language: 'typescript', action: 'patch' as const, content: '@@ -1 +1 @@\n-old\n+task' })),
  anchors: [], summary: 'crash task', notes: '', decision: { referencedMemory: [], rationale: 'test', risks: [], uncovered: [] },
}, 'preview', { baseline: 'current', readSet: [] });
writeFileSync(join(directory, 'ready'), plan.taskId!);
if (mode === 'stale') {
  while (!existsSync(join(directory, 'resume'))) await new Promise((resolve) => setTimeout(resolve, 20));
  try { await service.merge(plan); writeFileSync(join(directory, 'outcome'), 'wrote'); }
  catch { writeFileSync(join(directory, 'outcome'), 'fenced'); }
  db.close();
} else {
  await service.merge(plan);
}
if (renew !== null) clearInterval(renew);
}
void main().catch((error: unknown) => { process.stderr.write(String(error)); process.exitCode = 1; });
