/**
 * Python 出现位置解析器（FR-UNI-06 降级口径：内置缩进作用域解析器）。
 *
 * 本机无 libcst / Python 解释器，故实现**内置**词法器 + 缩进作用域解析：
 * - 正确跳过 `#` 注释、三引号串、f/r/b/u 前缀串、`\` 行继续、括号内隐式续行、转义；
 * - 按缩进维护作用域栈（module → class / function），收集 import / def / class / 赋值 /
 *   参数 / for-as / with-as 绑定；
 * - 标识符引用由内向外解析，命中内层同名局部绑定则排除；成员访问（`.attr`）一律排除。
 *
 * 若注入 `ExternalAstParserPort` 且返回非 null，则优先使用端口结果（`degradation` 为 null）。
 * 否则使用内置解析器，并在 `degradation` 中如实上报降级。
 */

import type {
  AstParser,
  AstParseInput,
  AstParseResult,
  ExternalAstParserPort,
  HitRole,
  ParserDegradation,
  RawHit,
  SourceLanguage,
} from '../types';
import { IDENTIFIER_PROJECTIONS, STRING_PROJECTIONS } from '../types';
import type { ProjectionKind } from '../../naming/presets';
import { extractContext, splitLines } from '../text-utils';

interface Frame {
  level: number;
  bindings: Map<string, { target: boolean }>;
}

interface Token {
  type: 'name' | 'string' | 'op' | 'nl' | 'number';
  value: string;
  line: number;
  col: number;
  /** 字符串内容起始列（跳过前缀与引号） */
  contentCol?: number;
  /** 逻辑行缩进（仅 nl 令牌） */
  indent?: number;
}

const ASSIGN_OPS = new Set([
  '=',
  ':=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<=',
  '>>=',
  '**=',
  '//=',
]);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}
function isIdentChar(c: string): boolean {
  return /[0-9A-Za-z_$]/.test(c);
}

