import { parseAnchorComments } from '../anchors/comment-marker';
import type { NavElementRef, NavPageRef, NavSourcePort } from './source-model';

/**
 * 反向跳转（T6-07 要点 4）：代码视图 anchor 标记 → 跳回设计器元素。
 *
 * 代码里写有 `// @everyonecoding:anchor <elementId>` 注释标记（三重锚定的第 ② 层）。
 * 这一层纯逻辑扫描这些标记，把"某行代码"反向关联到"设计器元素"，由渲染层落地高亮。
 * 同样不触碰 Node IO，可进入 `browser.ts`。
 */

/** 反向命中的单个元素 */
export interface ReverseJumpHit {
  elementId: string;
  filePath: string;
  line: number;
  anchorId: string | null;
  element: NavElementRef | null;
  page: NavPageRef | null;
}

/** 反向跳转结果 */
export interface ReverseJumpResult {
  success: boolean;
  hits: ReverseJumpHit[];
  message: string;
}

export class ReverseJumpService {
  private readonly source: NavSourcePort;
  private readonly clock: () => number;
  private readonly elementIndex = new Map<string, { element: NavElementRef; page: NavPageRef }>();
  private readonly reverseRecords: { at: number; elementId: string; success: boolean }[] = [];

  constructor(options: { source: NavSourcePort; clock?: () => number }) {
    this.source = options.source;
    this.clock = options.clock ?? (() => Date.now());
    for (const page of this.source.listPages()) {
      for (const element of page.elements) {
        this.elementIndex.set(element.elementId, { element, page });
      }
    }
  }

  /** 扫描文件中的 `// @everyonecoding:anchor <elementId>` 标记并定位到行号 */
  scanFile(filePath: string): ReverseJumpHit[] {
    const content = this.source.readFile(filePath);
    if (content === null) return [];
    const records = parseAnchorComments(content, filePath);
    return records.map((record) => {
      const found = this.elementIndex.get(record.elementId) ?? null;
      return {
        elementId: record.elementId,
        filePath,
        line: record.line,
        anchorId: null,
        element: found === null ? null : found.element,
        page: found === null ? null : found.page,
      };
    });
  }

  /** 代码视图 Ctrl+点击某一行 → 跳回设计器对应元素并高亮 */
  jumpFromCode(input: { filePath: string; line: number }): ReverseJumpResult {
    const hits = this.scanFile(input.filePath);
    const hit = hits.find((candidate) => candidate.line === input.line) ?? null;
    const success = hit !== null;
    const elementId = hit?.elementId ?? '';
    this.reverseRecords.push({ at: this.clock(), elementId, success });

    if (success && hit !== null) {
      return {
        success: true,
        hits: [hit],
        message:
          `跳回设计器元素 ${hit.elementId}` +
          (hit.element !== null ? `（${hit.element.name}）` : ''),
      };
    }
    return { success: false, hits: [], message: `当前行 ${input.line} 无锚点标记` };
  }

  /** 反向跳转成功率统计 */
  stats(): { total: number; success: number; rate: number } {
    const total = this.reverseRecords.length;
    const success = this.reverseRecords.filter((record) => record.success).length;
    const rate = total === 0 ? 1 : success / total;
    return { total, success, rate };
  }

  /** 双向跳转成功率统计：forwards 为正跳结果，返回 combined rate（分母保留所有跳转） */
  combinedStats(forwards: { total: number; success: number }): {
    total: number;
    success: number;
    rate: number;
  } {
    const total = forwards.total + this.stats().total;
    const success = forwards.success + this.stats().success;
    const rate = total === 0 ? 1 : success / total;
    return { total, success, rate };
  }
}
