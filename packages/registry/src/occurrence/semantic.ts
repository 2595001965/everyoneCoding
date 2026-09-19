/**
 * 语义相似度（文档 / 记忆正文的"提及"匹配置信度，T7-02 要点 2/3）。
 *
 * 代码侧是 AST 精确命中（confidence 1.0），而文档与记忆正文里的提及天然是
 * **自然语言**：可能写成「用户登录按钮」「登录按钮」「登录提交按钮」。因此需要一个
 * 可解释、可测试的相似度（不引第三方 NLP 库）：
 *
 * - 中文按 **二元字组（bigram）** 切分（无需分词器，对短名词稳定）；
 * - 英文/数字按整词切分；
 * - 取 **Jaccard 系数** 作为基础分，并按"包含关系"加权（完全包含视为强命中）。
 *
 * 置信度口径（与 `risk-classifier` 的 `SEMANTIC_AUTO_THRESHOLD = 0.8` 对齐）：
 * 恰好整串包含 → 0.9~0.95；包含但不完全相等 → 0.8；部分重叠 → 0.5~0.79。
 */

/** 文本 → 特征集合 */
export function shingles(text: string): Set<string> {
  const set = new Set<string>();
  const normalized = text.toLowerCase();
  // 英文 / 数字整词
  for (const word of normalized.match(/[a-z0-9_]+/g) ?? []) {
    if (word.length >= 2) set.add(`w:${word}`);
  }
  // 中文二元字组
  const cjk = normalized.replace(/[^\u4e00-\u9fff]/g, '');
  if (cjk.length === 1) set.add(`c:${cjk}`);
  for (let i = 0; i + 1 < cjk.length; i += 1) set.add(`c:${cjk.slice(i, i + 2)}`);
  return set;
}

/** Jaccard 系数 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 提及置信度。
 *
 * - 正文包含候选名整串 → `0.95`（规范名 / 投影精确文本）
 * - 正文包含候选名的"核心词"（去掉尾部通用名词后仍完整包含）→ `0.8`
 * - 否则按 Jaccard 折算到 `0.4~0.79`
 */
export function mentionConfidence(haystack: string, needle: string): number {
  const text = haystack.toLowerCase();
  const term = needle.toLowerCase();
  if (term.length === 0) return 0;
  if (text.includes(term)) return 0.95;
  const core = coreTerm(term);
  if (core.length >= 2 && text.includes(core)) return 0.8;
  const score = jaccard(shingles(text), shingles(term));
  return Math.min(0.79, Math.max(0.4, Number((0.4 + score * 0.39).toFixed(2))));
}

/** 去掉尾部通用名词，得到"核心词"（如 `用户登录按钮` → `用户登录`） */
const GENERIC_SUFFIXES = [
  '按钮',
  '输入框',
  '页面',
  '组件',
  '容器',
  '卡片',
  '弹窗',
  '列表',
  '表单项',
  '控件',
];

export function coreTerm(term: string): string {
  for (const suffix of GENERIC_SUFFIXES) {
    if (term.endsWith(suffix) && term.length > suffix.length) return term.slice(0, -suffix.length);
  }
  return term;
}

/** 是否达到"自动改"阈值（FR-UNI-08：≥0.8 自动改，<0.8 列为候选） */
export function isHighConfidence(confidence: number, threshold = 0.8): boolean {
  return confidence >= threshold;
}
