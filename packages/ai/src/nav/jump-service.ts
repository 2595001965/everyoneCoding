import type {
  NavElementRef,
  NavPageRef,
  NavSourcePort,
  NavTarget,
  NavTargetKind,
} from './source-model';
import {
  anchorConfidenceOf,
  anchorToTarget,
  apiToTarget,
  docToTarget,
  elementToTarget,
  inSameDir,
  lastSegment,
  pageToTarget,
  scoreTarget,
  tableToTarget,
  testToTarget,
} from './target-resolver';

/**
 * Ctrl+点击跳转服务（T6-07 要点 1 / 2）。
 *
 * 解析一个设计器元素 / 页面名 → 跳转到哪些代码位置：把"该元素的锚点 + 四类清单 +
 * 元素 / 页面本身"统一成 `NavTarget[]`，按层级分组（`layers`）供下拉选择。
 * `commit` 不真正滚动代码，只返回"滚动定位 + 高亮行"指令并登记跳转历史，
 * 真正的视图动作由渲染层落地。双向跳转成功率（≥95% 验收）由 `stats` 统计。
 */

/** 跳转请求（由渲染层在 Ctrl+点击时发起） */
export interface JumpRequest {
  projectId: string;
  page: NavPageRef;
  element: NavElementRef;
  /** 当前打开的文件（用于"就近优先"） */
  currentFile?: string | null;
  /** 只允许这些类型（未指定则全部） */
  kinds?: readonly NavTargetKind[];
}

/** 单个层级的下拉选项（如 Controller 方法组） */
export interface JumpLayerOption {
  layer: number;
  label: string;
  targets: NavTarget[];
}

/** 跳转解析结果 */
export interface JumpResolution {
  elementId: string;
  /** 按层级分组（Controller 方法 → Service → 数据访问层 → 测试），供下拉选择 */
  layers: JumpLayerOption[];
  /** 全部候选（已按相关度排序） */
  targets: NavTarget[];
  /** 唯一优选目标（只有一个候选或最高分明显领先时非空） */
  preferred: NavTarget | null;
  /** 是否需要用户在层级下拉中做选择（layers.length > 1 或首选分差 < 阈值） */
  needsChoice: boolean;
}

/** 跳转落地的指令结果 */
export interface JumpOutcome {
  success: boolean;
  target: NavTarget | null;
  message: string;
}

/** 首选分差阈值：最高分与次高分差小于此值则视为并列，需要用户选择 */
const PREFERRED_GAP = 0.15;

/** 层级中文标签 */
const LAYER_LABELS: Record<number, string> = {
  0: 'Controller 方法',
  1: 'Service',
  2: '数据访问层',
  3: '测试',
  4: '其它',
};

/** 把候选按层级分组并排序（层级升序，组内保持传入顺序即相关度序） */
function groupByLayer(targets: readonly NavTarget[]): JumpLayerOption[] {
  const byLayer = new Map<number, NavTarget[]>();
  for (const target of targets) {
    const bucket = byLayer.get(target.layer) ?? [];
    bucket.push(target);
    byLayer.set(target.layer, bucket);
  }
  return [...byLayer.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([layer, bucket]) => ({
      layer,
      label: LAYER_LABELS[layer] ?? `层级 ${layer}`,
      targets: bucket,
    }));
}

export class JumpService {
  private readonly source: NavSourcePort;
  private readonly clock: () => number;
  private readonly records: {
    at: number;
    elementId: string;
    targetId: string | null;
    success: boolean;
  }[] = [];
  private readonly listeners = new Set<
    (event: { type: 'jumped' | 'failed'; elementId: string; targetId: string | null }) => void
  >();
  /** 记录最近一次 resolve 的元素，供 commit 登记历史 */
  private lastElementId: string | null = null;

