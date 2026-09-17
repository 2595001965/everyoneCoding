/**
 * 标识符分词与风格化（T7-01 要点 3，D-10）。
 *
 * 输入为"用户可见规范名"（可能是中文、英文、中英混排），输出为可直接落地的标识符。
 * 解析顺序（逐位置贪心最长匹配）：
 *   1. 项目自定义映射表（`dictionary`，最高优先级）
 *   2. 英文术语表（`mode === 'english'` 时启用，D-10 的"英文优先"）
 *   3. 内置拼音表
 *   4. Unicode 降级（`u4e2d`）或丢弃
 *
 * 示例：`toIdentifier('用户登录按钮', { style: 'pascal' })` → `'UserLoginButton'`
 *       （`english` 模式命中「用户 / 登录 / 按钮」三词，而非逐字拼音）。
 */

import { ENGLISH_TERMS } from './glossary';
import { isCjk, pinyinOf, unicodeFallback } from './pinyin';

/** 标识符大小写风格 */
export type IdentifierStyle = 'camel' | 'pascal' | 'kebab' | 'snake' | 'constant';

/** 中文解析模式：英文术语优先 / 强制拼音 / 保留原文 */
export type PinyinMode = 'english' | 'pinyin' | 'preserve';

export interface SegmentOptions {
  /** 中文解析模式，默认 `english` */
  mode?: PinyinMode;
  /** 项目自定义映射表（中文 → 英文或拼音），优先级最高 */
  dictionary?: Readonly<Record<string, string>>;
  /** 未收录中文的降级：`unicode` = u4e2d；`drop` = 丢弃。默认 `unicode` */
  unknown?: 'unicode' | 'drop';
}

export interface ToIdentifierOptions extends SegmentOptions {
  style?: IdentifierStyle;
  /** 结果为空时是否回退为"原文裁剪合法字符"，默认 false */
  preserveOriginal?: boolean;
  /** 结果为空且未开启 preserveOriginal 时的兜底值，默认 `el` */
  fallback?: string;
}

/** 视为分隔符的字符（不产出词） */
const SEPARATOR = /[\s\-_./:\\|,+，。、；;！!？?（）()【】[\]{}<>《》"'“”‘’·@#$%^&*+=~`]+/;
const LATIN_CHAR = /[A-Za-z0-9]/;

function capitalize(word: string): string {
  if (word.length === 0) return word;
  return word[0]!.toUpperCase() + word.slice(1);
}

/** 拆开驼峰拉丁串：`APIKey → ['API','Key']`、`userName → ['user','Name']` */
function splitCamelRun(run: string): string[] {
  return run.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
}

/** 合并"自定义映射 + 英文术语"为一张可做最长匹配的词表 */
function buildTermIndex(options: SegmentOptions): readonly string[] {
  const terms = new Set<string>();
  for (const term of Object.keys(ENGLISH_TERMS)) terms.add(term);
  for (const term of Object.keys(options.dictionary ?? {})) terms.add(term);
  return [...terms].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/**
 * 把规范名切分为词序列。
 *
 * - 拉丁串按驼峰再切分，保持原形（大小写由后续风格化决定）；
 * - 中文按最长匹配命中词表，未收录字按拼音 / Unicode 降级；
 * - `mode === 'preserve'` 时整段中文原样保留为一个词（仅用于"保留原文"策略）。
 */
export function segmentWords(input: string, options: SegmentOptions = {}): string[] {
  const mode = options.mode ?? 'english';
  const unknown = options.unknown ?? 'unicode';
  const dictionary = options.dictionary ?? {};
  /**
   * 词表来源：
   * - `english` 模式：内置英文术语表 + 项目自定义映射（自定义优先）；
   * - `pinyin` 模式：**只用项目自定义映射**（若把英文术语表也带进来，就成了"拼音模式也输出英文"，
   *   与 D-10 的"可切换为拼音"相矛盾）；未命中映射的字走逐字拼音。
   */
  const terms = mode === 'english' ? buildTermIndex(options) : buildCustomTermIndex(dictionary);
  const allowGlossary = mode === 'english';
  const words: string[] = [];
  let latin = '';

  const flushLatin = (): void => {
    if (latin.length === 0) return;
    words.push(...splitCamelRun(latin));
    latin = '';
  };

  const chars = [...input];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index]!;
    if (LATIN_CHAR.test(char)) {
      latin += char;
      index += 1;
      continue;
    }
    flushLatin();
    if (SEPARATOR.test(char)) {
      index += 1;
      continue;
    }
    if (!isCjk(char)) {
      // 表情、全角标点等非命名字符：直接丢弃
      index += 1;
      continue;
    }
    if (mode === 'preserve') {
      let run = '';
      while (index < chars.length && isCjk(chars[index]!)) {
        run += chars[index]!;
        index += 1;
      }
      words.push(run);
      continue;
    }
    const matched = matchAt(chars, index, terms, dictionary, allowGlossary);
    if (matched !== null) {
      words.push(matched.word);
      index += matched.length;
      continue;
    }
    const pinyin = pinyinOf(char, dictionary);
    if (pinyin !== null) {
      words.push(pinyin);
      index += 1;
      continue;
    }
    if (unknown === 'unicode') words.push(unicodeFallback(char));
    index += 1;
  }
  flushLatin();
  return words;
}

