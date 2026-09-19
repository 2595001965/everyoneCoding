import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BackupScheduler,
  computeNextRun,
  isCatchUpDue,
  parseTimeOfDay,
  type TimerPort,
} from '../backup/scheduler';
import {
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreFromSnapshot,
} from '../backup/snapshot-manager';
import { advanceCursor, compareIncrementalVolume, isInIncrementalWindow } from '../incremental';
import type { ImportReportData } from '../import/import-types';

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpkg-backup-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('备份调度（T8-04 / FR-PKG-13：客户端内调度，不依赖系统任务计划）', () => {
  const dailyConfig = {
    enabled: true,
    frequency: 'daily' as const,
    timeOfDay: '09:00',
    targetDir: 'D:/backups',
    keepCount: 7,
  };

  it('parseTimeOfDay 校验 HH:mm', () => {
    expect(parseTimeOfDay('09:00')).toEqual({ hours: 9, minutes: 0 });
    expect(parseTimeOfDay('23:59')).toEqual({ hours: 23, minutes: 59 });
    expect(() => parseTimeOfDay('24:00')).toThrow('不合法');
    expect(() => parseTimeOfDay('9:0')).toThrow('不合法');
  });

  it('daily：今天未到取今天，已过取明天', () => {
    const morning = new Date(2026, 8, 13, 8, 0); // 08:00
    const next = computeNextRun(dailyConfig, morning, null);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(8);
    expect(next.getDate()).toBe(13);
    expect(next.getHours()).toBe(9);

    const afterRun = new Date(2026, 8, 13, 10, 0); // 10:00（当天已跑过）
    const next2 = computeNextRun(dailyConfig, afterRun, afterRun.getTime());
    expect(next2.getDate()).toBe(14);
    expect(next2.getHours()).toBe(9);
  });

  it('weekly：取下一个目标星期（默认周一）', () => {
    const config = { ...dailyConfig, frequency: 'weekly' as const, weekday: 1 };
    // 2026-09-13 是周日
    const sunday = new Date(2026, 8, 13, 12, 0);
    const next = computeNextRun(config, sunday, null);
    expect(next.getDay()).toBe(1); // 周一
    expect(next.getDate()).toBe(14);
    expect(next.getHours()).toBe(9);
  });

  it('isCatchUpDue：漏跑判定', () => {
    // 周日 12:00，上次运行是周六 09:00（daily：下一次应是周日 09:00，已过）→ 漏跑
    const sundayNoon = new Date(2026, 8, 13, 12, 0);
    const lastRunSaturday = new Date(2026, 8, 12, 9, 0).getTime();
    expect(isCatchUpDue(dailyConfig, lastRunSaturday, sundayNoon)).toBe(true);

    // 刚跑过（今天 09:30，daily 09:00 已跑，下一次明天）→ 不漏
    const sundayMorning = new Date(2026, 8, 13, 9, 30);
    const lastRunToday = new Date(2026, 8, 13, 9, 0).getTime();
    expect(isCatchUpDue(dailyConfig, lastRunToday, sundayMorning)).toBe(false);

    // 未启用 → 不漏
    expect(isCatchUpDue({ ...dailyConfig, enabled: false }, lastRunSaturday, sundayNoon)).toBe(
      false,
    );
  });

  it('调度器：启动补偿补跑漏掉的备份并重排下一次', async () => {
    const fakeTimers: Array<{ handler: () => void; delay: number }> = [];
    const timer: TimerPort = {
      setTimeout: (handler, ms) => {
        fakeTimers.push({ handler, delay: ms });
        return fakeTimers.length;
      },
      clearTimeout: () => undefined,
    };

    const now = new Date(2026, 8, 13, 12, 0);
    let currentTime = now.getTime();
    let lastRunAt: number | null = new Date(2026, 8, 12, 9, 0).getTime();
    let runCount = 0;

    const scheduler = new BackupScheduler({
      getConfig: () => dailyConfig,
      runBackup: async () => {
        runCount += 1;
        return true;
      },
      getLastRunAt: () => lastRunAt,
      recordRun: (at) => {
        lastRunAt = at;
      },
      clock: () => new Date(currentTime),
      timer,
      log: () => undefined,
    });

    const result = await scheduler.catchUpIfNeeded();
    expect(result.caughtUp).toBe(true);
    expect(runCount).toBe(1);
    expect(lastRunAt).toBe(now.getTime());
    // 补跑后重排了下一次（明天 09:00）
    expect(fakeTimers.length).toBe(1);
    expect(fakeTimers[0]?.delay).toBeGreaterThan(20 * 60 * 60 * 1000);

    // 不漏跑时 catchUp 不触发
    currentTime = now.getTime() + 1000;
    lastRunAt = currentTime;
    const again = await scheduler.catchUpIfNeeded();
    expect(again.caughtUp).toBe(false);
    expect(runCount).toBe(1);
  });

  it('调度器：runNow 手动触发并记录', async () => {
    let lastRunAt: number | null = null;
    let runCount = 0;
    const scheduler = new BackupScheduler({
      getConfig: () => dailyConfig,
      runBackup: async () => {
        runCount += 1;
        return true;
      },
      getLastRunAt: () => lastRunAt,
      recordRun: (at) => {
        lastRunAt = at;
      },
      clock: () => new Date(2026, 8, 13, 15, 0),
      timer: { setTimeout: () => 1, clearTimeout: () => undefined },
    });
    const ok = await scheduler.runNow();
    expect(ok).toBe(true);
    expect(runCount).toBe(1);
    expect(lastRunAt).toBe(new Date(2026, 8, 13, 15, 0).getTime());
  });
});

