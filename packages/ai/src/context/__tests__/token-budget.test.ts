import { describe, expect, it } from 'vitest';

import { estimateTextTokens, type ContextBlock, type ContextBlockItem } from '../context-types';
import { codeWeight } from '../blocks/code';
import { documentWeight } from '../blocks/document';
import { memoryItemWeight } from '../blocks/shared';
import {
  CONTEXT_BLOCK_QUOTAS,
  DEFAULT_CONTEXT_BUDGET,
  PURPOSE_PROFILE_BUDGETS,
  createAggressiveBudget,
  createTokenBudget,
  cutItemsByLimit,
  profileForPurpose,
} from '../token-budget';
import { aggressiveTrim, assembledTokens, trimToBudget } from '../trimmer';
import {
  buildTruncateReport,
  describeReportDetail,
  describeTruncation,
  groupOmittedByBlock,
} from '../truncate-report';

/* ------------------------------ 夹具 ------------------------------ */

function item(key: string, tokens: number, weight: number, label = key): ContextBlockItem {
  return { key, label, tokens, weight, text: `${label}：${'x'.repeat(Math.max(1, tokens))}` };
}

function block(id: ContextBlock['id'], items: ContextBlockItem[]): ContextBlock {
  const quota = CONTEXT_BLOCK_QUOTAS.find((entry) => entry.id === id);
  const tokens = items.reduce((sum, entry) => sum + entry.tokens, 0);
  return {
    id,
    label: quota?.label ?? id,
    priority: quota?.priority ?? 0,
    quota: quota?.quota ?? 8_000,
    tokens,
    content: items.map((entry) => entry.text).join('\n\n'),
    source: 'test',
    editable: true,
    items,
  };
}

/* ------------------------------ 预算 ------------------------------ */

describe('Token 预算（T4-03 要点 1）', () => {
  it('默认总预算 128k，各用途映射到不同档位', () => {
    expect(createTokenBudget().total).toBe(DEFAULT_CONTEXT_BUDGET);
    expect(profileForPurpose('code')).toBe('code-generation');
    expect(profileForPurpose('techdoc')).toBe('document-generation');
    expect(profileForPurpose('memory-extract')).toBe('memory-extraction');
    expect(profileForPurpose('commit-msg')).toBe('commit-message');
    expect(PURPOSE_PROFILE_BUDGETS['memory-extraction']).toBe(32_000);

    expect(createTokenBudget({ purpose: 'memory-extract' }).total).toBe(32_000);
    expect(createTokenBudget({ purpose: 'techdoc' }).total).toBe(64_000);
  });

  it('块配额之和大于总预算是设计如此（配额是上限，预算才是硬约束）', () => {
    const budget = createTokenBudget();
    expect(budget.quotaSum).toBeGreaterThan(budget.total);
  });

  it('支持按块覆盖配额（激进裁剪依赖它）', () => {
    const budget = createTokenBudget({ overrides: { code: 0, note: 100 } });
    expect(budget.quotas.code.quota).toBe(0);
    expect(budget.quotas.note.quota).toBe(100);
    expect(budget.quotas.project.quota).toBe(24_000);
  });

  it('激进档位只给元素链 / 备注 / 页面留配额', () => {
    const aggressive = createAggressiveBudget(createTokenBudget());
    expect(aggressive.total).toBe(32_000);
    expect(aggressive.quotas['element-chain'].quota).toBe(1_500);
    expect(aggressive.quotas.note.quota).toBe(2_500);
    expect(aggressive.quotas.page.quota).toBe(2_000);
    expect(aggressive.quotas.code.quota).toBe(0);
    expect(aggressive.quotas.project.quota).toBe(0);
  });

  it('cutItemsByLimit 按权重降序保留，权重相同按 key 稳定排序', () => {
    const items = [item('a', 100, 1), item('b', 100, 5), item('c', 100, 3)];
    const { kept, omitted } = cutItemsByLimit(items, 250);
    expect(kept.map((entry) => entry.key)).toEqual(['b', 'c']);
    expect(omitted.map((entry) => entry.key)).toEqual(['a']);

    expect(cutItemsByLimit(items, 0).kept).toEqual([]);
    expect(cutItemsByLimit(items, 0).omitted).toHaveLength(3);
  });
});

/* ------------------------------ 块内裁剪 ------------------------------ */

