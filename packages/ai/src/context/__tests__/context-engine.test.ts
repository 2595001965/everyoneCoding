import { describe, expect, it, vi } from 'vitest';

import { ContextLengthError } from '../../core/error';
import {
  CONTEXT_RENDER_ORDER,
  createContextEngine,
  extractHardConstraints,
  renderPrompt,
  tokenDistribution,
} from '../context-engine';
import type { ContextEngine } from '../context-engine';
import {
  applyPanelSelection,
  emptySelection,
  setBlockOverride,
  toContextPanelModel,
  tokenDistributionRows,
  toggleBlock,
  withPlaceholders,
} from '../context-panel-model';
import { CONTEXT_BLOCK_QUOTAS, DEFAULT_CONTEXT_BUDGET } from '../token-budget';
import { describeTruncation } from '../truncate-report';
import type { ContextAssemblyRequest, ContextBlock, ContextBlockId } from '../context-types';
import { PROJECT_ID, USER_ID, bigMemoryPort, fakeContracts, fullSources } from './fixtures';

const BASE_REQUEST: ContextAssemblyRequest = {
  userId: USER_ID,
  projectId: PROJECT_ID,
  purpose: 'code',
  target: 'backend-code',
  elementId: 'el-btn',
  pageId: 'page-login',
  featureId: 'feat-auth',
  instruction: '生成登录接口的后端代码',
};

function engine(sources = fullSources()): ContextEngine {
  return createContextEngine({ sources });
}

