import { describe, expect, it } from 'vitest';
import { nameSimilarity } from '@ec/ai';

import { relocateAnchors, relocationSuccessRate, type HealingCodePort } from '../healing/anchor-relocator';
import { fixLinks, LINK_FIX_SIMILARITY_THRESHOLD, type LinkTargetIndex } from '../healing/link-fixer';
import { checkAttachments, hashOfHashName, type AttachmentContentPort } from '../healing/attachment-checker';
import { buildHealingReport, healingReportToMarkdown, serializeHealingReport } from '../healing/healing-report';
import { sha256Hex } from '../format/checksum';
import type { RelocatableAnchor } from '../healing/healing-types';

/** 构造一个带锚点注释标记的源文件 */
function sourceWithAnchor(elementId: string, symbol: string, padLines: number): string {
  const padding = Array.from({ length: padLines }, (_, i) => `// filler line ${i + 1}`).join('\n');
  return `${padding}\n// @everyonecoding:anchor ${elementId}\nexport class ${symbol} {}\n`;
}

/** 20 个漂移锚点的工程夹具：17 个行号漂移 + 2 个文件被移动 + 1 个彻底丢失 */
function buildDriftedProject(): { port: HealingCodePort; anchors: RelocatableAnchor[] } {
  const files = new Map<string, string>();
  const anchors: RelocatableAnchor[] = [];

  // 17 个行号漂移：符号与标记都在，只是前面多了几行
  for (let i = 0; i < 17; i += 1) {
    const elementId = `el-${i}`;
    const symbol = `Service${i}`;
    const originalPad = 2;
    const driftedPad = 2 + (i % 5) + 1; // 导入后多了 1~6 行
    files.set(`src/svc${i}.ts`, sourceWithAnchor(elementId, symbol, driftedPad));
    anchors.push({
      id: `anc-${i}`,
      elementId,
      symbol,
      filePath: `src/svc${i}.ts`,
      kind: 'service',
      startLine: originalPad + 2, // 原行号（漂移前）
      endLine: originalPad + 2,
    });
  }

  // 2 个文件被移动：原路径不在了，新路径带着注释标记
  for (let i = 0; i < 2; i += 1) {
    const elementId = `el-moved-${i}`;
    const symbol = `MovedController${i}`;
    files.set(`src/controllers/moved${i}.ts`, sourceWithAnchor(elementId, symbol, 3));
    anchors.push({
      id: `anc-moved-${i}`,
      elementId,
      symbol,
      filePath: `src/old/moved${i}.ts`, // 旧路径已不存在
      kind: 'controller',
      startLine: 3,
      endLine: 3,
    });
  }

  // 1 个彻底丢失：文件与符号都不在
  anchors.push({
    id: 'anc-lost',
    elementId: 'el-lost',
    symbol: 'LostRepo',
    filePath: 'src/lost.ts',
    kind: 'repo',
    startLine: 1,
    endLine: 1,
  });

  const port: HealingCodePort = {
    readFile: (_projectId, relativePath) => files.get(relativePath) ?? null,
    listFiles: (_projectId) => [...files.keys()],
  };
  return { port, anchors };
}

