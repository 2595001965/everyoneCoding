import { ANCHOR_KINDS, type AnchorDeclaration, type AnchorKind } from '../anchors/anchor-model';
import {
  validateGenerationOutput,
  type GeneratedFile,
  type GenerationOutput,
} from './output-schema';

/**
 * 结构化输出解析（T4-04 要点 2 / FR-AI-05）。
 *
 * 四级解析，逐级降级（成功率目标 ≥95%：由 `__tests__/parser.test.ts` 的 20 组样本统计）：
 * 1. `json`：整段就是合法 JSON；
 * 2. `fenced-json`：被 ```json 围栏包裹，或前后夹了解释性文字（括号配平扫描取出第一个完整对象）；
 * 3. `code-blocks`：JSON 彻底不可用时，退化为**正则提取 Markdown 代码块**，
 *    按语言映射扩展名生成 `create` 文件；此时 `decision` 为空，结果页会显式提示"已降级"；
 * 4. `raw`：连代码块都没有 —— 原样返回文本，由 UI 提示用户手动处理，不抛错。
 *
 * 注意：解析器是**纯函数**（不发起重试）。重试与提示词反馈在 generator 里，
 * 这样解析行为可以单测穷举，重试策略也可以独立调整。
 */

export type ParseMode = 'json' | 'fenced-json' | 'code-blocks' | 'raw';

export const PARSE_MODE_LABELS: Record<ParseMode, string> = {
  json: '结构化 JSON',
  'fenced-json': '围栏 / 夹带文本中的 JSON',
  'code-blocks': '降级：Markdown 代码块提取',
  raw: '降级：原样文本（需人工处理）',
};

export interface ParseResult {
  /** 是否拿到可用的结构化结果（code-blocks 也算成功，但 degraded=true） */
  success: boolean;
  /** raw 模式下为 null */
  output: GenerationOutput | null;
  mode: ParseMode;
  /** 是否走了降级路径 */
  degraded: boolean;
  /** 原始文本（UI 兜底展示与重试反馈都用它） */
  raw: string;
  /** 失败原因 / 契约违规明细 */
  issues: string[];
}

/* ------------------------------ JSON 提取 ------------------------------ */

/**
 * 围栏抓取：**不限语言**。
 * 模型经常把 JSON 写成 ```javascript / ```jsonc，甚至把 JSON 塞进一个不带语言标记的
 * 围栏里；只要能解析出 JSON 就该救回来，所以这里不做语言过滤。
 */