describe('八类上下文块组装（FR-AI-01）', () => {
  it('全部端口就绪时八类块（+指令/契约）都有内容，且来源可追溯', async () => {
    const context = await engine().assemble(BASE_REQUEST);
    const byId = new Map(context.blocks.map((block) => [block.id, block]));

    for (const id of [
      'longterm',
      'project',
      'feature',
      'page',
      'element-chain',
      'note',
      'issue',
      'document',
      'code',
    ] as const) {
      const block = byId.get(id);
      expect(block, `缺少块 ${id}`).toBeDefined();
      expect(block?.tokens ?? 0).toBeGreaterThan(0);
      expect(block?.content.length ?? 0).toBeGreaterThan(0);
    }
    expect(context.totalTokens).toBeGreaterThan(0);
    // 禁止事项置顶，因此 note-1 在 note-2 之前
    expect(context.noteIds).toEqual(['note-1', 'note-2']);
    expect(context.memoryIds).toContain('pj-1');
  });

  it('元素链按祖先顺序给出，并把登录表单语义带进上下文', async () => {
    const context = await engine().assemble(BASE_REQUEST);
    const chain = context.blocks.find((block) => block.id === 'element-chain');
    expect(chain?.items.map((item) => item.key)).toEqual(['el-form', 'el-input', 'el-btn']);
    expect(chain?.content).toContain('Form「登录表单」');
    expect(chain?.content).toContain('method=POST');
    // 样式类属性被过滤，不进入上下文
    expect(chain?.content).not.toContain('fontSize');
  });

  it('备注以高优先级注入，禁止事项置顶并进硬约束小节', async () => {
    const context = await engine().assemble(BASE_REQUEST);
    const noteBlock = context.blocks.find((block) => block.id === 'note');
    expect(noteBlock?.items[0]?.key).toBe('note-1');
    expect(noteBlock?.source).toContain('禁止事项 1 条');
    expect(context.system).toContain('# 必须遵守（硬约束）');
    expect(context.system).toContain('【禁止】不得把验证码明文写入日志');
    expect(context.system).toContain('点击登录前必须校验图形验证码');
  });

  it('端口缺失时逐块优雅跳过并记录原因，不抛错', async () => {
    // 空 sources（所有端口未接入）——首次生成前的真实状态
    const context = await engine({}).assemble(BASE_REQUEST);
    const skipped = new Map(context.skipped.map((entry) => [entry.block, entry.reason]));
    for (const id of [
      'longterm',
      'project',
      'feature',
      'page',
      'element-chain',
      'note',
      'issue',
      'document',
      'code',
    ] as const) {
      expect(skipped.get(id), `块 ${id} 未记录跳过原因`).toBeTruthy();
    }
    expect(context.totalTokens).toBeGreaterThan(0); // 指令块始终存在
    expect(context.system).toContain('（本次无可用上下文）'.slice(0, 4));
  });

  it('端口抛错时该块降级为空，其余块照常组装', async () => {
    const sources = fullSources({
      memory: {
        search: () => {
          throw new Error('sqlite busy');
        },
      },
    });
    const context = await engine(sources).assemble(BASE_REQUEST);
    const project = context.blocks.find((block) => block.id === 'project');
    expect(project?.tokens).toBe(0);
    expect(project?.skipped).toContain('记忆检索失败');
    expect(context.blocks.find((block) => block.id === 'note')?.tokens).toBeGreaterThan(0);
  });

  it('记忆检索无命中时回退分层列举', async () => {
    const sources = fullSources({
      memory: {
        search: () => [],
        listByScope: () => [
          {
            id: 'pj-fallback',
            scope: 'project' as const,
            title: '兜底项目记忆',
            content: '内容',
            importance: 3,
            confidence: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    const context = await engine(sources).assemble(BASE_REQUEST);
    const project = context.blocks.find((block) => block.id === 'project');
    expect(project?.source).toContain('分层列举');
    expect(project?.content).toContain('兜底项目记忆');
  });
});

describe('组装顺序与配额（T4-02 要点 2）', () => {
  it('渲染顺序为「由抽象到具体」，越具体越靠后', () => {
    expect(CONTEXT_RENDER_ORDER).toEqual([
      'longterm',
      'project',
      'feature',
      'page',
      'element-chain',
      'note',
      'issue',
      'document',
      'code',
      'dependency-contract',
    ]);
  });

  it('分块配额与 PRD §M6 建议一致，且保留顺序满足 T4-03 的硬性要求', () => {
    const byId = new Map(CONTEXT_BLOCK_QUOTAS.map((quota) => [quota.id, quota]));
    expect(byId.get('longterm')?.quota).toBe(8_000);
    expect(byId.get('project')?.quota).toBe(24_000);
    expect(byId.get('feature')?.quota).toBe(16_000);
    expect(byId.get('page')?.quota).toBe(16_000);
    expect(byId.get('element-chain')?.quota).toBe(3_000);
    expect(byId.get('note')?.quota).toBe(5_000);
    expect(byId.get('issue')?.quota).toBe(4_000);
    expect(byId.get('document')?.quota).toBe(4_000);
    expect(byId.get('code')?.quota).toBe(40_000);

    const order: ContextBlockId[] = [
      'element-chain',
      'note',
      'page',
      'feature',
      'project',
      'longterm',
      'document',
    ];
    const priorities = order.map((id) => byId.get(id)?.priority ?? 0);
    const sortedDesc = [...priorities].sort((a, b) => b - a);
    expect(priorities).toEqual(sortedDesc);
  });

  it('默认总预算 128k，超预算时裁剪后不超预算', async () => {
    const context = await engine(fullSources({ memory: bigMemoryPort(1000) })).assemble({
      ...BASE_REQUEST,
      budget: 6_000,
    });
    expect(context.budget).toBe(6_000);
    expect(context.totalTokens).toBeLessThanOrEqual(6_000);
    expect(context.truncation).not.toBeNull();
  });

  it('token 分布可统计（面板与基准共用）', async () => {
    const context = await engine().assemble(BASE_REQUEST);
    const distribution = tokenDistribution(context.blocks);
    expect(distribution.note).toBeGreaterThan(0);
    const total = Object.values(distribution).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(context.totalTokens);
  });
});

describe('依赖契约注入（T4-02 要点 4，与 T5-06 共用）', () => {
  it('setDependencyContracts 后契约块出现，且禁止臆造接口写入指令', async () => {
    const instance = engine();
    const before = await instance.assemble(BASE_REQUEST);
    expect(before.blocks.find((block) => block.id === 'dependency-contract')?.tokens).toBe(0);

    instance.setDependencyContracts(fakeContracts());
    const after = await instance.assemble(BASE_REQUEST);
    const block = after.blocks.find((item) => item.id === 'dependency-contract');
    expect(block?.tokens).toBeGreaterThan(0);
    expect(block?.content).toContain('CaptchaService');
    expect(block?.content).toContain('verify(token: string, answer: string): Promise<boolean>');
    expect(after.system).toContain('禁止臆造');
    expect(instance.getDependencyContracts()).toHaveLength(2);
  });
});

describe('上下文面板（T4-02 要点 3）', () => {
  it('模型暴露 token 分布、省略提示与引用溯源', async () => {
    const context = await engine(fullSources({ memory: bigMemoryPort(800) })).assemble({
      ...BASE_REQUEST,
      budget: 5_000,
    });
    const model = toContextPanelModel(context);

    expect(model.totalTokens).toBeLessThanOrEqual(5_000);
    expect(model.usagePercent).toBeGreaterThan(0);
    expect(model.noteIds).toContain('note-1');
    expect(model.warnings.some((warning) => warning.includes('已省略'))).toBe(true);
    expect(describeTruncation(model.truncation)).toContain('已省略');
    expect(tokenDistributionRows(model)[0]?.tokens).toBeGreaterThan(0);
    expect(withPlaceholders(model).allBlocks.length).toBeGreaterThanOrEqual(11);
  });

  it('勾选变化实时反映到提交内容', async () => {
    const instance = engine();
    const request: ContextAssemblyRequest = { ...BASE_REQUEST, budget: 6_000 };
    const first = await instance.assemble(request);
    expect(first.blocks.find((block) => block.id === 'document')?.tokens).toBeGreaterThan(0);

    const selection = toggleBlock(emptySelection(), 'document');
    const second = await instance.assemble(applyPanelSelection(request, selection));
    expect(second.blocks.find((block) => block.id === 'document')?.tokens).toBe(0);
    expect(second.blocks.find((block) => block.id === 'document')?.skipped).toBe(
      '已被手动取消勾选',
    );
    expect(second.noteIds).toEqual(first.noteIds);
  });

  it('就地编辑覆盖块内容（所见即所提交）', async () => {
    const instance = engine();
    const request: ContextAssemblyRequest = { ...BASE_REQUEST, budget: 6_000 };
    const first = await instance.assemble(request);
    const original = first.blocks.find((block) => block.id === 'longterm')?.content ?? '';
    expect(original.length).toBeGreaterThan(0);

    const selection = setBlockOverride(
      emptySelection(),
      'longterm',
      '仅保留：以后都用 TypeScript',
      original,
    );
    const second = await instance.assemble(applyPanelSelection(request, selection));
    const block = second.blocks.find((item) => item.id === 'longterm');
    expect(block?.content).toBe('仅保留：以后都用 TypeScript');
    expect(block?.source).toContain('已手动编辑');

    // 编辑回原文等价于取消编辑
    const reverted = setBlockOverride(selection, 'longterm', original, original);
    expect(reverted.overrides).toEqual({});
  });
});

describe('超限重试（T4-03 要点 4 联动）', () => {
  it('ContextLengthError 触发激进裁剪并重试一次', async () => {
    const instance = engine();
    const run = vi
      .fn<(context: unknown) => Promise<string>>()
      .mockRejectedValueOnce(new ContextLengthError('超限', 8192))
      .mockResolvedValueOnce('生成成功');

    const outcome = await instance.assembleWithRetry(BASE_REQUEST, run);

    expect(outcome.retries).toBe(1);
    expect(outcome.aggressive).toBe(true);
    expect(outcome.result).toBe('生成成功');
    expect(run).toHaveBeenCalledTimes(2);

    const byId = new Map(outcome.context.blocks.map((block) => [block.id, block]));
    expect(byId.get('element-chain')?.tokens).toBeGreaterThan(0);
    expect(byId.get('code')?.tokens).toBe(0);
    expect(byId.get('project')?.tokens).toBe(0);
    // 硬约束即便在激进裁剪下也不丢
    expect(outcome.context.system).toContain('【禁止】不得把验证码明文写入日志');
  });

  it('非超限错误直接抛出，不重试', async () => {
    const instance = engine();
    const run = vi.fn().mockRejectedValue(new Error('网络中断'));
    await expect(instance.assembleWithRetry(BASE_REQUEST, run)).rejects.toThrow('网络中断');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('激进裁剪后仍超限则抛出明确错误', async () => {
    const instance = engine();
    const run = vi
      .fn<(context: unknown) => Promise<string>>()
      .mockRejectedValueOnce(new ContextLengthError('超限', 8192))
      .mockRejectedValueOnce(new ContextLengthError('还是超限', 8192));

    await expect(instance.assembleWithRetry(BASE_REQUEST, run)).rejects.toThrow(
      /已保留|激进裁剪|缩短指令/,
    );
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('提示词渲染（§13.2）', () => {
  it('角色与输出契约前置，硬约束小节紧随其后', async () => {
    const context = await engine().assemble(BASE_REQUEST);
    const roleIndex = context.system.indexOf('# 角色与输出契约');
    const hardIndex = context.system.indexOf('# 必须遵守（硬约束）');
    const contextIndex = context.system.indexOf('# 上下文');
    expect(roleIndex).toBe(0);
    expect(hardIndex).toBeGreaterThan(roleIndex);
    expect(contextIndex).toBeGreaterThan(hardIndex);
    expect(context.system).toContain('变更说明、风险与未覆盖点');
  });

  it('用户补充指令出现在 user 消息与指令块中', async () => {
    const context = await engine().assemble(BASE_REQUEST);
    expect(context.user).toContain('生成登录接口的后端代码');
    expect(context.messages[0]?.role).toBe('system');
    expect(context.messages.at(-1)?.role).toBe('user');
  });

  it('extractHardConstraints 与 renderPrompt 可独立使用（备注块被裁也能保留硬约束）', () => {
    const blocks: ContextBlock[] = [
      {
        id: 'note',
        label: '元素备注',
        priority: 880,
        quota: 5_000,
        tokens: 10,
        content: 'x',
        source: 'test',
        editable: true,
        items: [
          {
            key: 'n1',
            label: 'a',
            tokens: 5,
            weight: 1,
            text: '[备注 #n1] 禁止事项\n【禁止】不得明文存 Key',
          },
          {
            key: 'n2',
            label: 'b',
            tokens: 5,
            weight: 1,
            text: '[备注 #n2] 校验要求\n需校验图形验证码',
          },
        ],
      },
    ];
    expect(extractHardConstraints(blocks)).toEqual(['【禁止】不得明文存 Key']);
    const empty = renderPrompt([], BASE_REQUEST, {
      hardConstraints: extractHardConstraints(blocks),
    });
    expect(empty.system).toContain('【禁止】不得明文存 Key');
  });
});

describe('性能基准：1000 条记忆下的组装耗时（NFR-P-04 ≤300ms）', () => {
  it('冷启动与热路径均在预算内，并输出分布数据', async () => {
    const instance = engine(
      fullSources({
        memory: bigMemoryPort(1000),
        documents: {
          searchRelevant: ({ limit }) =>
            Array.from({ length: 40 }, (_, index) => ({
              id: `doc-${index}`,
              documentId: `D${index}`,
              title: `技术文档 ${index}`,
              kind: 'techdoc' as const,
              heading: '登录与鉴权',
              content: '登录接口契约与令牌刷新策略。'.repeat(20),
              score: 0.5,
            })).slice(0, limit),
        },
        code: {
          findRelated: ({ limit }) =>
            Array.from({ length: 40 }, (_, index) => ({
              anchorId: `anchor-${index}`,
              filePath: `src/modules/m${index}/service.ts`,
              symbol: `Service${index}.handle`,
              kind: 'service',
              startLine: 1,
              endLine: 40,
              language: 'ts',
              snippet: 'export class Service { async handle() { return true; } }'.repeat(20),
              score: 1 - index / 100,
            })).slice(0, limit),
        },
      }),
    );

    const request: ContextAssemblyRequest = { ...BASE_REQUEST, budget: DEFAULT_CONTEXT_BUDGET };

    const coldStart = performance.now();
    const cold = await instance.assemble(request);
    const coldMs = performance.now() - coldStart;

    const warmRuns: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      await instance.assemble(request);
      warmRuns.push(performance.now() - started);
    }
    warmRuns.sort((a, b) => a - b);
    const p50 = warmRuns[Math.floor(warmRuns.length / 2)] ?? 0;
    const p95 = warmRuns[Math.floor(warmRuns.length * 0.95)] ?? 0;

    const rows = tokenDistributionRows(toContextPanelModel(cold))
      .filter((row) => row.tokens > 0)
      .map((row) => `${row.label}=${row.tokens}(${row.percent}%)`);

    // 把实测数据打出来，验收报告直接引用
    console.info(
      `[T4-02 基准] 冷 ${coldMs.toFixed(2)}ms / 热 p50 ${p50.toFixed(2)}ms / p95 ${p95.toFixed(2)}ms；` +
        `总量 ${cold.totalTokens}/${cold.budget} token；省略 ${cold.truncation?.omittedCount ?? 0} 项；` +
        `分布：${rows.join('，')}`,
    );

    expect(coldMs).toBeLessThan(300);
    expect(p95).toBeLessThan(300);
    expect(cold.totalTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET);
  });
});
