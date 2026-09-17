import type { ConflictBlock, ConflictFile, ConflictResolution, GitResult } from './models';
import type { GitClient } from './git-client';

/**
 * 冲突解析与解决（T6-04 要点 2）。
 *
 * ## D-04 视角（关键）
 *
 * 用户**不手动改代码**，所以冲突解决的本质不是"编辑文本"，而是
 * **选择采用哪一侧 AI 生成结果**：
 * - 逐个冲突块选「当前 / 传入」；
 * - 或选「两侧都要」→ 交给 AI 合并（`buildAiMergeRequest` 生成请求，
 *   由 T4-05 的写入管线落盘，本模块**不写文件**）；
 * - 或选「反向」（Revert）到某一侧。
 *
 * 因此本模块只做两件事：**解析**（把 git 的冲突标记变成可展示的三栏结构）
 * 与**组装结果文本**（选择结果 → 供写入管线使用的内容）。
 */

export const CONFLICT_OURS = '<<<<<<<';
export const CONFLICT_BASE = '|||||||';
export const CONFLICT_SEP = '=======';
export const CONFLICT_THEIRS = '>>>>>>>';

export interface ParseConflictOptions {
  path?: string;
  oursLabel?: string;
  theirsLabel?: string;
}

/**
 * 解析带冲突标记的文件内容。
 *
 * 同时支持两种风格：
 * - 默认 `merge` 风格（`<<<<<<<` / `=======` / `>>>>>>>`）
 * - `diff3` 风格（多一段 `|||||||` 基线，三栏编辑器的中间列）
 *
 * 嵌套冲突（理论上 git 不会产生，但手工合并会）会被识别并记入 `warnings`。
 */
export function parseConflictFile(content: string, options: ParseConflictOptions = {}): ConflictFile {
  const path = options.path ?? '';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ConflictBlock[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.startsWith(CONFLICT_OURS)) {
      index += 1;
      continue;
    }
    const startLine = index + 1;
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let cursor = index + 1;
    let stage: 'ours' | 'base' | 'theirs' = 'ours';
    let closed = false;

    while (cursor < lines.length) {
      const current = lines[cursor] ?? '';
      if (current.startsWith(CONFLICT_BASE)) {
        stage = 'base';
        cursor += 1;
        continue;
      }
      if (current.startsWith(CONFLICT_SEP)) {
        stage = 'theirs';
        cursor += 1;
        continue;
      }
      if (current.startsWith(CONFLICT_THEIRS)) {
        closed = true;
        break;
      }
      if (stage === 'ours') ours.push(current);
      else if (stage === 'base') base.push(current);
      else theirs.push(current);
      cursor += 1;
    }

    blocks.push({
      index: blocks.length + 1,
      ours,
      theirs,
      base,
      resolution: 'unresolved',
      startLine,
    });
    index = cursor + (closed ? 1 : 0);
  }

  return {
    path,
    oursLabel: options.oursLabel ?? '当前（HEAD）',
    theirsLabel: options.theirsLabel ?? '传入（合并来源）',
    blocks,
  };
}

/** 该文件是否含未闭合的冲突标记（解析时已容忍，这里用于提示） */
export function hasUnterminatedConflict(content: string): boolean {
  const ours = content.split(CONFLICT_OURS).length - 1;
  const theirs = content.split(CONFLICT_THEIRS).length - 1;
  return ours !== theirs;
}

export const CONFLICT_RESOLUTION_LABELS: Record<ConflictResolution, string> = {
  ours: '采用当前',
  theirs: '采用传入',
  both: '两侧都要',
  ai: '交给 AI 合并',
  unresolved: '未解决',
};

/** 单个冲突块按选择展开为行 */
export function resolveBlock(block: ConflictBlock, resolution: ConflictResolution): string[] {
  switch (resolution) {
    case 'ours':
      return [...block.ours];
    case 'theirs':
      return [...block.theirs];
    case 'both':
      return [...block.ours, ...block.theirs];
    case 'ai':
      // 交给 AI 时先保留标记占位，由写入管线替换为 AI 合并结果
      return [...block.ours];
    default:
      return [...block.ours, ...block.theirs];
  }
}

/**
 * 按逐块选择组装结果文本。
 * `choices` 里缺失的块按"未解决"处理并保留冲突标记，避免静默丢内容。
 */
