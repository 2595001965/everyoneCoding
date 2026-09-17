/**
 * Java 出现位置解析器（FR-UNI-06 降级口径：内置大括号作用域解析器）。
 *
 * JavaParser 不可用，故实现**内置**词法器 + 大括号作用域解析：
 * - 正确跳过 `//`、`/* *\/`（含 javadoc）、字符串 `"..."`、字符 `'x'`、文本块 `"""..."""`、
 *   注解 `@X`、泛型 `<>`；
 * - 按大括号维护作用域栈，收集 import / class·interface·enum·record / 方法 / 局部变量 /
 *   参数 / catch / for 绑定；
 * - 标识符引用由内向外解析，命中内层同名局部绑定则排除；成员访问（非 this/super）一律排除，
 *   `this.Name` 收录为 member-access（0.8）。
 *
 * 若注入 `ExternalAstParserPort` 且返回非 null，优先使用端口结果（`degradation` 为 null）。
 * 否则使用内置解析器并在 `degradation` 中如实上报降级。
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
  contentCol?: number;
}

const CTRL = new Set([
  'return',
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'throw',
  'new',
  'synchronized',
  'do',
  'else',
  'try',
  'assert',
  'yield',
  'break',
  'continue',
  'this',
  'super',
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
      tokens.push({ type: 'nl', value: '\n', line, col });
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
    // 行注释
    if (c === '/' && content[i + 1] === '/') {
      let j = i;
      while (j < n && content[j] !== '\n') j += 1;
      advance(j - i);
      continue;
    }
    // 块注释
    if (c === '/' && content[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(content[j] === '*' && content[j + 1] === '/')) j += 1;
      if (j < n) j += 2;
      advance(j - i);
      continue;
    }
    // 字符串 / 字符 / 文本块
    if (c === '"' || c === "'") {
      const quoteLine = line;
      const quoteCol = col;
      const quote = c;
      let isTextBlock = false;
      if (content[i + 1] === quote && content[i + 2] === quote) isTextBlock = true;
      const delimLen = isTextBlock ? 3 : 1;
      advance(delimLen);
      const contentStartCol = col;
      const startIdx = i;
      let closed = false;
      while (i < n) {
        const ch = content[i]!;
        if (!isTextBlock && ch === '\\') {
          advance(1);
          if (i < n) advance(1);
          continue;
        }
        if (ch === quote) {
          if (isTextBlock) {
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
          if (isTextBlock) {
            advance(1);
            continue;
          }
          break;
        }
        advance(1);
      }
      const rawValue = content.slice(startIdx, closed ? i - (isTextBlock ? 3 : 1) : i);
      tokens.push({
        type: 'string',
        value: rawValue,
        line: quoteLine,
        col: quoteCol,
        contentCol: contentStartCol,
      });
      continue;
    }
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
    const startLine = line;
    const startCol = col;
    let op = '';
    while (
      i < n &&
      !isIdentChar(content[i]!) &&
      !/[\s'"]/.test(content[i]!) &&
      content[i] !== '/' &&
      !/[0-9]/.test(content[i]!)
    ) {
      op += content[i];
      advance(1);
    }
    if (op.length > 0) {
      tokens.push({ type: 'op', value: op, line: startLine, col: startCol });
      continue;
    }
    advance(1);
  }
  return tokens;
}

export function createJavaParser(port?: ExternalAstParserPort): AstParser {
  const language: SourceLanguage = 'java';
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

      const nextIsParenAfterGenerics = (idx: number): boolean => {
        let j = idx + 1;
        while (j < tokens.length) {
          const t = tokens[j]!;
          if (t.type === 'op' && t.value.startsWith('<')) {
            let k = j;
            while (k < tokens.length && !(tokens[k]!.type === 'op' && tokens[k]!.value === '>')) k += 1;
            j = k + 1;
            continue;
          }
          if (t.type === 'op' && t.value === '(') return true;
          return false;
        }
        return false;
      };

      let importMode = false;
      let importBuffer: string[] = [];
      let importWildcard = false;
      let typeKeywordMode = false;
      let prevTok: Token | null = null;
      let prev2Tok: Token | null = null;

      let i = 0;
      while (i < tokens.length) {
        const tok = tokens[i]!;

        if (tok.type === 'nl') {
          prev2Tok = prevTok;
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
          prev2Tok = prevTok;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (tok.type === 'op') {
          if (tok.value === '{') scopes.push({ level: current().level + 1, bindings: new Map() });
          else if (tok.value === '}') {
            if (scopes.length > 1) scopes.pop();
          }
          if (importMode && (tok.value === ';' || tok.value === '.' || tok.value === '*')) {
            if (tok.value === '*') importWildcard = true;
            else if (tok.value === ';') {
              const last = importBuffer[importBuffer.length - 1];
              if (last !== undefined && !importWildcard && current().level === 0) {
                bind(last, true);
                const k = identifierTargets.get(last);
                if (k !== undefined) emit(k, last, tok.line, tok.col, last.length, 'import', 1.0, null);
              }
              importMode = false;
              importBuffer = [];
              importWildcard = false;
            }
            prev2Tok = prevTok;
            prevTok = tok;
            i += 1;
            continue;
          }
          prev2Tok = prevTok;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (tok.type !== 'name') {
          prev2Tok = prevTok;
          prevTok = tok;
          i += 1;
          continue;
        }

        const w = tok.value;
        const prevVal = prevTok !== null ? prevTok.value : null;
        const prevIsName = prevTok !== null && prevTok.type === 'name';
        const prevWord = prevTok !== null && prevTok.type === 'name' ? prevTok.value : null;
        const isAttr = prevTok !== null && prevTok.type === 'op' && prevTok.value === '.';
        const isAnno = prevTok !== null && prevTok.type === 'op' && prevTok.value === '@';
        const receiverTok = prev2Tok !== null && prev2Tok.type === 'name' ? prev2Tok.value : null;

        if (isAnno) {
          prev2Tok = prevTok;
          prevTok = tok;
          i += 1;
          continue;
        }

        if (w === 'import') {
          importMode = true;
          importBuffer = [];
          importWildcard = false;
          prev2Tok = prevTok;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (importMode) {
          if (tok.type === 'name' && tok.value !== 'static') importBuffer.push(tok.value);
          prev2Tok = prevTok;
          prevTok = tok;
          i += 1;
          continue;
        }

        if (w === 'class' || w === 'interface' || w === 'enum' || w === 'record') {
          typeKeywordMode = true;
          prev2Tok = prevTok;
          prevTok = tok;
          i += 1;
          continue;
        }
        if (typeKeywordMode) {
          if (tok.type === 'name') {
            bind(w, current().level <= 1);
            if (current().level <= 1) {
              const k = identifierTargets.get(w);
              if (k !== undefined) emit(k, w, tok.line, tok.col, w.length, 'declaration', 1.0, null);
            }
          }
          typeKeywordMode = false;
          prev2Tok = prevTok;
          prevTok = tok;
          i += 1;
          continue;
        }

        // 成员访问
        if (isAttr) {
          if (receiverTok === 'this' || receiverTok === 'super') {
            const k = identifierTargets.get(w);
            if (k !== undefined) {
              emit(
                k,
                w,
                tok.line,
                tok.col,
                w.length,
                'member-access',
                0.8,
                '成员访问：接收者为 this/super，需人工确认',
              );
            }
          }
          prev2Tok = prevTok;
          prevTok = tok;
          i += 1;
          continue;
        }

        const invokes = nextIsParenAfterGenerics(i);
        if (invokes) {
          const isDeclPred =
            (prevIsName && (prevWord === null || !CTRL.has(prevWord))) ||
            prevVal === '>' ||
            prevVal === ']';
          if (isDeclPred && prevWord !== null && !CTRL.has(prevWord) && prevVal !== 'new') {
            bind(w, current().level <= 1);
            if (current().level <= 1) {
              const k = identifierTargets.get(w);
              if (k !== undefined) emit(k, w, tok.line, tok.col, w.length, 'declaration', 1.0, null);
            }
          } else {
            const k = identifierTargets.get(w);
            if (k !== undefined && resolve(w) !== 'shadow') {
              emit(k, w, tok.line, tok.col, w.length, 'call', 1.0, null);
            }
          }
          prev2Tok = prevTok;
          prevTok = tok;
          i += 1;
          continue;
        }

        // 变量 / 字段声明：Type X（前一个是类型名 / > / ]）
        const isVarDecl =
          (prevIsName && (prevWord === null || !CTRL.has(prevWord))) ||
          prevVal === '>' ||
          prevVal === ']';
        if (isVarDecl && prevWord !== null && !CTRL.has(prevWord)) {
          bind(w, current().level <= 1);
          if (current().level <= 1) {
            const k = identifierTargets.get(w);
            if (k !== undefined) emit(k, w, tok.line, tok.col, w.length, 'declaration', 1.0, null);
          }
          prev2Tok = prevTok;
          prevTok = tok;
          i += 1;
          continue;
        }

        // 普通引用
        const k = identifierTargets.get(w);
        if (k !== undefined && resolve(w) !== 'shadow') {
          emit(k, w, tok.line, tok.col, w.length, 'call', 1.0, null);
        }

        prev2Tok = prevTok;
        prevTok = tok;
        i += 1;
      }

      const degradation: ParserDegradation = {
        language: 'java',
        reason: '未检测到 JavaParser 解析器端口，使用内置大括号作用域解析器',
        fallback: 'builtin-brace-tokenizer',
      };
      return { hits, degradation };
    },
  };
}
