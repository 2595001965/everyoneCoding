/**
 * AST 解析器调度（T7-02 要点 1）。
 *
 * 按扩展名选择解析器：TS/JS/TSX/JSX 用 TypeScript 编译器 API（真 AST），
 * Python / Java 用内置作用域感知解析器；若外壳注入了外部解析器端口
 * （libcst / JavaParser），**优先**使用端口并在结果中反映其是否可用。
 *
 * 禁止纯文本替换是硬约束（FR-UNI-06），本目录下所有解析器都只产出
 * 「AST 位置 + 符号 + 语法角色」，真正的文本编辑由 `executors/code-ast` 基于这些位置执行。
 */

import { createJavaParser } from './java-parser';
import { createPythonParser } from './python-parser';
import { createTsParser } from './ts-parser';
import type {
  AstParseInput,
  AstParseResult,
  ExternalAstParserPort,
  SourceLanguage,
} from '../types';

export { createTsParser } from './ts-parser';
export { createPythonParser } from './python-parser';
export { createJavaParser } from './java-parser';

/** 扩展名 → 语言 */
const EXTENSION_LANGUAGE: Readonly<Record<string, SourceLanguage>> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.py': 'python',
  '.pyi': 'python',
  '.java': 'java',
};

/** 按路径推断语言；不支持返回 null（调用方跳过并计入统计） */
export function detectLanguage(path: string): SourceLanguage | null {
  const normalized = path.toLowerCase();
  const index = normalized.lastIndexOf('.');
  if (index < 0) return null;
  return EXTENSION_LANGUAGE[normalized.slice(index)] ?? null;
}

/** 是否属于代码文件 */
export function isCodeFile(path: string): boolean {
  return detectLanguage(path) !== null;
}

export interface AstDispatcherOptions {
  /** 外部解析器端口（可选增强） */
  ports?: readonly ExternalAstParserPort[] | undefined;
}

export interface AstDispatcher {
  /** 解析单个文件；语言不支持时返回 null */
  parse(path: string, input: Omit<AstParseInput, 'path'>): AstParseResult | null;
}

/**
 * 构造解析器调度器。
 *
 * 端口优先顺序：与语言匹配的外部端口 > 内置解析器。
 * 内置解析器（TS 之外）会把降级信息放在 `degradation` 中，上层据此提示用户。
 */
export function createAstDispatcher(options: AstDispatcherOptions = {}): AstDispatcher {
  const ports = options.ports ?? [];
  const ts = createTsParser('ts');
  const tsx = createTsParser('tsx');
  const python = createPythonParser(ports.find((port) => port.language === 'python'));
  const java = createJavaParser(ports.find((port) => port.language === 'java'));

  return {
    parse(path, input) {
      const language = detectLanguage(path);
      if (language === null) return null;
      const full: AstParseInput = { ...input, path };
      switch (language) {
        case 'tsx':
        case 'jsx':
          return tsx.parse(full);
        case 'python':
          return python.parse(full);
        case 'java':
          return java.parse(full);
        default:
          return ts.parse(full);
      }
    },
  };
}