describe('锚点重定位（T8-04 / FR-PKG-10：成功率 ≥90%）', () => {
  it('20 个漂移锚点：19 个自动恢复（成功率 95% ≥ 90%）', () => {
    const { port, anchors } = buildDriftedProject();
    const relocations = relocateAnchors(anchors, 'proj-1', port);

    expect(relocations.length).toBe(20);
    const relocated = relocations.filter((r) => r.status === 'relocated');
    const unchanged = relocations.filter((r) => r.status === 'unchanged');
    const missing = relocations.filter((r) => r.status === 'missing');
    const ambiguous = relocations.filter((r) => r.status === 'ambiguous');

    // 行号漂移的 17 个：标记与符号都在原文件 → relocated（行号更新）
    // 移动的 2 个：原路径不在 → 全项目搜索标记命中新文件 → relocated
    expect(relocated.length).toBe(19);
    expect(unchanged.length).toBe(0);
    expect(missing.length).toBe(1);
    expect(ambiguous.length).toBe(0);

    const rate = relocationSuccessRate(relocations);
    expect(rate).toBeGreaterThanOrEqual(0.9);
    expect(rate).toBeCloseTo(0.95, 2);
  });

  it('行号漂移的锚点更新到正确行号', () => {
    const { port, anchors } = buildDriftedProject();
    const relocations = relocateAnchors(anchors, 'proj-1', port);
    const first = relocations.find((r) => r.anchorId === 'anc-0');
    expect(first?.status).toBe('relocated');
    // src/svc0.ts：filler 3 行 + 标记 1 行 → 符号在第 5 行
    expect(first?.newStartLine).toBe(5);
    expect(first?.reason).toContain('重新定位');
  });

  it('被移动的文件按注释标记找到新路径', () => {
    const { port, anchors } = buildDriftedProject();
    const relocations = relocateAnchors(anchors, 'proj-1', port);
    const moved = relocations.find((r) => r.anchorId === 'anc-moved-0');
    expect(moved?.status).toBe('relocated');
    expect(moved?.newFilePath).toBe('src/controllers/moved0.ts');
    expect(moved?.oldFilePath).toBe('src/old/moved0.ts');
  });

  it('彻底丢失的锚点如实上报 missing（不瞎猜位置）', () => {
    const { port, anchors } = buildDriftedProject();
    const relocations = relocateAnchors(anchors, 'proj-1', port);
    const lost = relocations.find((r) => r.anchorId === 'anc-lost');
    expect(lost?.status).toBe('missing');
    expect(lost?.newFilePath).toBeNull();
    expect(lost?.reason).toContain('无命中');
  });

  it('无标记且无符号的文件移动上报 ambiguous 并给出候选', () => {
    const files = new Map<string, string>([
      ['src/a.ts', 'export class Alpha {}\n'],
      ['src/b.ts', 'export class Alpha {}\n'],
    ]);
    const port: HealingCodePort = {
      readFile: (_projectId, path) => files.get(path) ?? null,
      listFiles: () => [...files.keys()],
    };
    const relocations = relocateAnchors(
      [{ id: 'anc-x', elementId: null, symbol: 'Alpha', filePath: 'src/gone.ts', kind: 'service', startLine: 1, endLine: 1 }],
      'proj-1',
      port,
    );
    expect(relocations[0]?.status).toBe('ambiguous');
    expect(relocations[0]?.candidates.length).toBe(2);
  });
});

describe('失效链接修复（T8-04）', () => {
  const index: LinkTargetIndex = {
    memory: new Map([
      ['mem-new-1', '用户登录偏好'],
      ['mem-new-2', '登录安全策略'],
      ['mem-new-3', 'User Login Preference'],
    ]),
    document: new Map([['doc-new-1', '需求文档 v2']]),
  };

  it('目标仍在 → ok', () => {
    const outcomes = fixLinks(
      [{ linkId: 'l1', sourceType: 'document', sourceId: 'doc-new-1', targetType: 'memory', targetId: 'mem-new-1' }],
      index,
    );
    expect(outcomes[0]?.status).toBe('ok');
    expect(outcomes[0]?.newTargetId).toBeNull();
  });

  it('目标 id 变化但名称精确匹配 → 重定向', () => {
    const outcomes = fixLinks(
      [
        {
          linkId: 'l2',
          sourceType: 'memory',
          sourceId: 'mem-new-1',
          targetType: 'document',
          targetId: 'doc-old-1',
          targetName: '需求文档 v2',
        },
      ],
      index,
    );
    expect(outcomes[0]?.status).toBe('fixed');
    expect(outcomes[0]?.newTargetId).toBe('doc-new-1');
  });

  it('名称相似度达到阈值且候选唯一 → 重定向（走相似度分支）', () => {
    // 精确分支不命中（连字符 vs 空格），但 nameSimilarity 去掉非字母数字后完全一致 → 1.0
    const outcomes = fixLinks(
      [
        {
          linkId: 'l3',
          sourceType: 'document',
          sourceId: 'doc-new-1',
          targetType: 'memory',
          targetId: 'mem-old-9',
          targetName: 'user-login-preference',
        },
      ],
      index,
    );
    expect(outcomes[0]?.status).toBe('fixed');
    expect(outcomes[0]?.newTargetId).toBe('mem-new-3');
    expect(nameSimilarity('user-login-preference', 'User Login Preference')).toBeGreaterThanOrEqual(
      LINK_FIX_SIMILARITY_THRESHOLD,
    );
  });

  it('零候选或多候选 → unresolvable（绝不瞎连）', () => {
    const outcomes = fixLinks(
      [
        { linkId: 'l4', sourceType: 'document', sourceId: 'd', targetType: 'memory', targetId: 'gone', targetName: '完全不存在的名字' },
        // 「登录…」两个候选（登录偏好/安全策略都以"登录"开头但整体不同——用相似度双双命中的场景改用精确重复名）
        { linkId: 'l5', sourceType: 'document', sourceId: 'd', targetType: 'memory', targetId: 'gone2', targetName: '' },
      ],
      index,
    );
    expect(outcomes[0]?.status).toBe('unresolvable');
    expect(outcomes[1]?.status).toBe('unresolvable');
  });

  it('多候选场景：重复名称 → unresolvable', () => {
    const dupIndex: LinkTargetIndex = {
      memory: new Map([
        ['m1', '同名条目'],
        ['m2', '同名条目'],
      ]),
      document: new Map(),
    };
    const outcomes = fixLinks(
      [{ linkId: 'l6', sourceType: 'document', sourceId: 'd', targetType: 'memory', targetId: 'gone', targetName: '同名条目' }],
      dupIndex,
    );
    expect(outcomes[0]?.status).toBe('unresolvable');
    expect(outcomes[0]?.detail).toContain('2 个候选');
  });
});

