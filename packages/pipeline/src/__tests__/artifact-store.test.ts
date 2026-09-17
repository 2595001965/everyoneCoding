import { describe, expect, it } from 'vitest';

import { ArtifactNotFoundError, ArtifactStore } from '../artifact-store';
import { confirmThrough, createFixture, saveS1 } from './helpers';

/**
 * T5-01 产物版本化测试：保存 / 切换 / diff / 完整性校验。
 */

describe('ArtifactStore 版本化', () => {
  it('保存 v1/v2/v3，内容与 diff 独立引用，当前指针默认最新', async () => {
    const fx = createFixture();
    try {
      await saveS1(fx.machine, fx.artifacts, '# v1 需求');
      fx.tick(10);
      await fx.artifacts.save({ stage: 'S1', artifactType: 'requirement_doc', content: '# v2 需求\n新增风险章节', note: '追加要求' });
      fx.tick(10);
      await fx.artifacts.save({ stage: 'S1', artifactType: 'requirement_doc', content: '# v3 需求\n新增风险章节\n补充验收标准', note: '重新生成' });

      expect(fx.artifacts.latestVersion('S1')).toBe(3);
      expect(fx.artifacts.activeVersion('S1')).toBe(3);

      const v1 = fx.artifacts.get('S1', 1);
      const v2 = fx.artifacts.get('S1', 2);
      expect(v1.diffRef).toBeNull();
      expect(v2.diffRef).not.toBeNull();
      expect(await fx.artifacts.read('S1', 1)).toBe('# v1 需求');
      const diff = await fx.artifacts.readDiff('S1', 2);
      expect(diff).toContain('+ 新增风险章节');
    } finally {
      fx.close();
    }
  });

  it('切换版本只改指针，历史保留，可切回最新', async () => {
    const fx = createFixture();
    try {
      await saveS1(fx.machine, fx.artifacts, '# v1');
      await fx.artifacts.save({ stage: 'S1', artifactType: 'requirement_doc', content: '# v2' });
      fx.artifacts.switchVersion('S1', 1);
      expect(fx.artifacts.activeVersion('S1')).toBe(1);
      expect(fx.artifacts.list('S1')).toHaveLength(2);
      fx.artifacts.switchVersion('S1', 2);
      expect(fx.artifacts.activeVersion('S1')).toBe(2);
    } finally {
      fx.close();
    }
  });

  it('覆盖历史版本被拒绝；读取不存在的版本抛 ArtifactNotFoundError', async () => {
    const fx = createFixture();
    try {
      await saveS1(fx.machine, fx.artifacts, '# v1');
      await expect(fx.artifacts.save({ stage: 'S1', artifactType: 'requirement_doc', content: 'x', version: 1 })).rejects.toThrow(
        /已存在/,
      );
      expect(() => fx.artifacts.get('S1', 9)).toThrow(ArtifactNotFoundError);
      await expect(fx.artifacts.read('S1', 9)).rejects.toThrow(ArtifactNotFoundError);
    } finally {
      fx.close();
    }
  });

  it('verifyIntegrity：文件被外部删除时给出明确清单（不静默）', async () => {
    const fx = createFixture();
    try {
      await saveS1(fx.machine, fx.artifacts, '# v1');
      await fx.artifacts.save({ stage: 'S1', artifactType: 'requirement_doc', content: '# v2' });
      // 外部删除 v2 内容文件
      const v2 = fx.artifacts.get('S1', 2);
      await fx.fs.remove(v2.contentRef);
      const problems = await fx.artifacts.verifyIntegrity();
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ stage: 'S1', version: 2, reason: expect.stringContaining('不存在') });
    } finally {
      fx.close();
    }
  });

  it('hydrate 可从表恢复台账（供 recovery 使用）', async () => {
    const fx = createFixture();
    try {
      await saveS1(fx.machine, fx.artifacts, '# v1');
      await fx.artifacts.save({ stage: 'S1', artifactType: 'requirement_doc', content: '# v2' });
      const ledger = fx.artifacts.exportLedger();
      const active = fx.artifacts.exportActive();

      const revived = new ArtifactStore({ projectId: 'P1', rootDir: 'pipeline/P1', fs: fx.fs });
      revived.hydrate(ledger, active);
      expect(revived.latestVersion('S1')).toBe(2);
      expect(revived.activeVersion('S1')).toBe(2);
      expect(await revived.read('S1', 1)).toBe('# v1');
    } finally {
      fx.close();
    }
  });

  it('确认 S1 → 版本切换 → notifyDownstream 提示（版本切换不影响下游内容本身）', async () => {
    const fx = createFixture();
    try {
      await saveS1(fx.machine, fx.artifacts, '# v1');
      fx.machine.confirm('S1');
      fx.machine.advance('S1', 'S2');
      fx.machine.submitForReview('S2');
      fx.machine.confirm('S2');
      // 切回 v1 并通知下游
      fx.artifacts.switchVersion('S1', 1);
      fx.machine.notifyDownstream('S1', '需求文档已切换到 v1，是否重新生成下游？');
      // 下游 S2 仍是 confirmed（切换不自动破坏），由用户确认后才 applyDownstreamStale
      expect(fx.machine.statusOf('S2')).toBe('confirmed');
      const marked = fx.machine.applyDownstreamStale('S1');
      expect(marked).toContain('S2');
      expect(fx.machine.statusOf('S2')).toBe('stale');
      confirmThrough(fx.machine, 'S2'); // 复活路径可用
      expect(fx.machine.statusOf('S2')).toBe('confirmed');
    } finally {
      fx.close();
    }
  });
});
