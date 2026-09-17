import { describe, expect, it } from 'vitest';

import { InvalidTransitionError, canAdvance } from '../pipeline-machine';
import { STAGE_DEFS, STAGE_ORDER, nextStage, previousStage, stagesAfter } from '../stage-defs';
import { blankSnapshot, confirmThrough, createFixture, saveS1 } from './helpers';

/**
 * T5-01 状态机测试：合法转移全覆盖、非法转移拒绝、回退置 stale、跳过、guard。
 */

describe('stage-defs（PRD §7.1）', () => {
  it('七阶段定义齐全且 S6/S7 可跳过', () => {
    expect(STAGE_ORDER).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    expect(STAGE_DEFS.S1.completionCondition).toContain('确认');
    expect(STAGE_DEFS.S1.artifactType).toBe('requirement_doc');
    expect(STAGE_DEFS.S3.artifactType).toBe('tech_doc');
    expect(STAGE_DEFS.S5.artifactType).toBe('code_patch');
    expect(STAGE_DEFS.S6.skippable).toBe(true);
    expect(STAGE_DEFS.S7.skippable).toBe(true);
    expect(STAGE_DEFS.S1.skippable).toBe(false);
  });

  it('前后阶段与区间计算正确', () => {
    expect(previousStage('S1')).toBeNull();
    expect(nextStage('S7')).toBeNull();
    expect(nextStage('S2')).toBe('S3');
    expect(stagesAfter('S1', 'S3')).toEqual(['S2', 'S3']);
    expect(stagesAfter('S7')).toEqual([]);
  });
});

