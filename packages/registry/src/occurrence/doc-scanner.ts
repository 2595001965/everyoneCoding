/**
 * 文档扫描器（T7-02 要点 2，FR-UNI-09）。
 *
 * 扫描需求文档 / 技术文档 / 关联文档中对某个名称的提及，**按段落定位**：
 * - `refPath` = 文档 id；`locator` = 段落锚点（标题 slug 或 `p<n>` 段序号）
 * - 覆盖 **图表标题、表头、正文**（PRD FR-UNI-09 验收要点）——标题 / 表头 / 表格行 / 正文段落
 *   分别产出独立命中，便于逐项勾选
 * - 语义匹配带置信度（`semantic.mentionConfidence`），高置信自动改、低置信列为候选
 *
 * 精确命中（规范名或八类投影的原文出现）置信度 0.95；核心词命中 0.8；其余按相似度折算。
 */

import type { ProjectionKind } from '../naming/presets';
import { PROJECTION_KINDS } from '../naming/presets';
import { mentionConfidence } from './semantic';
import type { DocSource } from './types';

/** 文档块类型（图表标题 = heading；表头 = table-header） */
export const DOC_BLOCK_KINDS = ['heading', 'table-header', 'table-row', 'paragraph', 'code-fence'] as const;
export type DocBlockKind = (typeof DOC_BLOCK_KINDS)[number];

/** 一条文档命中 */
export interface DocHit {
  refPath: string;
  locator: string;
  blockKind: DocBlockKind;
  symbol: string;
  matchedSymbol: ProjectionKind | null;
  confidence: number;
  /** 命中片段（UI 展开查看） */
  excerpt: string;
  detail: string;
}

interface Block {
  kind: DocBlockKind;
  anchor: string;
  text: string;
  line: number;
}

/** 标题 → 锚点 slug（与常见 Markdown 渲染器口径一致：小写、空格转 `-`、去标点） */
export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
    .replace(/\s+/g, '-');
}

/** 把 Markdown 切成可定位的块 */
export function splitDocBlocks(content: string): Block[] {
  const lines = content.split('\n');
  const blocks: Block[] = [];
  let sectionAnchor = 'top';
  let paragraph: string[] = [];
  let paragraphLine = 1;
  let inFence = false;
  let fence: string[] = [];
  let fenceLine = 1;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({
      kind: 'paragraph',
      anchor: sectionAnchor,
      text: paragraph.join('\n'),
      line: paragraphLine,
    });
    paragraph = [];
  };

  const flushFence = (): void => {
    if (fence.length === 0) return;
    blocks.push({ kind: 'code-fence', anchor: sectionAnchor, text: fence.join('\n'), line: fenceLine });
    fence = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNo = index + 1;
    if (line.trimStart().startsWith('```')) {
      if (inFence) {
        inFence = false;
        flushFence();
      } else {
        flushParagraph();
        inFence = true;
        fenceLine = lineNo;
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      sectionAnchor = slugify(heading[2] ?? '') || `section-${lineNo}`;
      blocks.push({ kind: 'heading', anchor: sectionAnchor, text: heading[2] ?? '', line: lineNo });
      continue;
    }
    if (line.trimStart().startsWith('|')) {
      flushParagraph();
      // Markdown 表格的分隔行（`| --- | --- |`）不是内容，跳过以免污染"表头 / 表格行"分类
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const next = lines[index + 1] ?? '';
      const isHeader = /^\s*\|[\s:|-]+\|\s*$/.test(next);
      blocks.push({
        kind: isHeader ? 'table-header' : 'table-row',
        anchor: sectionAnchor,
        text: line,
        line: lineNo,
      });
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    if (paragraph.length === 0) paragraphLine = lineNo;
    paragraph.push(line);
  }
  flushParagraph();
  flushFence();
  return blocks;
}

/** 定位串：`#<slug>` 或 `#<slug>:p<n>`（段落序号，便于同节内区分） */
function locatorOf(block: Block, ordinal: number): string {
  return block.kind === 'heading' ? `#${block.anchor}` : `#${block.anchor}:p${ordinal}`;
}

const BLOCK_LABELS: Readonly<Record<DocBlockKind, string>> = {
  heading: '标题',
  'table-header': '表头',
  'table-row': '表格行',
  paragraph: '正文',
  'code-fence': '代码块',
};

/** 汇总待匹配符号（规范名 + 八类投影，去重） */
function targetsOf(canonicalName: string, projections: Partial<Record<ProjectionKind, string>>): {
  symbol: string;
  kind: ProjectionKind | null;
}[] {
  const out: { symbol: string; kind: ProjectionKind | null }[] = [];
  const seen = new Set<string>();
  const add = (symbol: string, kind: ProjectionKind | null): void => {
    if (symbol.length === 0 || seen.has(symbol)) return;
    seen.add(symbol);
    out.push({ symbol, kind });
  };
  add(canonicalName, null);
  for (const kind of PROJECTION_KINDS) {
    const value = projections[kind];
    if (value !== undefined) add(value, kind);
  }
  return out;
}

/**
 * 扫描单个文档。
 *
 * 每个块内：所有"精确 / 强包含"命中全部产出（便于逐项勾选）；
 * 若该块没有精确命中，则补一条语义候选（最高相似度那条，confidence 0.5~0.79）。
 */
export function scanDoc(doc: DocSource, input: {
  canonicalName: string;
  projections: Partial<Record<ProjectionKind, string>>;
}): DocHit[] {
  const blocks = splitDocBlocks(doc.content);
  const targets = targetsOf(input.canonicalName, input.projections);
  const hits: DocHit[] = [];
  const ordinals = new Map<string, number>();

  blocks.forEach((block) => {
    const exact: DocHit[] = [];
    let best: DocHit | null = null;
    for (const target of targets) {
      const confidence = mentionConfidence(block.text, target.symbol);
      if (confidence >= 0.8) {
        exact.push({
          refPath: doc.id,
          locator: locatorOf(block, (ordinals.get(block.anchor) ?? 0) + 1),
          blockKind: block.kind,
          symbol: target.symbol,
          matchedSymbol: target.kind,
          confidence,
          excerpt: block.text.trim().slice(0, 200),
          detail: `文档《${doc.title}》第 ${block.line} 行（${BLOCK_LABELS[block.kind]}）提及「${target.symbol}」`,
        });
        continue;
      }
      if (confidence >= 0.5 && (best === null || confidence > best.confidence)) {
        best = {
          refPath: doc.id,
          locator: locatorOf(block, (ordinals.get(block.anchor) ?? 0) + 1),
          blockKind: block.kind,
          symbol: target.symbol,
          matchedSymbol: target.kind,
          confidence,
          excerpt: block.text.trim().slice(0, 200),
          detail: `文档《${doc.title}》第 ${block.line} 行（${BLOCK_LABELS[block.kind]}）疑似提及「${target.symbol}」（语义匹配 ${confidence.toFixed(2)}）`,
        };
      }
    }
    ordinals.set(block.anchor, (ordinals.get(block.anchor) ?? 0) + 1);
    if (exact.length > 0) hits.push(...exact);
    else if (best !== null) hits.push(best);
  });

  return hits;
}

/** 批量扫描文档集合 */
export function scanDocs(docs: readonly DocSource[], input: {
  canonicalName: string;
  projections: Partial<Record<ProjectionKind, string>>;
}): DocHit[] {
  return docs.flatMap((doc) => scanDoc(doc, input));
}