/** 项目自定义映射的键，按长度倒序（最长匹配优先） */
function buildCustomTermIndex(dictionary: Readonly<Record<string, string>>): readonly string[] {
  return Object.keys(dictionary).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/** 在 `index` 处做贪心最长匹配；命中自定义映射优先于英文术语 */
function matchAt(
  chars: readonly string[],
  index: number,
  terms: readonly string[],
  dictionary: Readonly<Record<string, string>>,
  allowGlossary: boolean,
): { word: string; length: number } | null {
  for (const term of terms) {
    const length = term.length;
    if (length === 0 || index + length > chars.length) continue;
    if (chars.slice(index, index + length).join('') !== term) continue;
    const custom = dictionary[term];
    if (custom !== undefined && custom.length > 0) return { word: custom, length };
    const glossary = ENGLISH_TERMS[term];
    if (allowGlossary && glossary !== undefined && glossary.length > 0) return { word: glossary, length };
  }
  return null;
}

/** 按风格拼接词序列 */
export function applyStyle(words: readonly string[], style: IdentifierStyle): string {
  const lowered = words.map((word) => word.toLowerCase());
  switch (style) {
    case 'pascal':
      return lowered.map(capitalize).join('');
    case 'kebab':
      return lowered.join('-');
    case 'snake':
      return lowered.join('_');
    case 'constant':
      return lowered.join('_').toUpperCase();
    default:
      return lowered.map((word, index) => (index === 0 ? word : capitalize(word))).join('');
  }
}

/**
 * 生成标识符。
 *
 * @example
 * toIdentifier('用户登录按钮', { style: 'pascal' })               // 'UserLoginButton'
 * toIdentifier('用户登录按钮', { style: 'camel' })                // 'userLoginButton'
 * toIdentifier('用户登录按钮', { mode: 'pinyin', style: 'pascal' }) // 'YongHuDengLuAnNiu'
 */
export function toIdentifier(input: string, options: ToIdentifierOptions = {}): string {
  const style = options.style ?? 'camel';
  const fallback = options.fallback ?? 'el';
  const words = segmentWords(input, options);
  let result = applyStyle(words, style);
  if (result.length === 0) {
    result = options.preserveOriginal === true ? (sanitizeIdentifier(input) || fallback) : fallback;
  }
  // 标识符不得以数字开头
  if (/^[0-9]/.test(result)) result = `_${result}`;
  return result;
}

/** 裁剪为合法标识符字符集（保留中英文、数字、`_`、`-`）；不改变大小写 */
export function sanitizeIdentifier(input: string): string {
  return input.replace(/[^0-9A-Za-z_\-\u4e00-\u9fff\u3400-\u4dbf]/g, '');
}

/** 在已有集合内生成不冲突的标识符（追加 `_2` / `_3` …） */
export function uniqueIdentifier(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}