describe('附件清点（T8-04）', () => {
  function makePort(files: Map<string, Buffer>, referenced: string[]): AttachmentContentPort {
    return {
      listReferencedAttachments: () => referenced.map((hashName) => ({ hashName, referencedBy: 'documents/doc-1' })),
      readAttachment: (hashName) => files.get(hashName) ?? null,
    };
  }

  it('hashOfHashName 取哈希部分', () => {
    expect(hashOfHashName('9f2c1dab.png')).toBe('9f2c1dab');
    expect(hashOfHashName('abc123')).toBe('abc123');
  });

  it('缺失 / 损坏 / 完好三类各就各位', () => {
    const good = Buffer.from('good attachment content');
    const goodHash = sha256Hex(good);
    const corruptedContent = Buffer.from('corrupted!');
    const files = new Map<string, Buffer>([
      [`${goodHash}.bin`, good],
      ['eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.txt', corruptedContent],
    ]);
    const port = makePort(files, [`${goodHash}.bin`, 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.png', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.txt']);

    const result = checkAttachments(port);
    expect(result.checked).toBe(3);
    expect(result.issues.find((issue) => issue.status === 'missing')?.hashName.startsWith('ffff')).toBe(true);
    expect(result.issues.find((issue) => issue.status === 'corrupted')?.hashName.startsWith('eeee')).toBe(true);
    expect(result.issues.filter((issue) => issue.hashName.startsWith(goodHash.slice(0, 8)))).toEqual([]);
  });
});

describe('自愈报告（T8-04：可查看与导出）', () => {
  it('汇总三类结果并给出建议', () => {
    const { port, anchors } = buildDriftedProject();
    const relocations = relocateAnchors(anchors, 'proj-1', port);
    const report = buildHealingReport({
      anchors: relocations,
      links: [
        { linkId: 'l1', sourceType: 'memory', sourceId: 'm1', targetType: 'document', targetId: 'gone', status: 'unresolvable', newTargetId: null, detail: '找不到' },
      ],
      attachmentIssues: [{ hashName: 'ffff.png', status: 'missing', detail: '缺失' }],
      attachmentsChecked: 5,
    });

    expect(report.anchors.total).toBe(20);
    expect(report.anchors.successRate).toBeCloseTo(0.95, 2);
    expect(report.links.unresolvableCount).toBe(1);
    expect(report.attachments.checked).toBe(5);
    expect(report.suggestions.join('；')).toContain('无法自动修复');
    expect(report.suggestions.join('；')).toContain('缺失');
  });

  it('JSON 与 Markdown 导出都包含关键段落', () => {
    const report = buildHealingReport({
      anchors: [],
      links: [],
      attachmentIssues: [],
      attachmentsChecked: 0,
    });
    const json = serializeHealingReport(report);
    expect(JSON.parse(json).anchors.total).toBe(0);

    const markdown = healingReportToMarkdown(report);
    expect(markdown).toContain('# 导入自愈报告');
    expect(markdown).toContain('## 锚点重定位');
    expect(markdown).toContain('## 关联修复');
    expect(markdown).toContain('## 附件清点');
    expect(markdown).toContain('自愈完成');
  });
});