const FENCE_PATTERN = /```[^\n`]*\n([\s\S]*?)```/g;

/** 取出所有围栏内容 */
export function extractFences(text: string): string[] {
  const results: string[] = [];
  FENCE_PATTERN.lastIndex = 0;
  let match = FENCE_PATTERN.exec(text);
  while (match !== null) {
    if (match[1] !== undefined) results.push(match[1]);
    match = FENCE_PATTERN.exec(text);
  }
  return results;
}

/**
 * 括号配平扫描：从第一个 `{` 开始，忽略字符串内的括号与转义，
 * 找到与之配对的 `}`。这样"模型在 JSON 前后写了客套话"也能救回来。
 */
export function sliceBalancedObject(text: string, from = 0): string | null {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** 依次尝试：原样 JSON → 剥掉围栏 → 配平扫描 */
export function extractJsonValue(text: string): { value: unknown; mode: ParseMode } | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const direct = tryParseJson(trimmed);
  if (direct.ok) return { value: direct.value, mode: 'json' };

  for (const fenced of extractFences(trimmed)) {
    const parsed = tryParseJson(fenced.trim());
    if (parsed.ok) return { value: parsed.value, mode: 'fenced-json' };
    const chopped = sliceBalancedObject(fenced);
    if (chopped !== null) {
      const inner = tryParseJson(chopped);
      if (inner.ok) return { value: inner.value, mode: 'fenced-json' };
    }
  }

  let cursor = 0;
  while (cursor < trimmed.length) {
    const slice = sliceBalancedObject(trimmed, cursor);
    if (slice === null) break;
    const parsed = tryParseJson(slice);
    if (parsed.ok) return { value: parsed.value, mode: 'fenced-json' };
    cursor = trimmed.indexOf(slice, cursor) + 1;
  }

  return null;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/* ------------------------------ 代码块降级 ------------------------------ */

const CODE_FENCE_PATTERN = /```([\w+#.-]*)\s*\n([\s\S]*?)```/g;

/** 语言标记 → 文件扩展名（降级路径生成的文件名要靠它） */
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  json: 'json',
  py: 'py',
  python: 'py',
  java: 'java',
  kt: 'kt',
  kotlin: 'kt',
  dart: 'dart',
  arkts: 'ets',
  ets: 'ets',
  tsql: 'sql',
  sql: 'sql',
  sh: 'sh',
  bash: 'sh',
  yaml: 'yaml',
  yml: 'yml',
  md: 'md',
  css: 'css',
  html: 'html',
  vue: 'vue',
  rs: 'rs',
};

/** 注释里可能带文件名提示：`// src/modules/auth/auth.controller.ts` */
const PATH_HINT_PATTERN = /(?:^|\/\/|#|--)\s*((?:[\w.@-]+\/)+[\w.@-]+\.[a-zA-Z]{1,5})/;

export interface ExtractedCodeBlock {
  language: string;
  code: string;
  /** 从围栏首行或注释提示里推断的文件名（可能为空） */
  pathHint: string | null;
}

/** 结构性语言标记：这些围栏是"契约载荷"，不是待写入的代码文件，降级提取时必须跳过 */
const STRUCTURAL_LANGUAGES = new Set(['json', 'jsonc', 'json5', 'text']);

export function extractCodeBlocks(text: string): ExtractedCodeBlock[] {
  const results: ExtractedCodeBlock[] = [];
  CODE_FENCE_PATTERN.lastIndex = 0;
  let match = CODE_FENCE_PATTERN.exec(text);
  while (match !== null) {
    const language = (match[1] ?? '').trim().toLowerCase();
    const code = match[2] ?? '';
    const hint = PATH_HINT_PATTERN.exec(code.split('\n').slice(0, 3).join('\n'));
    // 跳过 json 围栏：它是输出契约本身，写进项目只会产生垃圾文件
    if (!STRUCTURAL_LANGUAGES.has(language)) {
      results.push({
        language: language.length > 0 ? language : 'text',
        code,
        pathHint: hint?.[1] ?? null,
      });
    }
    match = CODE_FENCE_PATTERN.exec(text);
  }
  return results;
}

/** 降级：代码块 → files[]（action 一律 create，因为无从判断是补丁还是新建） */
export function outputFromCodeBlocks(blocks: readonly ExtractedCodeBlock[]): GenerationOutput {
  const used = new Set<string>();
  const files: GeneratedFile[] = blocks.map((block, index) => {
    const extension = LANGUAGE_EXTENSIONS[block.language] ?? 'txt';
    let path = block.pathHint ?? `generated/block-${index + 1}.${extension}`;
    let suffix = 2;
    while (used.has(path)) {
      path = path.replace(/(\.[^.]+)$/, `-${suffix}$1`);
      suffix += 1;
    }
    used.add(path);
    return { path, content: block.code, action: 'create', language: block.language };
  });

  // 代码里显式写了 anchor 注释时，仍然把锚点声明救回来（T4-06 的三重锚定依赖它）
  const anchors = extractAnchorComments(blocks);

  return {
    files,
    anchors,
    summary: `模型返回了 ${files.length} 个代码块但未给出结构化声明，已按代码块降级提取（请人工确认文件路径与操作类型）。`,
    notes: '',
    decision: { referencedMemory: [], rationale: '', risks: ['未获得决策说明（解析降级）'], uncovered: [] },
  };
}

/** 解析 `@everyonecoding:anchor <elementId>` 注释（与 T4-06 的注释标记同源） */
export function extractAnchorComments(blocks: readonly ExtractedCodeBlock[]): AnchorDeclaration[] {
  const declarations: AnchorDeclaration[] = [];
  const pattern = /@everyonecoding:anchor\s+([\w:.-]+)(?:\s+([\w.$#]+))?(?:\s+(controller|service|dto|repo|sql|test|route))?/;
  for (const block of blocks) {
    const extension = LANGUAGE_EXTENSIONS[block.language] ?? 'ts';
    for (const line of block.code.split('\n')) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const elementId = match[1];
      if (elementId === undefined) continue;
      const symbol = match[2] ?? elementId;
      const kind = normalizeKind(match[3]) ?? inferKindFromPath(block.pathHint);
      declarations.push({
        elementId,
        filePath: block.pathHint ?? `generated/${symbol}.${extension}`,
        symbol,
        kind,
      });
    }
  }
  return declarations;
}

function normalizeKind(value: string | undefined): AnchorKind | null {
  return value !== undefined && (ANCHOR_KINDS as readonly string[]).includes(value) ? (value as AnchorKind) : null;
}

function inferKindFromPath(pathHint: string | null): AnchorKind {
  if (pathHint === null) return 'service';
  if (/\.test\.|_test\.|spec\./.test(pathHint)) return 'test';
  if (/\.sql$/.test(pathHint)) return 'sql';
  if (/controller/i.test(pathHint)) return 'controller';
  if (/dto/i.test(pathHint)) return 'dto';
  if (/repo|dao|repository/i.test(pathHint)) return 'repo';
  if (/route/i.test(pathHint)) return 'route';
  return 'service';
}

/* ------------------------------ 主入口 ------------------------------ */

/**
 * 解析模型输出（单次，不重试）。
 *
 * 返回 `issues` 供重试时反馈给模型；返回 `raw` 供 UI 兜底展示。
 */
export function parseModelOutput(raw: string): ParseResult {
  const text = raw ?? '';
  if (text.trim().length === 0) {
    return { success: false, output: null, mode: 'raw', degraded: true, raw: text, issues: ['模型返回为空'] };
  }

  const extracted = extractJsonValue(text);
  if (extracted !== null) {
    const validated = validateGenerationOutput(extracted.value);
    if (validated.ok) {
      return {
        success: true,
        output: validated.value,
        mode: extracted.mode,
        degraded: false,
        raw: text,
        issues: [],
      };
    }
    // JSON 合法但不符合契约：也走降级，因为代码块往往还在
    const blocks = extractCodeBlocks(text);
    if (blocks.length > 0) {
      return {
        success: true,
        output: outputFromCodeBlocks(blocks),
        mode: 'code-blocks',
        degraded: true,
        raw: text,
        issues: validated.issues,
      };
    }
    return { success: false, output: null, mode: extracted.mode, degraded: true, raw: text, issues: validated.issues };
  }

  const blocks = extractCodeBlocks(text);
  if (blocks.length > 0) {
    return {
      success: true,
      output: outputFromCodeBlocks(blocks),
      mode: 'code-blocks',
      degraded: true,
      raw: text,
      issues: ['未找到合法 JSON，已按 Markdown 代码块降级提取'],
    };
  }

  return {
    success: false,
    output: null,
    mode: 'raw',
    degraded: true,
    raw: text,
    issues: ['既不是合法 JSON，也没有可提取的代码块，请人工处理'],
  };
}

/* ------------------------------ 指标 ------------------------------ */

export interface ParseStats {
  total: number;
  /** success=true 的数量（含降级） */
  success: number;
  /** 一次即拿到合法 JSON 的数量 */
  strictSuccess: number;
  /** 降级数量 */
  degraded: number;
  /** 成功率（0–1，保留 4 位） */
  rate: number;
  strictRate: number;
}

/** 解析成功率统计（验收要求 ≥95%，用 20 组样本统计） */
export function computeParseStats(results: readonly ParseResult[]): ParseStats {
  const total = results.length;
  const success = results.filter((result) => result.success).length;
  const strictSuccess = results.filter((result) => result.success && !result.degraded).length;
  const degraded = results.filter((result) => result.degraded).length;
  const ratio = (value: number): number => (total === 0 ? 0 : Number((value / total).toFixed(4)));
  return { total, success, strictSuccess, degraded, rate: ratio(success), strictRate: ratio(strictSuccess) };
}