  constructor(options: { source: NavSourcePort; clock?: () => number }) {
    this.source = options.source;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Ctrl+点击元素名 / 页面名 → 解析跳转目标（不产生副作用） */
  resolve(request: JumpRequest): JumpResolution {
    this.lastElementId = request.element.elementId;
    const anchors = this.source
      .listAnchors()
      .filter((candidate) => candidate.elementId === request.element.elementId);
    const currentFile = request.currentFile ?? null;

    const built: NavTarget[] = [];
    for (const anchor of anchors) built.push(anchorToTarget(anchor));
    for (const api of this.source.listApis()) built.push(apiToTarget(api));
    for (const table of this.source.listTables()) built.push(tableToTarget(table));
    for (const test of this.source.listTests()) built.push(testToTarget(test));
    for (const doc of this.source.listDocSections()) built.push(docToTarget(doc));
    built.push(elementToTarget(request.element));
    built.push(pageToTarget(request.page));

    const keyword = `${request.element.name} ${lastSegment(request.page.route)}`;
    const scored = built.map((target) => {
      const anchor = anchors.find((candidate) => `anchor:${candidate.id}` === target.id) ?? null;
      const confidence = anchor === null ? 0 : anchorConfidenceOf(anchor);
      const sameFile = anchor !== null && anchor.filePath === currentFile;
      const sameDir =
        !sameFile &&
        anchor !== null &&
        currentFile !== null &&
        inSameDir(anchor.filePath, currentFile);
      const { score, reasons } = scoreTarget({
        target,
        keyword,
        anchorConfidence: confidence,
        sameFile,
        sameDir,
      });
      return { ...target, score, reasons };
    });

    const kinds = request.kinds;
    const filtered =
      kinds !== undefined && kinds.length > 0
        ? scored.filter((target) => kinds.includes(target.kind))
        : scored;
    const sorted = [...filtered].sort((a, b) => b.score - a.score);

    const layers = groupByLayer(sorted);

    let preferred: NavTarget | null = null;
    if (sorted.length === 1) {
      preferred = sorted[0] ?? null;
    } else if (sorted.length >= 2) {
      const top = sorted[0];
      const second = sorted[1];
      if (top !== undefined && second !== undefined && top.score - second.score >= PREFERRED_GAP) {
        preferred = top;
      }
    }

    const needsChoice = layers.length > 1 || preferred === null;

    return {
      elementId: request.element.elementId,
      layers,
      targets: sorted,
      preferred,
      needsChoice,
    };
  }

  /** 执行跳转：返回"滚动定位 + 高亮行"指令并登记历史，真正滚动由渲染层落地 */
  commit(target: NavTarget, options?: { highlightMs?: number }): JumpOutcome {
    const highlightMs = options?.highlightMs ?? 1500;
    const elementId = this.lastElementId ?? target.id;
    const success = target.filePath !== null && this.source.readFile(target.filePath) !== null;
    const message = success
      ? `已跳转到 ${target.filePath}:${target.startLine ?? '?'}（高亮 ${highlightMs}ms）`
      : `无法定位：${target.filePath ?? '无文件路径'}`;
    this.records.push({ at: this.clock(), elementId, targetId: target.id, success });
    const event = {
      type: (success ? 'jumped' : 'failed') as 'jumped' | 'failed',
      elementId,
      targetId: target.id,
    };
    for (const listener of this.listeners) listener(event);
    return { success, target, message };
  }

  /** 跳转历史（成功率统计用） */
  history(): readonly {
    at: number;
    elementId: string;
    targetId: string | null;
    success: boolean;
  }[] {
    return this.records;
  }

  /** 正跳成功率统计（≥95% 验收用） */
  stats(): { total: number; success: number; rate: number } {
    const total = this.records.length;
    const success = this.records.filter((record) => record.success).length;
    const rate = total === 0 ? 1 : success / total;
    return { total, success, rate };
  }

  /** 订阅跳转事件（jumped / failed），返回取消订阅函数 */
  subscribe(
    listener: (event: {
      type: 'jumped' | 'failed';
      elementId: string;
      targetId: string | null;
    }) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
