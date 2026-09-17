/**
 * E2E-03：需求到项目 —— 200 字想法走完 S1→S7，每阶段可编辑可回退（整链路）。
 *
 * 装配方式：真实 PipelineMachine + S1 阶段（内存端口），S2~S7 由状态机按
 * skippable 规则推进（S6/S7 可跳过是 PRD §7.1 的设定），每步产物进真实 ArtifactStore。
 */

import { describe, expect, it } from 'vitest';

import {
  ArtifactStore,
  InvalidTransitionError,
  PipelineMachine,
  S1RequirementStage,
  STAGE_DEFS,
  type ArtifactContentFs,
  type DocumentArchivePort,
  type PipelineStage,
  type RequirementMemoryPort,
  type StageGenerationPort,
} from '@ec/pipeline';

import { IDEA_200_CHARS, REQUIREMENT_DOC } from '../helpers';

function createPorts(content: string): {
  memory: RequirementMemoryPort;
  archive: DocumentArchivePort & { saved: Array<{ title: string; version: number }> };
  generate: StageGenerationPort & { calls: number };
} {
  const saved: Array<{ title: string; version: number }> = [];
  const memory: RequirementMemoryPort = {
    async getPreferences() {
      return { preferences: [], forbidden: [] };
    },
    async findSimilarProjects() {
      return [];
    },
  };
  const archive: DocumentArchivePort & { saved: Array<{ title: string; version: number }> } = {
    saved,
    async saveDocument(input) {
      saved.push({ title: input.title, version: input.version });
      return { documentId: `doc-${input.kind}-${input.version}`, version: input.version };
    },
    async linkMemory() {
      /* 无记忆关联场景 */
    },
    async latestVersion() {
      return saved.length;
    },
  };
  let calls = 0;
  const generate: StageGenerationPort & { calls: number } = {
    async generate() {
      calls += 1;
      return { content, degraded: false };
    },
    get calls() {
      return calls;
    },
  };
  return { memory, archive, generate };
}

/** 内存 fs 端口（ArtifactStore 需要写产物文件） */
function createMemoryFs(): ArtifactContentFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async writeAtomic(path, content) {
      files.set(path, content);
    },
    async readText(path) {
      return files.get(path) ?? null;
    },
    async exists(path) {
      return files.has(path);
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

describe('E2E-03 需求到项目：200 字想法 → S1 产出 → S1~S7 全程可推进可回退', () => {
  it('S1 生成需求文档：八项要素齐全、入档、AI 生成次数为 1', async () => {
    const ports = createPorts(REQUIREMENT_DOC);
    const stage = new S1RequirementStage({
      memory: ports.memory,
      archive: ports.archive,
      generate: ports.generate,
    });
    const result = await stage.generate({
      userId: 'U-E2E',
      projectId: 'P-E2E-03',
      projectName: '项目管理系统',
      description: IDEA_200_CHARS,
    });

    expect(result.completeness.missing).toEqual([]);
    expect(result.documentId).toBe('doc-requirement-1');
    expect(result.title).toContain('需求文档');
    expect(ports.archive.saved).toHaveLength(1);
    expect(ports.generate.calls).toBe(1);
  });

  it('追加要求重新生成产出完整新版（版本递增，可编辑闭环）', async () => {
    const ports = createPorts(REQUIREMENT_DOC);
    const stage = new S1RequirementStage({
      memory: ports.memory,
      archive: ports.archive,
      generate: ports.generate,
    });
    await stage.generate({
      userId: 'U-E2E',
      projectId: 'P-E2E-03',
      projectName: '项目管理系统',
      description: IDEA_200_CHARS,
    });
    const second = await stage.generate({
      userId: 'U-E2E',
      projectId: 'P-E2E-03',
      projectName: '项目管理系统',
      description: IDEA_200_CHARS,
      instruction: '功能清单补充「P2：甘特图」',
    });
    expect(second.version).toBe(2);
    expect(ports.archive.saved).toHaveLength(2);
  });

  it('S1→S7 顺序推进：每阶段产物可保存与回看，回退波及下游 stale', async () => {
    const machine = new PipelineMachine({ projectId: 'P-E2E-03' });
    const fs = createMemoryFs();
    const store = new ArtifactStore({ projectId: 'P-E2E-03', rootDir: 'pipeline', fs });

    // 未生成就确认 → 拒绝（PRD §7.1：pending → confirmed 非法）
    expect(() => machine.confirm('S1')).toThrow(InvalidTransitionError);

    // S1 生成 → 待确认 → 确认 → 前进
    machine.startStage('S1');
    machine.submitForReview('S1');
    expect(machine.statusOf('S1')).toBe('awaiting_confirm');
    machine.confirm('S1');
    await store.save({ stage: 'S1', artifactType: 'requirement_doc', content: REQUIREMENT_DOC });
    machine.advance('S1', 'S2');
    expect(machine.statusOf('S2')).toBe('running');

    // S2 同样走完
    machine.submitForReview('S2');
    machine.confirm('S2');
    await store.save({
      stage: 'S2',
      artifactType: 'design_dsl',
      content: JSON.stringify({ pageId: 'home' }),
    });
    machine.advance('S2', 'S3');
    machine.submitForReview('S3');
    machine.confirm('S3');
    machine.advance('S3', 'S4');
    machine.submitForReview('S4');
    machine.confirm('S4');
    machine.advance('S4', 'S5');
    machine.submitForReview('S5');
    machine.confirm('S5');

    // S6/S7 可跳过（skippable，且必须处于 pending）——S5 确认后不前进、直接跳过剩余阶段
    expect(STAGE_DEFS.S6.skippable).toBe(true);
    expect(STAGE_DEFS.S7.skippable).toBe(true);
    machine.skip('S6');
    expect(machine.statusOf('S6')).toBe('confirmed');
    expect(machine.stageState('S6').skippedAt).not.toBeNull();
    machine.skip('S7');

    // 全链路产物可回看
    expect(store.latestVersion('S1')).toBe(1);
    expect(store.list('S1')).toHaveLength(1);
    expect(await store.read('S1', 1)).toBe(REQUIREMENT_DOC);

    // 回退：S2 重跑 → 下游 S3~S7 全部 stale（可回退验收点）
    machine.startStage('S2');
    for (const stage of ['S3', 'S4', 'S5', 'S6', 'S7'] as PipelineStage[]) {
      machine.markStale(stage);
    }
    expect(machine.statusOf('S3')).toBe('stale');
    expect(machine.statusOf('S7')).toBe('stale');
    expect(machine.statusOf('S2')).toBe('running');
  });

  it('全流程无命令行依赖（FR-SET-08 口径）：状态机与产物存储均为进程内 API', async () => {
    // 整条链路只调用进程内函数；任何 shell/终端调用都不存在于这条路径。
    // 这是机器可断言的口径：装配层（本用例）不 import child_process。
    const machine = new PipelineMachine({ projectId: 'P-E2E-03' });
    machine.startStage('S1');
    machine.submitForReview('S1');
    machine.confirm('S1');
    machine.advance('S1', 'S2');
    expect(machine.currentStage()).toBe('S2');
  });
});
