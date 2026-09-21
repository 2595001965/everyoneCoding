import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  PipelineMachine,
  SplitModel,
  type ArtifactVersion,
  type ImpactRequest,
  type ImpactReport,
  type PipelineStage,
  type PipelineStageSnapshot,
  type QueueState,
  type RequirementGenerationResult,
  type S5RunResult,
  type SplitResult,
  type TechChoice,
  type TechDocGenerationResult,
} from '@ec/pipeline';

import { PipelineProvider } from '../index';
import { VersionSwitcher } from '../VersionSwitcher';
import { DiffPanel } from '../DiffPanel';
import { SupplementDialog } from '../SupplementDialog';
import { ModifyActions } from '../ModifyActions';
import { PipelineBar } from '../PipelineBar';
import type { PipelineApi } from '../pipeline-api';

/** T5-02 UI 测试（第一部分）：步骤条 / 四操作 / 补充需求影响清单 / 版本 diff。 */

export const EIGHT_SECTIONS_DOC = [
  '# 商城 需求文档',
  '## 项目背景',
  '做一个电商平台。',
  '## 目标用户',
  'C 端消费者。',
  '## 功能清单',
  '- P0：商品浏览',
  '- P1：购物车',
  '## 用户故事',
  '- 作为消费者，我希望浏览商品，以便购买。',
  '## 业务流程图',
  '```mermaid',
  'flowchart TD',
  '    A[浏览] --> B[下单]',
  '```',
  '## 验收标准',
  '- [ ] 商品列表可加载',
  '## 非功能要求',
  '- 必须有单元测试',
  '## 风险与假设',
  '- 假设：需求以描述为准。',
].join('\n');

