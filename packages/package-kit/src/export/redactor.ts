/**
 * 导出脱敏（T8-02 / FR-PKG-07）。
 *
 * 复用 `@ec/core` 的 `BUILT_IN_RULES` 与 `mask`：密钥、Bearer/JWT、连接串、
 * 私钥块、邮箱、手机号、敏感字段值统一打码。导出链路对全部文本类条目逐条脱敏；
 * 导出完成后用 reader 遍历包内文本条目再跑一遍 `scanForSecrets` 做自检。
 *
 * 硬约束：**preview 绝不出现明文**——自检/报告里的预览统一用全 `***` 掩码。
 */

import { BUILT_IN_RULES, type RedactionRule } from '@ec/core';

import type { RedactionFinding } from './export-types';

/** 视为"文本、需要逐条脱敏"的扩展名（二进制条目跳过） */
const TEXT_EXTENSIONS: readonly string[] = [
  '.json',
  '.jsonl',
  '.md',
  '.markdown',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.txt',
  '.text',
  '.yaml',
  '.yml',
  '.env',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.csv',
  '.log',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.rs',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.sql',
  '.xml',
  '.svg',
  '.vue',
  '.svelte',
];

const MASK = '***';

/** 判断包内路径是否为可脱敏的文本条目 */
export function isTextEntry(pkgPath: string): boolean {
  const lower = pkgPath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return false; // 无扩展名：保守按二进制处理，避免把二进制当文本
  const ext = lower.slice(dot);
  return TEXT_EXTENSIONS.includes(ext);
}

function resolveRules(ruleIds?: readonly string[] | undefined): readonly RedactionRule[] {
  if (ruleIds === undefined) return BUILT_IN_RULES;
  return BUILT_IN_RULES.filter((rule) => ruleIds.includes(rule.id));
}

/**
 * 用给定规则集对文本脱敏（复用 @ec/core 的 BUILT_IN_RULES 模式）。
 *
 * 导出侧采用"整段命中即全量打码"：把每个命中的密钥片段整体替换为 `***`，
 * 既不残留明文、也不会留下可被二次扫描再次命中的结构（保证自检零命中）。
 */
function applyRules(text: string, rules: readonly RedactionRule[]): string {
  let output = text;
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    output = output.replace(rule.pattern, MASK);
  }
  return output;
}

/** 生成"绝不含明文"的预览：把命中的密钥片段整体替换为 *** */
function maskedPreview(line: string, rules: readonly RedactionRule[]): string {
  let output = line;
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    output = output.replace(rule.pattern, MASK);
  }
  return output;
}

/**
 * 扫描文本中的密钥命中（按行）。
 * 每条命中记录 ruleId / 行号 / 打码后的 preview。
 * `path` 可选：供包内自检回填（单独调用留空亦可）。
 */
export function scanForSecrets(
  text: string,
  path = '',
  ruleIds?: readonly string[] | undefined,
): RedactionFinding[] {
  const rules = resolveRules(ruleIds);
  const findings: RedactionFinding[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(line)) {
        findings.push({
          path,
          ruleId: rule.id,
          line: i + 1,
          preview: maskedPreview(line, rules),
        });
        break; // 一行只记首个命中规则，避免噪声
      }
    }
  }
  return findings;
}

export interface RedactResult {
  text: string;
  findings: RedactionFinding[];
}

/**
 * 对单条文本条目脱敏（导出写入前调用）。
 * 返回脱敏后的文本与命中清单（path 已回填）。
 * `ruleIds` 缺省使用全部 BUILT_IN_RULES。
 */
export function redactTextIfNeeded(
  path: string,
  text: string,
  ruleIds?: readonly string[] | undefined,
): RedactResult {
  const rules = resolveRules(ruleIds);
  const findings = scanForSecrets(text, path, ruleIds);
  const redactedText = applyRules(text, rules);
  return { text: redactedText, findings };
}
