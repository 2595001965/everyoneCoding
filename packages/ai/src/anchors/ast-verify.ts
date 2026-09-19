import { ANCHOR_KINDS, type AnchorDeclaration, type AnchorKind } from './anchor-model';

/**
 * AST 解析校验（T4-06 要点 3）。
 *
 * 架构选择（需要如实说明）：**AST 解析器通过端口注入** `AstAdapter`，
 * 默认实现是"多语言符号索引器"（正则 + 括号/缩进配平），而不是绑定 ts-morph。
 *
 * 理由：
 * - ts-morph 会为整个依赖树引入 TypeScript 编译器（数十 MB），
 *   而 `@ec/ai` 同时被渲染层按浏览器条件引用（`browser.ts`），
 *   一旦静态引入就会污染前端产物 —— 这是 Wave 2/3 已经踩过的坑；
 * - 校验所需的语义很小（"该文件里有没有这个符号、在哪几行、是不是这类东西"），
 *   默认实现足以覆盖 TS/JS/Java/ArkTS/Python/Dart/SQL；
 * - 需要真 AST 时，外壳在 Wave 9/10 装配阶段注入 ts-morph / JavaParser 适配器即可，
 *   接口已经留好（`AstAdapter`），调用方无需改动。
 *
 * 校验不是"能不能解析"，而是**三个具体断言**：
 * ① 声明的符号在文件中真实存在；
 * ② 声明的行号区间确实覆盖该符号（否则判 drift，由 reassociate 重定位）；
 * ③ 声明的 kind 与符号的实际形态匹配（如 `controller` 不该指向一个 SQL 建表语句）。
 */

export type SymbolForm =
  'class' | 'interface' | 'function' | 'method' | 'variable' | 'table' | 'unknown';

export interface SymbolIndexEntry {
  /** 符号名（方法为 `Class.method` 或裸方法名） */
  name: string;
  form: SymbolForm;
  startLine: number;
  endLine: number;
  /** 所属容器（类名 / 表名） */
  container: string | null;
}

export interface AstAdapter {
  /** 解析一个文件的符号索引（1-based 行号） */
  indexSymbols(input: { path: string; content: string }): SymbolIndexEntry[];
}

export type AnchorVerificationStatus = 'ok' | 'drift' | 'missing';

export const VERIFY_STATUS_LABELS: Record<AnchorVerificationStatus, string> = {
  ok: '校验通过',
  drift: '位置漂移',
  missing: '符号不存在',
};

export interface AnchorVerification {
  elementId: string;
  filePath: string;
  symbol: string;
  status: AnchorVerificationStatus;
  reason: string;
  /** 校验通过 / 重定位后的真实位置 */
  resolved: {
    startLine: number;
    endLine: number;
    form: SymbolForm;
    container: string | null;
  } | null;
}

/* ------------------------------ kind ↔ form 映射 ------------------------------ */

/** 各类锚点应当指向的符号形态（用于"错误 kind"这类反例判定） */
export const KIND_EXPECTED_FORMS: Record<AnchorKind, readonly SymbolForm[]> = {
  controller: ['class', 'function', 'method'],
  service: ['class', 'function', 'method'],
  dto: ['class', 'interface', 'variable'],
  repo: ['class', 'interface', 'function', 'method'],
  sql: ['table', 'variable', 'unknown'],
  test: ['function', 'method', 'class'],
  route: ['function', 'variable', 'class', 'method'],
};

export function kindMatchesForm(kind: AnchorKind, form: SymbolForm): boolean {
  return KIND_EXPECTED_FORMS[kind].includes(form);
}

/* ------------------------------ 默认符号索引器 ------------------------------ */

const BRACE_LANGUAGES = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'java',
  'kt',
  'kts',
  'ets',
  'dart',
  'rs',
  'go',
  'cs',
]);

function extensionOf(path: string): string {
  return path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : '';
}

/**
 * 多语言符号索引（默认适配器）。
 *
 * 覆盖范围：花括号语言（TS/JS/Java/Kotlin/ArkTS/Dart/Rust/C#）+ Python（缩进）+ SQL（CREATE TABLE）。
 * 明确的局限：不做类型推导、不解析嵌套命名空间；对"符号重名"取第一个匹配。
 * 这些局限在校验用途下是可接受的（校验只关心"存在 + 位置 + 形态"）。
 */
export function createHeuristicAstAdapter(): AstAdapter {
  return {
    indexSymbols: ({ path, content }) => {
      const extension = extensionOf(path);
      const lines = content.replace(/\r\n?/g, '\n').split('\n');
      if (extension === 'py') return indexPython(lines);
      if (extension === 'sql') return indexSql(lines);
      if (BRACE_LANGUAGES.has(extension) || extension === '') return indexBraces(lines);
      return indexBraces(lines);
    },
  };
}

/** 默认实例（模块级单例，纯函数、无状态） */
export const defaultAstAdapter: AstAdapter = createHeuristicAstAdapter();

interface DeclarationHit {
  name: string;
  form: SymbolForm;
  line: number;
  container: string | null;
}