describe('单块内部裁剪策略（T4-03 要点 4）', () => {
  it('记忆按 importance × confidence 排序（含时间衰减）', () => {
    const now = 1_760_000_000_000;
    const high = memoryItemWeight({ id: 'h', scope: 'project', title: '高', content: '', importance: 5, confidence: 1, updatedAt: now }, now);
    const low = memoryItemWeight({ id: 'l', scope: 'project', title: '低', content: '', importance: 2, confidence: 0.5, updatedAt: now }, now);
    const stale = memoryItemWeight({ id: 's', scope: 'project', title: '旧', content: '', importance: 5, confidence: 1, updatedAt: now - 180 * 24 * 3600 * 1000 }, now);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(stale);
    // 半衰期 30 天：180 天后仍保留 1/4 的衰减因子，不会归零
    expect(stale).toBeGreaterThan(high * 0.4);
  });

  it('代码按 Code Anchor 命中度排序（命中锚点额外加权）', () => {
    const anchored = codeWeight(
      { filePath: 'a.ts', symbol: 'A', kind: 'service', startLine: 1, endLine: 2, language: 'ts', snippet: '', score: 0.5, anchorId: 'anchor-el-btn' },
      'el-btn',
    );
    const plain = codeWeight(
      { filePath: 'b.ts', symbol: 'B', kind: 'service', startLine: 1, endLine: 2, language: 'ts', snippet: '', score: 0.5 },
      null,
    );
    expect(anchored).toBeGreaterThan(plain);
    expect(anchored).toBeCloseTo(1.0, 5);
  });

  it('文档按相关段落截断：标题命中的章节权重更高', () => {
    const hit = documentWeight(
      { id: 'd1', documentId: 'D', title: '技术文档', kind: 'techdoc', heading: '登录鉴权', content: '登录接口契约', score: 0.6 },
      '登录 鉴权',
    );
    const miss = documentWeight(
      { id: 'd2', documentId: 'D', title: '技术文档', kind: 'techdoc', heading: '部署', content: '构建流程', score: 0.6 },
      '登录 鉴权',
    );
    expect(hit).toBeGreaterThan(miss);
  });

  it('块内裁剪后 tokens 由保留内容重新估算，且省略理由为 block-over-quota', () => {
    const target = block('longterm', [item('a', 400, 1), item('b', 400, 9)]);
    // 配额以预算为准（单一事实来源），块自身的 quota 字段只作展示
    const budget = createTokenBudget({ overrides: { longterm: 500 } });
    const { blocks, report } = trimToBudget([target], budget);
    const after = blocks[0];
    expect(after?.items.map((entry) => entry.key)).toEqual(['b']);
    expect(after?.tokens).toBe(400);
    expect(report?.items[0]?.reason).toBe('block-over-quota');
    expect(report?.items[0]?.block).toBe('longterm');
  });
});

/* ------------------------------ 总预算裁剪 ------------------------------ */