export function createFakeApi(projectId: string): PipelineApi & { machine: PipelineMachine } {
  const machine = new PipelineMachine({ projectId });
  const artifacts = new Map<PipelineStage, ArtifactVersion[]>();
  const contents = new Map<string, string>();
  const diffContents = new Map<string, string | null>();
  let choice: TechChoice | null = null;
  let split: SplitResult | null = null;
  const listeners = new Set<(payload: unknown) => void>();

  const key = (stage: PipelineStage, version: number): string => `${stage}-${version}`;

  const emptyQueue = (): QueueState => ({
    nodes: [],
    currentId: null,
    paused: false,
    finished: true,
    order: [],
    stats: { total: 0, success: 0, failed: 0, skipped: 0, pending: 0, running: 0 },
  });

  void machine.bus.onAny('pipeline:*', (payload) => {
    for (const listener of listeners) listener(payload);
  });

  const api: PipelineApi = {
    ready: true,
    snapshot(): PipelineStageSnapshot {
      return machine.snapshot();
    },
    advance(_pid, from, to) {
      machine.advance(from, to);
    },
    startStage(_pid, stage) {
      machine.startStage(stage);
    },
    submitForReview(_pid, stage) {
      machine.submitForReview(stage);
    },
    confirm(_pid, stage) {
      machine.confirm(stage);
    },
    back(_pid, from, to) {
      return machine.back(from, to);
    },
    skip(_pid, stage) {
      machine.skip(stage);
    },
    applyDownstreamStale(_pid, stage) {
      return machine.applyDownstreamStale(stage);
    },
    async saveArtifact(input) {
      const list = artifacts.get(input.stage) ?? [];
      const version = list.length + 1;
      const entry: ArtifactVersion = {
        stage: input.stage,
        artifactType: input.artifactType,
        version,
        contentRef: `mem://${key(input.stage, version)}`,
        diffRef: version > 1 ? `mem://diff-${key(input.stage, version)}` : null,
        createdAt: Date.now(),
        note: input.note ?? '',
      };
      contents.set(key(input.stage, version), input.content);
      if (version > 1) {
        const before = contents.get(key(input.stage, version - 1)) ?? '';
        const beforeLines = before.split('\n');
        const afterLines = input.content.split('\n');
        diffContents.set(
          key(input.stage, version),
          [
            ...beforeLines.filter((line) => !afterLines.includes(line)).map((line) => `- ${line}`),
            ...afterLines.filter((line) => !beforeLines.includes(line)).map((line) => `+ ${line}`),
          ].join('\n'),
        );
      }
      list.push(entry);
      artifacts.set(input.stage, list);
      // 与真实外壳一致：产物保存后同步 machine 的版本指针（触发 stage-changed → UI 重载）
      const stageState = machine.stageState(input.stage);
      machine.restoreStageState({ ...stageState, activeVersion: version, latestVersion: version });
      return entry;
    },
    listArtifacts(_pid, stage) {
      return [...(artifacts.get(stage) ?? [])];
    },
    async readArtifact(_pid, stage, version) {
      return contents.get(key(stage, version)) ?? '';
    },
    async readDiff(_pid, stage, version) {
      return diffContents.get(key(stage, version)) ?? null;
    },
    switchVersion(_pid, stage, version) {
      const state = machine.stageState(stage);
      machine.restoreStageState({ ...state, activeVersion: version });
    },
    notifyDownstream(pid, stage, message) {
      void pid;
      machine.notifyDownstream(stage, message);
    },
    async generateRequirement(): Promise<RequirementGenerationResult> {
      return {
        content: EIGHT_SECTIONS_DOC,
        documentId: 'doc-1',
        version: 1,
        title: '商城-需求文档-v1.md',
        referencedMemoryIds: [],
        completeness: { missing: [], present: [] },
        degraded: false,
      };
    },
    getTechChoice() {
      return choice;
    },
    async saveTechChoice(_pid, value) {
      choice = value;
    },
    async generateTechDoc(): Promise<TechDocGenerationResult> {
      return {
        content: '# 商城 技术文档\n## 技术选型\ntargets: web\n## 接口设计\nopenapi 3.0',
        documentId: 'doc-2',
        version: 1,
        title: '商城-技术文档-v1.md',
        completeness: { missing: [], present: [] },
        openApi: null,
        forbiddenHit: [],
        regenerated: false,
        degraded: false,
      };
    },
    getSplit() {
      return split;
    },
    async saveSplit(_pid, value) {
      split = value;
    },
    evaluateImpact(_pid, change: ImpactRequest): ImpactReport {
      if (split === null) return { direct: [], indirect: [], affected: [], paths: {} };
      const model = SplitModel.fromResult(split);
      return model.evaluateImpact(change);
    },
    async runGeneration(): Promise<S5RunResult> {
      return {
        state: {
          nodes: [],
          currentId: null,
          paused: false,
          finished: true,
          order: [],
          stats: { total: 0, success: 0, failed: 0, skipped: 0, pending: 0, running: 0 },
        },
        results: {},
        progress: '{}',
        commits: [],
      };
    },
    async generateSplit(): Promise<SplitResult> {
      split = {
        features: [{ id: 'F-1', name: '商品浏览', pageIds: ['PG-1'], dependsOn: [] }],
        pages: [
          { id: 'PG-1', name: '商品列表页', featureId: 'F-1', dependsOn: [], route: '/products' },
        ],
      };
      return split;
    },
    async retryNode(): Promise<QueueState> {
      return emptyQueue();
    },
    skipNode(): QueueState {
      return emptyQueue();
    },
    pauseQueue(): QueueState {
      return emptyQueue();
    },
    getResumeProgress() {
      return { snapshot: machine.snapshot(), s5Progress: null, resumeStage: null };
    },
    async recoverProject() {
      return {
        snapshot: machine.snapshot(),
        resumeStage: null,
        integrityProblems: [],
        unexpectedExit: false,
        artifactVersions: [...artifacts.values()].reduce((sum, list) => sum + list.length, 0),
      };
    },
    subscribe(_event, listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return { ...api, machine };
}

describe('PipelineBar（步骤条）', () => {
  it('渲染七阶段，S1 已确认可回看，未开始阶段不可点击', () => {
    const api = createFakeApi('P1');
    api.startStage('P1', 'S1');
    api.submitForReview('P1', 'S1');
    api.confirm('P1', 'S1');

    const onReview = vi.fn();
    render(
      <PipelineProvider api={api}>
        <PipelineBar projectId="P1" onReview={onReview} onRollback={vi.fn()} />
      </PipelineProvider>,
    );

    expect(screen.getAllByTestId(/^pipeline-stage-/)).toHaveLength(7);
    const s1 = screen.getByTestId('pipeline-stage-S1');
    expect(s1.className).toContain('ec-pipe-stage--confirmed');
    fireEvent.click(s1);
    expect(onReview).toHaveBeenCalledWith('S1');

    const s4 = screen.getByTestId('pipeline-stage-S4');
    expect(s4.hasAttribute('disabled')).toBe(true);
  });
});

describe('ModifyActions（四操作）', () => {
  it('四按钮渲染；S5 代码阶段手动编辑禁用', () => {
    render(
      <ModifyActions
        stage="S1"
        allowManualEdit
        onRegenerate={vi.fn()}
        onLocalEdit={vi.fn()}
        onManualEdit={vi.fn()}
        onSupplement={vi.fn()}
        onSubmitSupplement={vi.fn()}
      />,
    );
    expect(screen.getByTestId('action-regenerate')).toBeInTheDocument();
    expect(screen.getByTestId('action-local-edit')).toBeInTheDocument();
    expect(screen.getByTestId('action-manual-edit')).toBeInTheDocument();
    expect(screen.getByTestId('action-supplement')).toBeInTheDocument();
  });

  it('S5（代码阶段）手动编辑禁用', () => {
    render(
      <ModifyActions
        stage="S5"
        allowManualEdit={false}
        onRegenerate={vi.fn()}
        onLocalEdit={vi.fn()}
        onSupplement={vi.fn()}
        onSubmitSupplement={vi.fn()}
      />,
    );
    expect(screen.getByTestId('action-manual-edit')).toBeDisabled();
  });
});

describe('SupplementDialog（补充需求 + 影响清单）', () => {
  it('评估影响范围后列出需重新生成节点；提交把指令传给 onSubmit', async () => {
    const api = createFakeApi('P1');
    const split: SplitResult = {
      features: [
        { id: 'f-auth', name: '认证', pageIds: ['p-login'], dependsOn: [] },
        { id: 'f-order', name: '订单', pageIds: ['p-order'], dependsOn: ['f-auth'] },
      ],
      pages: [
        { id: 'p-login', name: '登录页', featureId: 'f-auth', dependsOn: [], route: null },
        { id: 'p-order', name: '订单页', featureId: 'f-order', dependsOn: [], route: null },
      ],
    };
    await api.saveSplit('P1', split);

    const onSubmit = vi.fn();
    render(
      <PipelineProvider api={api}>
        <SupplementDialog
          open
          stage="S1"
          onEvaluate={(_text) =>
            api.evaluateImpact('P1', { type: 'supplement', targets: ['f-auth'] })
          }
          onSubmit={onSubmit}
          onClose={vi.fn()}
        />
      </PipelineProvider>,
    );

    await userEvent.type(screen.getByTestId('supplement-input'), '增加游客模式');
    fireEvent.click(screen.getByTestId('supplement-evaluate'));

    const nodes = screen.getAllByTestId('supplement-impact-node');
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.map((node) => node.textContent)).toContain('f-auth');

    fireEvent.click(screen.getByTestId('supplement-submit'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('增加游客模式');
    });
  });
});

describe('VersionSwitcher + DiffPanel（版本切换与 diff）', () => {
  it('v2 的 diff 显示新增内容', async () => {
    const api = createFakeApi('P1');
    await api.saveArtifact({
      projectId: 'P1',
      stage: 'S1',
      artifactType: 'requirement_doc',
      content: EIGHT_SECTIONS_DOC,
    });
    await api.saveArtifact({
      projectId: 'P1',
      stage: 'S1',
      artifactType: 'requirement_doc',
      content: `${EIGHT_SECTIONS_DOC}\n## 补充\n- 新增权限管理`,
    });

    const versions = api.listArtifacts('P1', 'S1');
    expect(versions).toHaveLength(2);

    render(
      <PipelineProvider api={api}>
        <VersionSwitcher
          projectId="P1"
          stage="S1"
          versions={versions}
          activeVersion={2}
          viewingVersion={2}
          onSwitch={vi.fn()}
        />
        <DiffPanel projectId="P1" stage="S1" version={2} />
      </PipelineProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('diff-panel')).toBeInTheDocument();
    });
    expect(screen.getByText(/新增权限管理/)).toBeInTheDocument();
  });

  it('v1 无 diff（首个版本）', async () => {
    const api = createFakeApi('P1');
    await api.saveArtifact({
      projectId: 'P1',
      stage: 'S1',
      artifactType: 'requirement_doc',
      content: EIGHT_SECTIONS_DOC,
    });
    render(
      <PipelineProvider api={api}>
        <DiffPanel projectId="P1" stage="S1" version={1} />
      </PipelineProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/首个版本，无历史差异/)).toBeInTheDocument();
    });
  });
});
