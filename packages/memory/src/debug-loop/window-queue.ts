/**
 * 滚动时间窗事件队列（Debug 循环检测的领域层基础设施）。
 *
 * 只负责"按时间窗暂存 + 过期清理"，不含任何检测逻辑，也不依赖系统时钟——
 * 所有时间都由调用方通过参数注入（push 时记 at，查询时传 now），便于测试。
 */

/** Debug 事件类型：生成 / 运行 / 报错 / 用户否定反馈 */
export type DebugEventType = 'generate' | 'run' | 'error' | 'negative-feedback';

/** 单条调试事件 */
export interface DebugEvent {
  /** 事件类型 */
  type: DebugEventType;
  /** 发生时间（注入，单位毫秒，单调即可） */
  at: number;
  /** 稳定归属键（由 targetKeyOf 生成） */
  targetKey: string;
  /** 页面 id（pageId|elementId|featureId 组成的稳定键的一部分） */
  pageId?: string | null;
  /** 元素 id */
  elementId?: string | null;
  /** 功能 id */
  featureId?: string | null;
  /** 错误指纹（由 normalizeErrorSignature 生成，error 事件才有意义） */
  errorSignature?: string | null;
  /** 原始错误文本（用于草稿"现象"汇总） */
  rawError?: string | null;
  /** 来源对话 id（用于草稿关联） */
  conversationId?: string | null;
  /** 本次尝试的摘要（用于草稿"已尝试方案"） */
  attemptSummary?: string | null;
}

/**
 * 由 pageId/elementId/featureId 计算稳定、可读的归属键。
 *
 * 形如 `page:PG1|element:E1|feature:F1`，缺省项统一用 `-`。
 * 三段固定顺序输出，保证"同一组归属 → 同一键"，且与字段传入顺序无关。
 */
export function targetKeyOf(target: {
  pageId?: string | null;
  elementId?: string | null;
  featureId?: string | null;
}): string {
  const page = target.pageId ? `page:${target.pageId}` : 'page:-';
  const element = target.elementId ? `element:${target.elementId}` : 'element:-';
  const feature = target.featureId ? `feature:${target.featureId}` : 'feature:-';
  return `${page}|${element}|${feature}`;
}

/**
 * 由归属字段生成可读的中文描述（用于提示文案与问题记忆标题，不含 targetKey 本身）。
 *
 * 例如 `页面PG1 / 元素E1`；三段中任意缺失则跳过，全缺返回 `未知目标`。
 */
export function readableTarget(target: {
  pageId?: string | null;
  elementId?: string | null;
  featureId?: string | null;
}): string {
  const parts: string[] = [];
  if (target.featureId) parts.push(`功能${target.featureId}`);
  if (target.pageId) parts.push(`页面${target.pageId}`);
  if (target.elementId) parts.push(`元素${target.elementId}`);
  return parts.length > 0 ? parts.join(' / ') : '未知目标';
}

/**
 * 错误信息归一化指纹。
 *
 * 目标：把"同一类错误在不同位置/时刻的表现"收敛成同一个指纹，
 * 便于检测"同一错误连续出现"。归一化步骤如下：
 * 1. 整体转小写，压缩多余空白为单个空格；
 * 2. 抹掉十六进制地址（如 `0x1a2b`）→ `<hex>`；
 * 3. 抹掉文件路径（绝对 `/a/b.ts`、Windows `C:\x\y.ts`、相对 `./x`）→ `<path>`；
 * 4. 抹掉行号/列号（`:12:5`、`:99`）→ `:<loc>`；
 * 5. 抹掉常见时间戳（ISO 日期、HH:MM:SS、10~13 位毫秒/秒级数字）→ 删除；
 * 6. 抹掉引号内的变量值（保留引号结构），如 `'x'` → `''`；
 * 7. 再次压缩空白并去首尾空格。
 *
 * 注意：错误类型名与正文语义（如 `Cannot read properties of undefined`）会被保留，
 * 因此"不同类型错误"会得到"不同指纹"，而"仅路径/行号/时间不同"的同类错误得到"同一指纹"。
 */
export function normalizeErrorSignature(raw: string): string {
  if (!raw) return '';
  let s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  // 十六进制地址
  s = s.replace(/0x[0-9a-f]+/g, '<hex>');
  // 时间戳必须**先于**「行号:列号」处理：否则 `t10:22:33z` 会先被 `:\d+` 命中，
  // 残留 `t10:<loc>z`，导致同一时刻不同秒数的两条错误被判成不同类。
  //  - 完整/部分 ISO 日期（含可选 T 与时分秒、毫秒、Z）
  s = s.replace(/\d{4}-\d{2}-\d{2}(?:[t ]\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?z?)?/g, ' ');
  //  - 只带时刻的形式（可带前导 t 与后缀 z）；两段式 `12:30` 不算时间戳，保留
  s = s.replace(/t?\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?z?/g, ' ');
  // 文件路径（绝对/相对/Windows 盘符），保留路径位置感但抹掉具体内容
  s = s.replace(/(?:[a-z]:)?[/\\][^\s:()]+/g, '<path>');
  // 行号:列号（可能出现在路径之后，也可能单独出现）
  s = s.replace(/:\d+(?::\d+)?/g, ':<loc>');
  // 10~13 位时间戳（毫秒/秒级），避免误伤普通短数字
  s = s.replace(/\b\d{10,13}\b/g, ' ');
  // 引号内的变量值（单/双/反引号）
  s = s
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``');
  // 收尾
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** WindowQueue 构造选项 */
export interface WindowQueueOptions {
  /** 时间窗长度（毫秒），默认 10 分钟 */
  windowMs?: number;
  /** 队列容量上限，超出丢弃最旧，默认 500 */
  maxEvents?: number;
}

/**
 * 滚动时间窗事件队列。
 *
 * - `push` 追加事件并按容量裁剪（超出丢最旧）；
 * - `within(now)` 返回窗口内事件（按时间升序），并顺带清理过期项；
 * - `size(now)` 返回窗口内事件数；
 * - `clear()` 清空全部。
 *
 * 所有时间由参数注入，不读取系统时钟。
 */
export class WindowQueue {
  private readonly windowMs: number;
  private readonly maxEvents: number;
  private events: DebugEvent[] = [];

  constructor(options: WindowQueueOptions = {}) {
    this.windowMs = options.windowMs ?? 10 * 60 * 1000;
    this.maxEvents = options.maxEvents ?? 500;
  }

  /** 追加一条事件；超出容量时丢弃最旧 */
  push(event: DebugEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  /** 返回窗口内事件（按时间升序），并顺带清理过期项。纯查询语义，不依赖系统时钟。 */
  within(now: number): DebugEvent[] {
    this.pruneExpired(now);
    // 返回升序副本，避免外部修改内部状态
    return [...this.events].sort((a, b) => a.at - b.at);
  }

  /** 窗口内事件数量（会顺带清理过期项） */
  size(now: number): number {
    this.pruneExpired(now);
    return this.events.length;
  }

  /** 清空全部事件 */
  clear(): void {
    this.events = [];
  }

  /** 移除 at 早于 now - windowMs 的过期项（从队首连续删除，事件已按 push 顺序 ≈ 时间顺序） */
  private pruneExpired(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.events.length && this.events[i]!.at < cutoff) {
      i++;
    }
    if (i > 0) this.events.splice(0, i);
  }
}