function indexBraces(lines: readonly string[]): SymbolIndexEntry[] {
  const hits: DeclarationHit[] = [];
  let container: { name: string; depth: number } | null = null;
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    const lineNumber = index + 1;

    const classLike =
      /^(?:export\s+)?(?:default\s+)?(?:abstract\s+|final\s+|public\s+|sealed\s+)*(class|interface|enum|struct|record)\s+([A-Za-z_$][\w$]*)/.exec(
        trimmed,
      );
    const functionLike =
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    const arrowLike =
      /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(?/.exec(
        trimmed,
      );
    const javaMethod =
      /^(?:public|private|protected|static|final|override|\s)*[\w<>,.\s]+?\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{?\s*$/.exec(
        trimmed,
      );
    const methodLike =
      container !== null
        ? /^(?:public|private|protected|static|async|get|set|override|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{/.exec(
            trimmed,
          )
        : null;

    if (classLike !== null && classLike[2] !== undefined) {
      hits.push({
        name: classLike[2],
        form: classLike[1] === 'interface' ? 'interface' : 'class',
        line: lineNumber,
        container: null,
      });
    } else if (functionLike !== null && functionLike[1] !== undefined) {
      hits.push({
        name: functionLike[1],
        form: container === null ? 'function' : 'method',
        line: lineNumber,
        container: container?.name ?? null,
      });
    } else if (arrowLike !== null && arrowLike[1] !== undefined) {
      hits.push({
        name: arrowLike[1],
        form: 'variable',
        line: lineNumber,
        container: container?.name ?? null,
      });
    } else if (javaMethod !== null && javaMethod[1] !== undefined) {
      hits.push({
        name: javaMethod[1],
        form: container === null ? 'function' : 'method',
        line: lineNumber,
        container: container?.name ?? null,
      });
    } else if (methodLike !== null && methodLike[1] !== undefined) {
      hits.push({
        name: methodLike[1],
        form: 'method',
        line: lineNumber,
        container: container?.name ?? null,
      });
    }

    // 花括号配平（粗略但足够定位符号边界）
    const opens = countChar(line, '{');
    const closes = countChar(line, '}');
    if (
      opens > 0 &&
      container === null &&
      (classLike !== null || functionLike !== null || arrowLike !== null)
    ) {
      const name = classLike?.[2] ?? functionLike?.[1] ?? arrowLike?.[1];
      if (name !== undefined) container = { name, depth };
    }
    depth += opens - closes;
    if (container !== null && depth <= container.depth) container = null;
  }

  return toEntries(hits, lines, 'braces');
}

function indexPython(lines: readonly string[]): SymbolIndexEntry[] {
  const hits: DeclarationHit[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const classMatch = /^class\s+([A-Za-z_]\w*)/.exec(trimmed);
    const defMatch = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (classMatch?.[1] !== undefined)
      hits.push({ name: classMatch[1], form: 'class', line: index + 1, container: null });

    if (defMatch?.[1] !== undefined) {
      hits.push({
        name: defMatch[1],
        form: indent === 0 ? 'function' : 'method',
        line: index + 1,
        container: null,
      });
    }
    void indent;
  }

  // Python 的块边界靠缩进：从声明行往下找到第一个非空且缩进 <= 声明行的行
  return hits.map((hit) => {
    const declarationLine = lines[hit.line - 1] ?? '';
    const baseIndent = declarationLine.length - declarationLine.trimStart().length;
    let endLine = hit.line;
    for (let index = hit.line; index < lines.length; index += 1) {
      const candidate = lines[index] ?? '';
      if (candidate.trim().length === 0) continue;
      const indent = candidate.length - candidate.trimStart().length;
      if (indent <= baseIndent) break;
      endLine = index + 1;
    }
    return { name: hit.name, form: hit.form, startLine: hit.line, endLine, container: null };
  });
}

function indexSql(lines: readonly string[]): SymbolIndexEntry[] {
  const hits: DeclarationHit[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([\w.]+)/i.exec(
      lines[index] ?? '',
    );
    if (match?.[1] === undefined) continue;
    hits.push({ name: match[1], form: 'table', line: index + 1, container: null });
  }
  return hits.map((hit) => ({
    name: hit.name,
    form: hit.form,
    startLine: hit.line,
    endLine: hit.line,
    container: null,
  }));
}

function toEntries(
  hits: readonly DeclarationHit[],
  lines: readonly string[],
  mode: 'braces',
): SymbolIndexEntry[] {
  void mode;
  return hits
    .map((hit) => {
      const startLine = hit.line;
      let endLine = hit.line;
      let depth = 0;
      let started = false;
      for (let index = startLine - 1; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        depth += countChar(line, '{') - countChar(line, '}');
        if (countChar(line, '{') > 0) started = true;
        endLine = index + 1;
        if (started && depth <= 0) break;
        if (!started && index + 1 - startLine > 2) break;
      }
      return {
        name: hit.container === null ? hit.name : `${hit.container}.${hit.name}`,
        form: hit.form,
        startLine,
        endLine,
        container: hit.container,
      };
    })
    .sort((a, b) => a.startLine - b.startLine);
}

function countChar(text: string, char: string): number {
  let count = 0;
  for (const current of text) if (current === char) count += 1;
  return count;
}

/* ------------------------------ 校验入口 ------------------------------ */

export interface VerifyInput {
  declaration: AnchorDeclaration;
  path: string;
  content: string;
  adapter?: AstAdapter | undefined;
}

/** 符号名归一化：取最后一段（`AuthController.login` → `login`）用于宽松匹配 */
function bareName(symbol: string): string {
  const parts = symbol.split(/[.:#]/);
  return parts[parts.length - 1] ?? symbol;
}

export function findSymbol(
  entries: readonly SymbolIndexEntry[],
  symbol: string,
): SymbolIndexEntry | null {
  const exact = entries.find((entry) => entry.name === symbol);
  if (exact !== undefined) return exact;
  const bare = bareName(symbol);
  // 先看容器是否匹配（`AuthController.login` 应命中 AuthController 下的 login）
  const container = symbol.includes('.') ? symbol.split('.')[0] : null;
  if (container !== null) {
    const scoped = entries.find((entry) => entry.name === `${container}.${bare}`);
    if (scoped !== undefined) return scoped;
  }
  return entries.find((entry) => entry.name === bare || entry.name.endsWith(`.${bare}`)) ?? null;
}

/** 校验单个锚点声明（三重锚定的第 ③ 层） */
export function verifyDeclaration(input: VerifyInput): AnchorVerification {
  const adapter = input.adapter ?? defaultAstAdapter;
  const entries = adapter.indexSymbols({ path: input.path, content: input.content });
  const found = findSymbol(entries, input.declaration.symbol);

  const base = {
    elementId: input.declaration.elementId,
    filePath: input.path,
    symbol: input.declaration.symbol,
  };

  if (found === null) {
    return {
      ...base,
      status: 'missing',
      reason: `文件中不存在符号 ${input.declaration.symbol}（可能是模型臆造的声明）`,
      resolved: null,
    };
  }

  if (!kindMatchesForm(input.declaration.kind, found.form)) {
    return {
      ...base,
      status: 'drift',
      reason: `锚点 kind=${input.declaration.kind} 与符号实际形态 ${found.form} 不匹配`,
      resolved: {
        startLine: found.startLine,
        endLine: found.endLine,
        form: found.form,
        container: found.container,
      },
    };
  }

  const declaredStart = input.declaration.startLine;
  const declaredEnd = input.declaration.endLine;
  if (
    declaredStart !== undefined &&
    (declaredStart < found.startLine || declaredStart > found.endLine)
  ) {
    return {
      ...base,
      status: 'drift',
      reason: `声明行号 ${declaredStart} 落在符号范围 ${found.startLine}-${found.endLine} 之外`,
      resolved: {
        startLine: found.startLine,
        endLine: found.endLine,
        form: found.form,
        container: found.container,
      },
    };
  }
  if (declaredEnd !== undefined && declaredEnd < found.startLine) {
    return {
      ...base,
      status: 'drift',
      reason: `声明行号区间 ${declaredStart ?? '?'}-${declaredEnd} 与符号范围 ${found.startLine}-${found.endLine} 无交集`,
      resolved: {
        startLine: found.startLine,
        endLine: found.endLine,
        form: found.form,
        container: found.container,
      },
    };
  }

  return {
    ...base,
    status: 'ok',
    reason: VERIFY_STATUS_LABELS.ok,
    resolved: {
      startLine: found.startLine,
      endLine: found.endLine,
      form: found.form,
      container: found.container,
    },
  };
}

/** 批量校验（同一文件的声明只解析一次） */
export function verifyDeclarations(input: {
  declarations: readonly AnchorDeclaration[];
  readFile: (path: string) => string | null;
  adapter?: AstAdapter | undefined;
}): AnchorVerification[] {
  const adapter = input.adapter ?? defaultAstAdapter;
  const cache = new Map<string, string | null>();
  return input.declarations.map((declaration) => {
    if (!cache.has(declaration.filePath))
      cache.set(declaration.filePath, input.readFile(declaration.filePath));
    const content = cache.get(declaration.filePath) ?? null;
    if (content === null) {
      return {
        elementId: declaration.elementId,
        filePath: declaration.filePath,
        symbol: declaration.symbol,
        status: 'missing' as const,
        reason: '锚点声明的文件不存在',
        resolved: null,
      };
    }
    return verifyDeclaration({ declaration, path: declaration.filePath, content, adapter });
  });
}

/** 便于测试与断言：所有 kind 都能映射到至少一种符号形态 */
export function assertKindCoverage(): void {
  for (const kind of ANCHOR_KINDS) {
    if ((KIND_EXPECTED_FORMS[kind] ?? []).length === 0)
      throw new Error(`未定义 kind=${kind} 的期望形态`);
  }
}