function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  const n = content.length;
  let i = 0;
  let line = 1;
  let col = 1;
  let depth = 0; // 括号深度（控制隐式续行）
  let afterBackslash = false;

  const advance = (count: number): void => {
    for (let k = 0; k < count; k += 1) {
      if (content[i] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };

  while (i < n) {
    const c = content[i]!;

    if (c === '\n') {
      if (depth === 0 && !afterBackslash) {
        // 计算下一行缩进
        let j = i + 1;
        let indent = 0;
        while (j < n && (content[j] === ' ' || content[j] === '\t')) {
          indent += 1;
          j += 1;
        }
        tokens.push({ type: 'nl', value: '\n', line, col, indent });
      }
      afterBackslash = false;
      advance(1);
      continue;
    }
    if (c === '\r') {
      advance(1);
      continue;
    }
    if (c === ' ' || c === '\t') {
      advance(1);
      continue;
    }
    if (afterBackslash) {
      // 行继续后的第一个非空白字符前不应有逻辑断行；直接继续
      afterBackslash = false;
    }
    if (c === '\\') {
      afterBackslash = true;
      advance(1);
      continue;
    }
    // 注释
    if (c === '#') {
      let j = i;
      while (j < n && content[j] !== '\n') j += 1;
      advance(j - i);
      continue;
    }
    // 字符串
    if (c === "'" || c === '"') {
      const quoteLine = line;
      const quoteCol = col;
      const quote = c;
      let isTriple = false;
      if (content[i + 1] === quote && content[i + 2] === quote) isTriple = true;
      const delimLen = isTriple ? 3 : 1;
      advance(delimLen); // 跳过完整定界符
      const contentStartCol = col; // 已跳过定界符，指向内容首字符
      const startIdx = i;
      let closed = false;
      while (i < n) {
        const ch = content[i]!;
        if (!isTriple && ch === '\\') {
          advance(1);
          if (i < n) advance(1);
          continue;
        }
        if (ch === quote) {
          if (isTriple) {
            if (content[i + 1] === quote && content[i + 2] === quote) {
              advance(3);
              closed = true;
              break;
            }
          } else {
            advance(1);
            closed = true;
            break;
          }
        }
        if (ch === '\n') {
          if (isTriple) {
            advance(1);
            continue;
          }
          // 未闭合的单行串：按行尾结束
          break;
        }
        advance(1);
      }
      const rawValue = content.slice(startIdx, closed ? i - (isTriple ? 3 : 1) : i);
      tokens.push({
        type: 'string',
        value: rawValue,
        line: quoteLine,
        col: quoteCol,
        contentCol: contentStartCol,
      });
      continue;
    }
    // 数字
    if (/[0-9]/.test(c)) {
      const startLine = line;
      const startCol = col;
      let v = '';
      while (i < n && /[0-9a-fA-FxXoObB._eE+j-]/.test(content[i]!) && !/^\s/.test(content[i]!)) {
        v += content[i];
        advance(1);
      }
      tokens.push({ type: 'number', value: v, line: startLine, col: startCol });
      continue;
    }
    // 标识符
    if (isIdentStart(c)) {
      const startLine = line;
      const startCol = col;
      let v = '';
      while (i < n && isIdentChar(content[i]!)) {
        v += content[i];
        advance(1);
      }
      tokens.push({ type: 'name', value: v, line: startLine, col: startCol });
      continue;
    }
    // 运算符 / 标点（含 . ( ) : = 等）
    const startLine = line;
    const startCol = col;
    let op = '';
    while (
      i < n &&
      !isIdentChar(content[i]!) &&
      !/[\s'"]/.test(content[i]!) &&
      content[i] !== '#' &&
      !/[0-9]/.test(content[i]!)
    ) {
      op += content[i];
      advance(1);
    }
    if (op.length > 0) {
      const open = '([{';
      const close = ')]}';
      for (const ch of op) {
        if (open.includes(ch)) depth += 1;
        else if (close.includes(ch)) depth = Math.max(0, depth - 1);
      }
      tokens.push({ type: 'op', value: op, line: startLine, col: startCol });
      continue;
    }
    // 兜底
    advance(1);
  }
  return tokens;
}

export function createPythonParser(port?: ExternalAstParserPort): AstParser {
  const language: SourceLanguage = 'python';
  return {
    language,
    parse(input: AstParseInput): AstParseResult {
      if (port !== undefined) {
        const fromPort = port.parse(input);
        if (fromPort !== null) return fromPort;
      }

      const lines = splitLines(input.content);
      const radius = input.contextRadius ?? 3;

      const identifierTargets = new Map<string, ProjectionKind>();
      const stringTargets = new Set<string>();
      const stringKind = new Map<string, ProjectionKind>();
      for (const t of input.targets) {
        if ((IDENTIFIER_PROJECTIONS as readonly string[]).includes(t.kind)) {
          if (!identifierTargets.has(t.value)) identifierTargets.set(t.value, t.kind);
        } else if ((STRING_PROJECTIONS as readonly string[]).includes(t.kind)) {
          stringTargets.add(t.value);
          if (!stringKind.has(t.value)) stringKind.set(t.value, t.kind);
        }
      }

      const tokens = tokenize(input.content);
      const hits: RawHit[] = [];

      const moduleScope: Frame = { level: 0, bindings: new Map() };
      const scopes: Frame[] = [moduleScope];
      const current = (): Frame => scopes[scopes.length - 1]!;
      const resolve = (name: string): 'target' | 'shadow' | 'none' => {
        for (let s = scopes.length - 1; s >= 0; s -= 1) {
          const b = scopes[s]!.bindings.get(name);
          if (b) return b.target ? 'target' : 'shadow';
        }
        return 'none';
      };
      const bind = (name: string, target: boolean): void => {
        current().bindings.set(name, { target });
      };

      const emit = (
        kind: ProjectionKind,
        symbol: string,
        line: number,
        column: number,
        length: number,
        role: HitRole,
        confidence: number,
        note: string | null,
      ): void => {
        hits.push({
          refPath: input.path,
          line,
          column,
          length,
          matchedSymbol: kind,
          symbol,
          role,
          confidence,
          context: extractContext(lines, line, radius),
          note,
        });
      };

      const isAssignmentLHS = (idx: number): boolean => {
        const nxt = tokens[idx + 1];
        if (!nxt) return false;
        if (nxt.type === 'op') return ASSIGN_OPS.has(nxt.value);
        return false;
      };
      const nextIsCall = (idx: number): boolean => {
        const nxt = tokens[idx + 1];
        return nxt !== undefined && nxt.type === 'op' && nxt.value === '(';
      };

      let expectingDef = false;
      let inImport = false;
      let inFrom = false;
      let bindingImported = false;
      let expectAs = false;
      let forMode = false;
      let skipName = false;
      let prevTok: Token | null = null;

      const reconcile = (newIndent: number): void => {
        while (scopes.length > 1 && scopes[scopes.length - 1]!.level > newIndent) scopes.pop();
        if (newIndent > current().level) scopes.push({ level: newIndent, bindings: new Map() });
      };

      let i = 0;
      while (i < tokens.length) {
        const tok = tokens[i]!;
        if (tok.type === 'nl') {
          reconcile(tok.indent ?? 0);
          inImport = false;
          inFrom = false;
          bindingImported = false;
          forMode = false;
          skipName = false;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (tok.type === 'string') {
          if (stringTargets.has(tok.value)) {
            const kind = stringKind.get(tok.value) ?? 'i18nKey';
            const column = tok.contentCol ?? tok.col + 1;
            hits.push({
              refPath: input.path,
              line: tok.line,
              column,
              length: tok.value.length,
              matchedSymbol: kind,
              symbol: tok.value,
              role: 'string-literal',
              confidence: 1.0,
              context: extractContext(lines, tok.line, radius),
              note: null,
            });
          }
          prevTok = tok;
          i += 1;
          continue;
        }
        if (tok.type !== 'name') {
          prevTok = tok;
          i += 1;
          continue;
        }

        const w = tok.value;
        const isAttr = prevTok !== null && prevTok.type === 'op' && prevTok.value === '.';

        if (w === 'def' || w === 'class') {
          expectingDef = true;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (w === 'import') {
          if (inFrom) {
            inFrom = false;
            bindingImported = true;
          } else {
            inImport = true;
          }
          prevTok = tok;
          i += 1;
          continue;
        }
        if (w === 'from') {
          inFrom = true;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (w === 'as') {
          expectAs = true;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (w === 'for') {
          forMode = true;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (w === 'in' && forMode) {
          forMode = false;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (w === 'global' || w === 'nonlocal') {
          skipName = true;
          prevTok = tok;
          i += 1;
          continue;
        }

        if (skipName) {
          skipName = false;
          prevTok = tok;
          i += 1;
          continue;
        }

        if (expectingDef) {
          const enclosingLevel = current().level;
          bind(w, enclosingLevel === 0);
          if (enclosingLevel === 0) {
            const k = identifierTargets.get(w);
            if (k !== undefined) emit(k, w, tok.line, tok.col, w.length, 'declaration', 1.0, null);
          }
          scopes.push({ level: enclosingLevel + 1, bindings: new Map() });
          expectingDef = false;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (inImport || bindingImported) {
          if (!isAttr) {
            bind(w, current().level === 0);
            if (current().level === 0) {
              const k = identifierTargets.get(w);
              if (k !== undefined) emit(k, w, tok.line, tok.col, w.length, 'import', 1.0, null);
            }
          }
          prevTok = tok;
          i += 1;
          continue;
        }
        if (expectAs) {
          if (!isAttr) {
            bind(w, current().level === 0);
            if (current().level === 0) {
              const k = identifierTargets.get(w);
              if (k !== undefined) emit(k, w, tok.line, tok.col, w.length, 'import', 1.0, null);
            }
          }
          expectAs = false;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (forMode) {
          if (!isAttr) bind(w, false);
          prevTok = tok;
          i += 1;
          continue;
        }

        // 普通引用 / 赋值左值
        if (!isAttr) {
          if (isAssignmentLHS(i)) {
            bind(w, current().level === 0);
            if (current().level === 0) {
              const k = identifierTargets.get(w);
              if (k !== undefined)
                emit(k, w, tok.line, tok.col, w.length, 'declaration', 1.0, null);
            }
          } else {
            const k = identifierTargets.get(w);
            if (k !== undefined && resolve(w) !== 'shadow') {
              const role: HitRole = nextIsCall(i) ? 'call' : 'call';
              emit(k, w, tok.line, tok.col, w.length, role, 1.0, null);
            }
          }
        }

        prevTok = tok;
        i += 1;
      }

      const degradation: ParserDegradation = {
        language: 'python',
        reason: '未检测到 libcst 解析器端口，使用内置缩进作用域解析器',
        fallback: 'builtin-scope-tokenizer',
      };
      return { hits, degradation };
    },
  };
}