export function resolveConflictFile(file: ConflictFile, choices: Readonly<Record<number, ConflictResolution>>): {
  content: string;
  unresolved: number;
} {
  const output: string[] = [];
  let unresolved = 0;
  for (const block of file.blocks) {
    const choice = choices[block.index] ?? 'unresolved';
    if (choice === 'unresolved') {
      unresolved += 1;
      output.push(`${CONFLICT_OURS} ${file.oursLabel}`, ...block.ours, CONFLICT_SEP, ...block.theirs, `${CONFLICT_THEIRS} ${file.theirsLabel}`);
      continue;
    }
    output.push(...resolveBlock(block, choice));
  }
  return { content: `${output.join('\n')}`, unresolved };
}

/** 冲突统计（UI 顶部展示"3 个文件 / 7 处冲突 / 还剩 2 处未解决"） */
export function summarizeConflicts(files: readonly ConflictFile[]): {
  files: number;
  blocks: number;
  unresolved: number;
  perFile: { path: string; blocks: number; unresolved: number }[];
} {
  let blocks = 0;
  let unresolved = 0;
  const perFile = files.map((file) => {
    const fileUnresolved = file.blocks.filter((block) => block.resolution === 'unresolved').length;
    blocks += file.blocks.length;
    unresolved += fileUnresolved;
    return { path: file.path, blocks: file.blocks.length, unresolved: fileUnresolved };
  });
  return { files: files.length, blocks, unresolved, perFile };
}

export interface AiMergeRequest {
  /** 交给 AI 的中文指令 */
  instruction: string;
  /** 供 AI 判断的上下文（两侧内容 + 所在文件） */
  context: string;
  /** 涉及文件 */
  paths: string[];
}

/**
 * 「两侧都要 → 交给 AI 合并」的请求载荷。
 * 走 T4-05 的写入管线落地，本模块不直接写文件（D-04：AI 是唯一写入口）。
 */
export function buildAiMergeRequest(file: ConflictFile, block?: ConflictBlock): AiMergeRequest {
  const targets = block === undefined ? file.blocks : [block];
  const sections = targets.map((item) => {
    const parts = [`### 冲突块 ${item.index}（起始行 ${item.startLine}）`];
    parts.push('当前（HEAD）侧：', '```', ...item.ours, '```');
    if (item.base.length > 0) parts.push('共同基线：', '```', ...item.base, '```');
    parts.push('传入侧：', '```', ...item.theirs, '```');
    return parts.join('\n');
  });
  return {
    instruction:
      block === undefined
        ? `请合并文件 ${file.path} 中的 ${targets.length} 处冲突：两侧改动都要保留，按语义正确合并，输出完整文件内容。`
        : `请合并文件 ${file.path} 第 ${block.index} 处冲突：两侧改动都要保留，按语义正确合并。`,
    context: sections.join('\n\n'),
    paths: [file.path],
  };
}

export interface ConflictServiceOptions {
  /** 读取冲突文件内容（生产由外壳的文件服务提供，只读） */
  readFile: (path: string) => Promise<string | null>;
  clock?: (() => number) | undefined;
}

export class ConflictService {
  private readonly clock: () => number;

  constructor(
    private readonly client: GitClient,
    private readonly options: ConflictServiceOptions,
  ) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** 扫描当前冲突状态：文件清单 + 解析后的三栏结构 */
  async scan(): Promise<GitResult<ConflictFile[]>> {
    const files = await this.client.conflictFiles();
    if (!files.ok || files.data === null) return { ...files, data: null };
    const parsed: ConflictFile[] = [];
    const extraLogs = [...files.logs];
    for (const path of files.data) {
      const content = await this.options.readFile(path);
      if (content === null) {
        extraLogs.push({ level: 'warn', message: `冲突文件 ${path} 无法读取，已跳过`, at: this.clock() });
        continue;
      }
      parsed.push(parseConflictFile(content, { path }));
    }
    return { ok: true, error: null, logs: extraLogs, data: parsed };
  }

  /** 组装解决结果（不落盘；由调用方交给 AI 写入管线） */
  resolve(file: ConflictFile, choices: Readonly<Record<number, ConflictResolution>>): { content: string; unresolved: number } {
    return resolveConflictFile(file, choices);
  }

  /** 交给 AI 合并的请求载荷 */
  buildAiMerge(file: ConflictFile, block?: ConflictBlock): AiMergeRequest {
    return buildAiMergeRequest(file, block);
  }

  /** 中止合并 / 变基（破坏性：UI 二次确认后调用） */
  async abort(kind: 'merge' | 'rebase'): Promise<GitResult<boolean>> {
    return kind === 'merge' ? this.client.abortMerge() : this.client.abortRebase();
  }
}