describe('超预算按优先级裁剪（T4-03 要点 2）', () => {
  it('保留顺序严格为 元素链 > 备注 > 页面 > 功能 > 项目 > 长期 > 文档', () => {
    const blocks = [
      block('document', [item('doc', 900, 1)]),
      block('longterm', [item('lt', 900, 1)]),
      block('project', [item('pj', 900, 1)]),
      block('feature', [item('ft', 900, 1)]),
      block('page', [item('pg', 900, 1)]),
      block('note', [item('nt', 900, 1)]),
      block('element-chain', [item('el', 900, 1)]),
    ];
    // 3000 token 预算 = 只够留下优先级最高的 3 块
    const { blocks: trimmed, report } = trimToBudget(blocks, createTokenBudget({ total: 3_000 }));
    const kept = trimmed.filter((entry) => entry.tokens > 0).map((entry) => entry.id);

    expect(new Set(kept)).toEqual(new Set(['element-chain', 'note', 'page']));
    // 被省略的按「优先级从低到高」逐个让位
    expect(report?.items.map((entry) => entry.block)).toEqual(['document', 'longterm', 'project', 'feature']);
    expect(report?.items.every((entry) => entry.reason === 'block-over-budget')).toBe(true);
  });

  it('优先级数值本身满足 元素链 > 备注 > 页面 > 功能 > 项目 > 长期 > 文档', () => {
    const byId = new Map(CONTEXT_BLOCK_QUOTAS.map((quota) => [quota.id, quota.priority]));
    const order = ['element-chain', 'note', 'page', 'feature', 'project', 'longterm', 'document'] as const;
    const values = order.map((id) => byId.get(id) ?? 0);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it('高优先级块不会因为总预算被裁（除非自身超配额）', () => {
    const blocks = [
      block('note', [item('nt', 2_000, 1)]),
      block('document', [item('doc', 30_000, 1)]),
    ];
    blocks[0]!.quota = 5_000;
    const { blocks: trimmed } = trimToBudget(blocks, createTokenBudget({ total: 5_000 }));
    expect(trimmed.find((entry) => entry.id === 'note')?.tokens).toBe(2_000);
    expect(trimmed.find((entry) => entry.id === 'document')?.tokens).toBe(0);
  });

  it('指令块永不被裁剪 + 裁剪后再组装的总 token 不超预算（断言）', () => {
    const cases = [1_000, 3_000, 8_000, 20_000];
    for (const total of cases) {
      const blocks = [
        block('instruction', [item('task', 500, 1_000)]),
        block('project', [item('pj1', 600, 9), item('pj2', 600, 5)]),
        block('code', [item('c1', 2_000, 0.9), item('c2', 2_000, 0.4)]),
        block('document', [item('d1', 1_500, 0.8), item('d2', 1_500, 0.2)]),
      ];
      const { blocks: trimmed, totalTokens } = trimToBudget(blocks, createTokenBudget({ total }));
      expect(totalTokens).toBeLessThanOrEqual(total);
      expect(trimmed.find((entry) => entry.id === 'instruction')?.tokens).toBe(500);
      expect(assembledTokens(trimmed)).toBe(totalTokens);
    }
  });

  it('未超预算时不做任何裁剪，报告为 null', () => {
    const blocks = [block('project', [item('pj', 100, 1)]), block('note', [item('nt', 100, 1)])];
    const { report, blocks: trimmed } = trimToBudget(blocks, createTokenBudget({ total: 10_000 }));
    expect(report).toBeNull();
    expect(trimmed.every((entry) => entry.tokens > 0)).toBe(true);
  });
});

/* ------------------------------ 激进裁剪 ------------------------------ */

describe('激进裁剪（T4-03 要点 3）', () => {
  it('只保留元素链 + 备注 + 页面记忆，其余全部记为 aggressive-trim', () => {
    const blocks = [
      block('longterm', [item('lt', 500, 1)]),
      block('project', [item('pj', 500, 1)]),
      block('feature', [item('ft', 500, 1)]),
      block('page', [item('pg', 500, 1)]),
      block('element-chain', [item('el', 500, 1)]),
      block('note', [item('nt', 500, 1)]),
      block('issue', [item('is', 500, 1)]),
      block('document', [item('doc', 500, 1)]),
      block('code', [item('code', 5_000, 1)]),
    ];
    const { blocks: trimmed, report } = aggressiveTrim(blocks, createTokenBudget());

    const keptIds = trimmed.filter((entry) => entry.tokens > 0).map((entry) => entry.id);
    expect(keptIds).toEqual(['page', 'element-chain', 'note']);
    expect(report?.aggressive).toBe(true);
    expect(report?.items.filter((entry) => entry.reason === 'aggressive-trim')).toHaveLength(6);
    expect(trimmed.find((entry) => entry.id === 'code')?.tokens).toBe(0);
  });

  it('激进裁剪后总量同样不超激进预算', () => {
    const blocks = [
      block('note', Array.from({ length: 30 }, (_, index) => item(`n${index}`, 400, 30 - index))),
      block('element-chain', [item('el', 400, 1)]),
      block('page', Array.from({ length: 10 }, (_, index) => item(`p${index}`, 400, 10 - index))),
      block('project', [item('pj', 40_000, 1)]),
    ];
    const { totalTokens, blocks: trimmed } = aggressiveTrim(blocks, createTokenBudget());
    const aggressive = createAggressiveBudget(createTokenBudget());
    expect(totalTokens).toBeLessThanOrEqual(aggressive.total);
    expect(trimmed.find((entry) => entry.id === 'project')?.tokens).toBe(0);
  });
});

/* ------------------------------ 省略报告 ------------------------------ */

describe('省略报告（T4-03 要点 3）', () => {
  it('数量 / token / 条目 / 摘要 / 原因分组准确', () => {
    const report = buildTruncateReport({
      items: [
        { block: 'code', blockLabel: '已有代码与 Code Anchor', label: 'A', tokens: 500, reason: 'block-over-budget', preview: 'a' },
        { block: 'code', blockLabel: '已有代码与 Code Anchor', label: 'B', tokens: 300, reason: 'block-over-budget', preview: 'b' },
        { block: 'project', blockLabel: '项目记忆', label: 'C', tokens: 200, reason: 'block-over-quota', preview: 'c' },
      ],
      beforeTokens: 20_000,
      afterTokens: 19_000,
      aggressive: false,
    });

    expect(report.omittedCount).toBe(3);
    expect(report.omittedTokens).toBe(1_000);
    expect(report.byReason['block-over-budget']).toBe(2);
    expect(report.byReason['block-over-quota']).toBe(1);
    expect(report.summary).toBe('已省略 3 项（点击展开）');
    expect(describeTruncation(report)).toContain('已省略 3 项');
    expect(describeTruncation(null)).toBe('上下文完整提交，无省略');

    const groups = groupOmittedByBlock(report);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.items).toHaveLength(2);
    expect(describeReportDetail(report)).toContain('已有代码与 Code Anchor 2 项');
  });

  it('被省略条目带可展开的内容摘要（截断到 200 字）', async () => {
    const longText = '很长的内容'.repeat(200);
    const target: ContextBlock = {
      id: 'document',
      label: '文档相关章节',
      priority: 300,
      quota: 100,
      tokens: estimateTextTokens(longText) + estimateTextTokens('短'),
      content: longText,
      source: 'test',
      editable: false,
      items: [
        { key: 'long', label: '长片段', tokens: estimateTextTokens(longText), weight: 1, text: longText },
        { key: 'short', label: '短片段', tokens: estimateTextTokens('短'), weight: 0.5, text: '短' },
      ],
    };
    const { report } = trimToBudget([target], createTokenBudget({ overrides: { document: 100 } }));
    const omitted = report?.items[0];
    expect(omitted?.preview.endsWith('…')).toBe(true);
    expect(omitted?.preview.length).toBeLessThanOrEqual(201);
  });
});
