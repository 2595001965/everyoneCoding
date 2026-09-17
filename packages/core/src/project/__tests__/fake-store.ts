/**
 * 测试夹具：内存假存储 + 固定时钟。
 * 不触碰 SQLite（core 不依赖 @ec/data 的运行时），复现真实语义。
 */

import type {
  ProjectDuplicatePort,
  ProjectRowSnapshot,
  ProjectStore,
  DuplicateOptions,
} from '../project-types';

export class FakeProjectStore implements ProjectStore {
  readonly rows = new Map<string, ProjectRowSnapshot>();

  loadAll(): Promise<ProjectRowSnapshot[]> {
    return Promise.resolve([...this.rows.values()].map((row) => ({ ...row })));
  }

  loadById(id: string): Promise<ProjectRowSnapshot | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? { ...row } : null);
  }

  insert(row: ProjectRowSnapshot): Promise<void> {
    this.rows.set(row.id, { ...row });
    return Promise.resolve();
  }

  update(id: string, patch: Partial<ProjectRowSnapshot>): Promise<void> {
    const current = this.rows.get(id);
    if (!current) throw new Error(`行不存在：${id}`);
    this.rows.set(id, { ...current, ...patch });
    return Promise.resolve();
  }

  deleteRow(id: string): Promise<void> {
    this.rows.delete(id);
    return Promise.resolve();
  }
}

export class FakeDuplicatePort implements ProjectDuplicatePort {
  readonly calls: Array<{ sourceId: string; targetId: string; options: DuplicateOptions }> = [];

  constructor(private readonly counts = { design: 3, memory: 5, docs: 2, codeFiles: 7 }) {}

  copyResources(
    sourceId: string,
    targetId: string,
    options: DuplicateOptions,
  ): Promise<{ design: number; memory: number; docs: number; codeFiles: number }> {
    this.calls.push({ sourceId, targetId, options });
    return Promise.resolve({
      design: options.includeDesign ? this.counts.design : 0,
      memory: options.includeMemory ? this.counts.memory : 0,
      docs: options.includeDocs ? this.counts.docs : 0,
      codeFiles: options.includeCode ? this.counts.codeFiles : 0,
    });
  }
}

/** 可拨动的时钟 */
export function createClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** 递增 id 生成（避免随机性影响断言） */
export function createIdFactory(prefix = 'id'): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n).padStart(3, '0')}`;
  };
}