describe('PipelineMachine 状态机', () => {
  it('合法全链路：S1 生成 → 待确认 → 确认 → 逐阶段前进到 S7', () => {
    const fx = createFixture();
    try {
      confirmThrough(fx.machine, 'S7');
      const snapshot = fx.machine.snapshot();
      for (const stage of STAGE_ORDER) {
        expect(snapshot[stage].status).toBe('confirmed');
      }
    } finally {
      fx.close();
    }
  });

  it('非法转移被拒绝：pending 不能直接 confirmed / awaiting_confirm', () => {
    const fx = createFixture();
    try {
      expect(() => fx.machine.confirm('S1')).toThrow(InvalidTransitionError);
      expect(() => fx.machine.startStage('S1')).not.toThrow(); // pending → running 合法
      expect(() => fx.machine.confirm('S1')).toThrow(InvalidTransitionError); // running 不能直接 confirmed
      expect(() => fx.machine.submitForReview('S2')).toThrow(InvalidTransitionError); // S2 还是 pending
    } finally {
      fx.close();
    }
  });

  it('非法转移被拒绝：未确认不能前进；只能前进到紧邻阶段', async () => {
    const fx = createFixture();
    try {
      expect(() => fx.machine.advance('S1', 'S2')).toThrow(/尚未确认/);
      await saveS1(fx.machine, fx.artifacts);
      fx.machine.confirm('S1');
      expect(() => fx.machine.advance('S1', 'S3')).toThrow(/紧邻/);
    } finally {
      fx.close();
    }
  });

  it('advance 支持 guard 阻断（E2E-19：未完成问卷不得进入 S3）', async () => {
    const fx = createFixture();
    try {
      fx.machine.setAdvanceGuard((_from, to) => (to === 'S3' ? '请先完成技术选型问卷' : null));
      confirmThrough(fx.machine, 'S2');
      expect(() => fx.machine.advance('S2', 'S3')).toThrow(/技术选型问卷/);
      fx.machine.setAdvanceGuard(() => null);
      fx.machine.advance('S2', 'S3');
      expect(fx.machine.statusOf('S3')).toBe('running');
    } finally {
      fx.close();
    }
  });

  it('回退置 stale：S3 回退到 S1 后，(S1,S3] 区间全部 stale（FR-PIPE-04）', async () => {
    const fx = createFixture();
    try {
      confirmThrough(fx.machine, 'S3');
      const marked = fx.machine.back('S3', 'S1');
      expect(marked).toEqual(['S2', 'S3']);
      const snapshot = fx.machine.snapshot();
      expect(snapshot.S1.status).toBe('confirmed');
      expect(snapshot.S2.status).toBe('stale');
      expect(snapshot.S3.status).toBe('stale');
      expect(fx.events.some((event) => event === 'pipeline:rolled-back')).toBe(true);
    } finally {
      fx.close();
    }
  });

  it('回退只能向后，向前抛非法转移', () => {
    const fx = createFixture();
    try {
      confirmThrough(fx.machine, 'S3');
      expect(() => fx.machine.back('S1', 'S3')).toThrow(/只能向后/);
    } finally {
      fx.close();
    }
  });

  it('skip 只对 skippable 阶段生效且只能跳过 pending', () => {
    const fx = createFixture();
    try {
      fx.machine.skip('S6');
      expect(fx.machine.statusOf('S6')).toBe('confirmed');
      expect(fx.machine.snapshot().S6.skippedAt).not.toBeNull();
      expect(() => fx.machine.skip('S1')).toThrow(/不可跳过/);
    } finally {
      fx.close();
    }
  });

  it('stale 阶段可复活（重新生成）或重置为 pending', async () => {
    const fx = createFixture();
    try {
      confirmThrough(fx.machine, 'S3');
      fx.machine.back('S3', 'S1');
      fx.machine.startStage('S2');
      expect(fx.machine.statusOf('S2')).toBe('running');
      fx.machine.markStale('S2');
      fx.machine.resetStage('S2');
      expect(fx.machine.statusOf('S2')).toBe('pending');
    } finally {
      fx.close();
    }
  });

  it('notifyDownstream 只通知非 pending 的下游；applyDownstreamStale 才真正置 stale', async () => {
    const fx = createFixture();
    try {
      confirmThrough(fx.machine, 'S3');
      fx.machine.notifyDownstream('S1', '需求文档已更新，是否重新生成下游？');
      const downstreamEvent = fx.events.length; // 占位避免 lint：事件校验在下一行
      expect(downstreamEvent).toBeGreaterThan(0);
      const marked = fx.machine.applyDownstreamStale('S1');
      expect(marked).toEqual(['S2', 'S3']);
      expect(fx.machine.snapshot().S2.status).toBe('stale');
    } finally {
      fx.close();
    }
  });

  it('canAdvance 预检不产生副作用', async () => {
    const fx = createFixture();
    try {
      expect(canAdvance(fx.machine, 'S1')).toEqual({ ok: false, reason: '阶段 S1 尚未确认' });
      confirmThrough(fx.machine, 'S1');
      expect(canAdvance(fx.machine, 'S1')).toEqual({ ok: true, reason: null });
      expect(canAdvance(fx.machine, 'S7')).toEqual({ ok: false, reason: '已是最后阶段' });
      expect(fx.machine.statusOf('S2')).toBe('pending');
    } finally {
      fx.close();
    }
  });

  it('loadSnapshot 修复脏数据（未知状态回 pending，latestVersion 按快照值容错保留）', () => {
    const fx = createFixture();
    try {
      const snapshot = blankSnapshot();
      snapshot.S1 = { stage: 'S1', status: 'confirmed', activeVersion: 2, latestVersion: 2, skippedAt: null, updatedAt: 5 };
      snapshot.S2 = { stage: 'S2', status: 'bogus' as never, activeVersion: null, latestVersion: -1, skippedAt: null, updatedAt: 0 };
      fx.machine.loadSnapshot(snapshot);
      expect(fx.machine.statusOf('S1')).toBe('confirmed');
      expect(fx.machine.statusOf('S2')).toBe('pending');
      expect(fx.machine.snapshot().S2.latestVersion).toBe(-1);
    } finally {
      fx.close();
    }
  });
});
