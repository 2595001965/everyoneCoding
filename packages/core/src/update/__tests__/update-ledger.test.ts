import { describe, expect, it } from 'vitest';

import { UpdateLedger } from '../update-ledger';

describe('更新回滚台账（FR-SET-05：更新失败可回滚到上一版本）', () => {
  it('未登记更新时启动不做任何事', () => {
    const ledger = new UpdateLedger();
    expect(ledger.recordBoot(1)).toEqual({ decision: 'none' });
    expect(ledger.current).toBeNull();
  });

  it('安装中（installing）状态不参与启动判定', () => {
    const ledger = new UpdateLedger();
    ledger.beginUpdate({ fromVersion: '0.1.0', toVersion: '0.2.0', backupPath: 'D:/bak/0.1.0', now: 1 });
    expect(ledger.recordBoot(2)).toEqual({ decision: 'none' });
  });

  it('待确认状态下首次启动放行，第二次启动判定回滚', () => {
    const ledger = new UpdateLedger();
    ledger.beginUpdate({ fromVersion: '0.1.0', toVersion: '0.2.0', backupPath: 'D:/bak/0.1.0', now: 1 });
    ledger.markInstalled(1);

    expect(ledger.recordBoot(2)).toEqual({ decision: 'allow', attempts: 1 });
    const second = ledger.recordBoot(3);
    expect(second).toEqual({
      decision: 'rollback',
      attempts: 2,
      restoreFrom: 'D:/bak/0.1.0',
      toVersion: '0.2.0',
      fromVersion: '0.1.0',
    });
  });

  it('正常启动一次就 markHealthy，后续启动不再计数（不误判为崩溃）', () => {
    const ledger = new UpdateLedger();
    ledger.beginUpdate({ fromVersion: '0.1.0', toVersion: '0.2.0', backupPath: 'D:/bak/0.1.0', now: 1 });
    ledger.markInstalled(1);

    expect(ledger.recordBoot(2)).toEqual({ decision: 'allow', attempts: 1 });
    const settled = ledger.markHealthy(3);
    expect(settled?.stage).toBe('healthy');
    expect(ledger.current).toBeNull();
    // 之后每次启动都是 none
    expect(ledger.recordBoot(4)).toEqual({ decision: 'none' });
    expect(ledger.lastSettled()?.toVersion).toBe('0.2.0');
  });

  it('没有备份时如实返回 no-backup，而不是假装回滚', () => {
    const ledger = new UpdateLedger();
    ledger.beginUpdate({ fromVersion: '0.1.0', toVersion: '0.2.0', backupPath: null, now: 1 });
    ledger.markInstalled(1);
    ledger.recordBoot(2);
    expect(ledger.recordBoot(3)).toEqual({ decision: 'no-backup', attempts: 2, toVersion: '0.2.0' });
  });

  it('maxBootAttempts 可配置：设为 3 时前两次放行', () => {
    const ledger = new UpdateLedger(null, { maxBootAttempts: 3 });
    ledger.beginUpdate({ fromVersion: '0.1.0', toVersion: '0.2.0', backupPath: 'b', now: 1 });
    ledger.markInstalled(1);
    expect(ledger.recordBoot(2).decision).toBe('allow');
    expect(ledger.recordBoot(3).decision).toBe('allow');
    expect(ledger.recordBoot(4).decision).toBe('rollback');
  });

  it('回滚与回滚失败分别归档进历史，并保留错误原因', () => {
    const rolledBack = new UpdateLedger();
    rolledBack.beginUpdate({ fromVersion: '0.1.0', toVersion: '0.2.0', backupPath: 'b', now: 1 });
    rolledBack.markInstalled(1);
    rolledBack.recordBoot(2);
    rolledBack.recordBoot(3);
    const done = rolledBack.markRolledBack(4, null);
    expect(done?.stage).toBe('rolled-back');
    expect(rolledBack.lastSettled()?.stage).toBe('rolled-back');

    const failed = new UpdateLedger();
    failed.beginUpdate({ fromVersion: '0.1.0', toVersion: '0.2.0', backupPath: 'b', now: 1 });
    failed.markInstalled(1);
    const record = failed.markRollbackFailed(2, '还原目录被占用');
    expect(record?.stage).toBe('rollback-failed');
    expect(failed.lastSettled()?.lastError).toBe('还原目录被占用');
  });

  it('登记新更新时把未落定的旧记录归档，台账不悬空', () => {
    const ledger = new UpdateLedger();
    ledger.beginUpdate({ fromVersion: '0.1.0', toVersion: '0.2.0', backupPath: 'b1', now: 1 });
    ledger.markInstalled(1);
    ledger.beginUpdate({ fromVersion: '0.1.0', toVersion: '0.3.0', backupPath: 'b2', now: 5 });
    expect(ledger.current?.toVersion).toBe('0.3.0');
    expect(ledger.history).toHaveLength(1);
    expect(ledger.history[0]?.toVersion).toBe('0.2.0');
  });

  it('toJSON / fromJSON 往返一致，且历史条数有上限', () => {
    const ledger = new UpdateLedger(null, { maxHistory: 2 });
    for (let index = 0; index < 4; index += 1) {
      ledger.beginUpdate({ fromVersion: '0.1.0', toVersion: `0.${index + 2}.0`, backupPath: 'b', now: index });
      ledger.markInstalled(index);
      ledger.markHealthy(index);
    }
    expect(ledger.history).toHaveLength(2);
    const restored = UpdateLedger.fromJSON(JSON.parse(JSON.stringify(ledger)));
    expect(restored.history).toEqual(ledger.history);
    // 历史新→旧排列，上限 2 条 → 最近一次是 0.5.0
    expect(restored.lastSettled()?.toVersion).toBe('0.5.0');
  });

  it('坏数据降级为空账簿，绝不阻塞启动', () => {
    expect(UpdateLedger.fromJSON(null).history).toEqual([]);
    expect(UpdateLedger.fromJSON('garbage').current).toBeNull();
    expect(UpdateLedger.fromJSON({ current: { stage: '不存在的阶段' } }).current?.stage).toBe('idle');
    expect(UpdateLedger.fromJSON({ history: [null, 42, { toVersion: '1.0.0' }] }).history).toHaveLength(1);
  });
});
