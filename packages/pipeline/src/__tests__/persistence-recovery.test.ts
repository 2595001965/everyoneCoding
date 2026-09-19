import { describe, expect, it } from 'vitest';

import { confirmThrough, createFixture, saveS1 } from './helpers';

/**
 * T5-01 持久化与恢复测试：表写入、崩溃快照恢复、断点续生成、产物缺失提示。
 */

describe('PipelineRepo 持久化', () => {
  it('ensureRun 幂等；产物台账写入 stage_artifact 并可读回', async () => {
    const fx = createFixture();
    try {
      const run1 = fx.repo.ensureRun('P1');
      const run2 = fx.repo.ensureRun('P1');
      expect(run2.id).toBe(run1.id);

      await saveS1(fx.machine, fx.artifacts);
      fx.repo.updateRunPointer(run1.id, 'S1', 'awaiting_confirm', 1);

      const ledger = fx.repo.listArtifacts('P1');
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ stage: 'S1', version: 1, artifactType: 'requirement_doc' });

      const pointer = fx.repo.latestRunForProject('P1');
      expect(pointer).toMatchObject({ stage: 'S1', status: 'awaiting_confirm', version: 1 });
    } finally {
      fx.close();
    }
  });

  it('状态快照序列化可往返', async () => {
    const fx = createFixture();
    try {
      await saveS1(fx.machine, fx.artifacts);
      fx.machine.confirm('S1');
      const raw = fx.repo.serializeState(fx.machine.snapshot());
      const parsed = fx.repo.parseState(raw);
      expect(parsed?.S1.status).toBe('confirmed');
      expect(parsed?.S2.status).toBe('pending');
      expect(fx.repo.parseState('not json')).toBeNull();
    } finally {
      fx.close();
    }
  });
});

describe('崩溃恢复（强杀 → 重启 → 断点续生成）', () => {
  it('模拟强杀后重启：running 阶段被恢复为断点，丢失窗口 ≤30s', async () => {
    const fx = createFixture();
    try {
      // 走到 S3 生成中（断点现场）
      confirmThrough(fx.machine, 'S2');
      fx.machine.advance('S2', 'S3');
      fx.machine.startStage('S3');
      await saveS1(fx.machine, fx.artifacts).then(() => fx.machine.confirm('S1'));
      fx.recovery.checkpoint();

      // 模拟强杀：新建全套实例（同一 fs / db），状态从零开始
      const machine2 = fx.machine; // 复用原 machine 会被 loadSnapshot 覆盖，这里验证 recover 重建
      const machine3 = machine2; // 占位：真实语义见下方重启 fixture
      void machine3;

      // 重启：新 machine 状态全 pending
      const { PipelineMachine } = await import('../pipeline-machine');
      const { ArtifactStore } = await import('../artifact-store');
      const restarted = new PipelineMachine({
        projectId: 'P1',
        clock: (() => fx.clockValue.now) as never,
      });
      const restartedArtifacts = new ArtifactStore({
        projectId: 'P1',
        rootDir: 'pipeline/P1',
        fs: fx.fs,
      });
      const { PipelineRecovery } = await import('../recovery');
      const recovery2 = new PipelineRecovery({
        projectId: 'P1',
        machine: restarted,
        artifacts: restartedArtifacts,
        repo: fx.repo,
        recovery: fx.crash,
      });

      const result = await recovery2.recover();
      expect(result.restoredFromSnapshot).toBe(true);
      expect(result.savedAt).not.toBeNull();
      // 断点：S3 running（快照时刻 S1 保存动作在 checkpoint 之前被 confirm 覆盖——按最终快照恢复）
      expect(result.snapshot.S3.status).toBe('running');
      expect(result.resumeStage).toBe('S3');
      // 产物台账从表恢复
      expect(result.artifactVersions).toBeGreaterThanOrEqual(1);
      expect(restartedArtifacts.latestVersion('S1')).toBe(1);
      expect(result.integrityProblems).toHaveLength(0);
    } finally {
      fx.close();
    }
  });

  it('产物文件被外部删除时恢复给出明确提示（不静默吞掉）', async () => {
    const fx = createFixture();
    try {
      await saveS1(fx.machine, fx.artifacts, '# v1');
      await fx.recovery.checkpoint();
      // 外部删除内容文件
      const v1 = fx.artifacts.get('S1', 1);
      await fx.fs.remove(v1.contentRef);

      const { PipelineMachine } = await import('../pipeline-machine');
      const { ArtifactStore } = await import('../artifact-store');
      const { PipelineRecovery } = await import('../recovery');
      const restarted = new PipelineMachine({
        projectId: 'P1',
        clock: (() => fx.clockValue.now) as never,
      });
      const restartedArtifacts = new ArtifactStore({
        projectId: 'P1',
        rootDir: 'pipeline/P1',
        fs: fx.fs,
      });
      const recovery2 = new PipelineRecovery({
        projectId: 'P1',
        machine: restarted,
        artifacts: restartedArtifacts,
        repo: fx.repo,
        recovery: fx.crash,
      });
      const result = await recovery2.recover();
      expect(result.integrityProblems).toHaveLength(1);
      expect(result.integrityProblems[0]).toMatchObject({ stage: 'S1', version: 1 });
    } finally {
      fx.close();
    }
  });

  it('正常退出 markClean 后重启无待恢复快照（不误报崩溃）', async () => {
    const fx = createFixture();
    try {
      await saveS1(fx.machine, fx.artifacts);
      await fx.recovery.checkpoint();
      await fx.recovery.markClean();

      const { PipelineMachine } = await import('../pipeline-machine');
      const { ArtifactStore } = await import('../artifact-store');
      const { PipelineRecovery } = await import('../recovery');
      const restarted = new PipelineMachine({
        projectId: 'P1',
        clock: (() => fx.clockValue.now) as never,
      });
      const restartedArtifacts = new ArtifactStore({
        projectId: 'P1',
        rootDir: 'pipeline/P1',
        fs: fx.fs,
      });
      const recovery2 = new PipelineRecovery({
        projectId: 'P1',
        machine: restarted,
        artifacts: restartedArtifacts,
        repo: fx.repo,
        recovery: fx.crash,
      });
      const result = await recovery2.recover();
      expect(result.restoredFromSnapshot).toBe(false);
      // 台账仍从表恢复（表是权威）
      expect(restartedArtifacts.latestVersion('S1')).toBe(1);
      // 干净快照仍可恢复状态（正常退出也保留进度）
      expect(result.snapshot.S1.status).toBe('awaiting_confirm');
    } finally {
      fx.close();
    }
  });

  it('恢复窗口：快照年龄 ≤ 30s', async () => {
    const fx = createFixture();
    try {
      await fx.recovery.checkpoint();
      const age = await fx.crash.snapshotAge('pipeline:P1');
      expect(age).not.toBeNull();
      expect(age as number).toBeLessThanOrEqual(30_000);
    } finally {
      fx.close();
    }
  });
});