describe('快照管理（T8-04：生成 / 清点 / 保留份数 / 一键回滚）', () => {
  it('createSnapshot 命名规范 + listSnapshots 倒序', async () => {
    const targetDir = path.join(workDir, 'snaps');
    await createSnapshot({
      targetDir,
      now: new Date(2026, 8, 13, 9, 0, 0),
      origin: 'scheduled',
      createFile: async (p) => fs.writeFileSync(p, 'snapshot-1'),
    });
    await createSnapshot({
      targetDir,
      now: new Date(2026, 8, 13, 10, 0, 0),
      origin: 'manual',
      createFile: async (p) => fs.writeFileSync(p, 'snapshot-2'),
    });

    const snapshots = listSnapshots(targetDir);
    expect(snapshots.length).toBe(2);
    expect(snapshots[0]?.origin).toBe('manual'); // 最先（最新）
    expect(snapshots[1]?.fileName).toContain('090000');
    expect(snapshots[0]?.sizeBytes).toBe('snapshot-2'.length);
  });

  it('pruneSnapshots 保留份数生效，删除最旧', async () => {
    const targetDir = path.join(workDir, 'prune');
    for (let i = 0; i < 5; i += 1) {
      await createSnapshot({
        targetDir,
        now: new Date(2026, 8, 10 + i, 8, 0, 0),
        origin: 'scheduled',
        createFile: async (p) => fs.writeFileSync(p, `snap-${i}`),
      });
    }
    const result = pruneSnapshots(targetDir, 3);
    expect(result.deleted.length).toBe(2);
    expect(result.kept.length).toBe(3);
    const remaining = listSnapshots(targetDir);
    expect(remaining.length).toBe(3);
    expect(remaining[remaining.length - 1]?.fileName).toContain('20260912'); // 最旧的保留者
  });

  it('pruneSnapshots 不碰非快照命名的文件', async () => {
    const targetDir = path.join(workDir, 'prune-safe');
    await createSnapshot({
      targetDir,
      now: new Date(2026, 8, 13, 8, 0, 0),
      origin: 'scheduled',
      createFile: async (p) => fs.writeFileSync(p, 'snap'),
    });
    fs.writeFileSync(path.join(targetDir, '我的笔记.txt'), '不许动');
    fs.writeFileSync(path.join(targetDir, 'random.ecpkg'), '不是本模块命名的快照，也不许动');

    pruneSnapshots(targetDir, 0);
    expect(fs.existsSync(path.join(targetDir, '我的笔记.txt'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'random.ecpkg'))).toBe(true);
    expect(listSnapshots(targetDir).length).toBe(0);
  });

  it('restoreFromSnapshot：先安全快照后导入（顺序可证，可撤销）', async () => {
    const targetDir = path.join(workDir, 'restore');
    const snapshotPath = path.join(targetDir, 'ec-backup-20260912-080000-001-scheduled.ecpkg');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(snapshotPath, 'old-snapshot');

    const callOrder: string[] = [];
    const fakeReport: ImportReportData = {
      mode: 'full-restore',
      counts: { added: 3, conflicted: 0, unchanged: 0, missing: 0 },
      applied: {
        createdProjects: 1,
        updatedProjects: 0,
        createdObjects: 3,
        updatedObjects: 0,
        keptBothObjects: 0,
        memoryCreated: 0,
        memoryUpdated: 0,
        memorySuperseded: 0,
        filesWritten: 0,
      },
      resolutions: { keepLocal: 0, takeNew: 3, keepBoth: 0 },
      failures: [],
      reportPath: null,
      durationMs: 12,
    };

    const result = await restoreFromSnapshot({
      snapshotPath,
      now: new Date(2026, 8, 13, 12, 0, 0),
      createFile: async (p) => {
        callOrder.push('safety-backup');
        fs.writeFileSync(p, 'current-state-safety');
      },
      importFullRestore: async (p) => {
        callOrder.push('import');
        expect(p).toBe(snapshotPath);
        return fakeReport;
      },
    });

    expect(callOrder).toEqual(['safety-backup', 'import']);
    expect(result.safetySnapshot.origin).toBe('pre-restore');
    expect(fs.existsSync(result.safetySnapshot.absolutePath)).toBe(true);
    expect(result.report.mode).toBe('full-restore');
    expect(result.report.counts.added).toBe(3);
  });

  it('restoreFromSnapshot：快照不存在明确报错', async () => {
    await expect(
      restoreFromSnapshot({
        snapshotPath: path.join(workDir, 'no-such.ecpkg'),
        now: new Date(),
        createFile: async () => undefined,
        importFullRestore: async () => {
          throw new Error('不应被调用');
        },
      }),
    ).rejects.toThrow('快照不存在');
  });
});

describe('增量导出（T8-04 / FR-PKG-11：updatedAt 游标）', () => {
  it('isInIncrementalWindow：缺省全量，提供游标只留更新者', () => {
    expect(isInIncrementalWindow(100, undefined)).toBe(true);
    expect(isInIncrementalWindow(101, 100)).toBe(true);
    expect(isInIncrementalWindow(100, 100)).toBe(false); // 等于游标 → 未变更
    expect(isInIncrementalWindow(99, 100)).toBe(false);
  });

  it('advanceCursor 取数据源最大 updatedAt', () => {
    const cursor = advanceCursor({ maxUpdatedAt: () => 1726200000000 }, 1726200001000);
    expect(cursor.since).toBe(1726200000000);
    expect(cursor.savedAt).toBe(1726200001000);
  });

  it('compareIncrementalVolume：体积与变更量成正比', () => {
    const comparison = compareIncrementalVolume(10_000_000, 250_000);
    expect(comparison.ratio).toBeCloseTo(0.025, 3);
    expect(comparison.summary).toContain('2.5%');
  });
});
