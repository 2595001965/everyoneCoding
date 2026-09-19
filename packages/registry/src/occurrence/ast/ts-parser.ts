/**
 * TypeScript / TSX / JS / JSX 出现位置解析器（FR-UNI-06 硬约束：AST 作用域感知）。
 *
 * 真用 TypeScript 编译器 API 遍历 AST，自己维护作用域栈，做**由内向外**的绑定解析：
 * 标识符引用若最近一次绑定是某个内层局部声明（同名遮蔽），则排除；成员访问的接收者
 * 非 `this`/`super` 一律排除（第三方库同名符号）。`degradation` 恒为 `null`。
 */

import ts from 'typescript';

import type {
  AstParser,
  AstParseInput,
  AstParseResult,
  HitRole,
  RawHit,
  SourceLanguage,
} from '../types';
import { IDENTIFIER_PROJECTIONS, STRING_PROJECTIONS } from '../types';
import type { ProjectionKind } from '../../naming/presets';
import { extractContext, positionOf, splitLines } from '../text-utils';

/** 单个作用域帧：可沿 `parent` 向上回溯查找绑定 */
interface Frame {
  parent: Frame | null;
  isModule: boolean;
  bindings: Map<string, { target: boolean }>;
}

export function createTsParser(language: SourceLanguage = 'ts'): AstParser {
  return { language, parse };

  function parse(input: AstParseInput): AstParseResult {
    const source = ts.createSourceFile(
      input.path,
      input.content,
      ts.ScriptTarget.ES2022,
      true,
      input.path.endsWith('.tsx') || input.path.endsWith('.jsx')
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
    );

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

    const hits: RawHit[] = [];
    const root: Frame = { parent: null, isModule: true, bindings: new Map() };

    function recordBinding(name: string, frame: Frame, target: boolean): void {
      const cur = frame.bindings.get(name);
      frame.bindings.set(name, { target: target || (cur ? cur.target : false) });
    }

    function resolve(name: string, frame: Frame): 'target' | 'shadow' | 'none' {
      let f: Frame | null = frame;
      while (f) {
        const b = f.bindings.get(name);
        if (b) return b.target ? 'target' : 'shadow';
        f = f.parent;
      }
      return 'none';
    }

    function emit(
      kind: ProjectionKind,
      symbol: string,
      start: number,
      length: number,
      role: HitRole,
      confidence: number,
      note: string | null,
    ): void {
      const pos = positionOf(input.content, start);
      hits.push({
        refPath: input.path,
        line: pos.line,
        column: pos.column,
        length,
        matchedSymbol: kind,
        symbol,
        role,
        confidence,
        context: extractContext(lines, pos.line, radius),
        note,
      });
    }

    function isThisOrSuper(node: ts.Node): boolean {
      return node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword;
    }

    function isMemberNameDecl(node: ts.Identifier): boolean {
      const p = node.parent;
      if (!p) return false;
      if (
        (ts.isMethodDeclaration(p) ||
          ts.isPropertyDeclaration(p) ||
          ts.isGetAccessor(p) ||
          ts.isSetAccessor(p) ||
          ts.isMethodSignature(p) ||
          ts.isPropertySignature(p) ||
          ts.isEnumMember(p) ||
          ts.isTypeParameterDeclaration(p) ||
          ts.isConstructorDeclaration(p)) &&
        p.name === node
      ) {
        return true;
      }
      return false;
    }

    function isTopLevelDeclarationName(node: ts.Identifier): boolean {
      const p = node.parent;
      if (!p) return false;
      if (
        ts.isFunctionDeclaration(p) ||
        ts.isClassDeclaration(p) ||
        ts.isInterfaceDeclaration(p) ||
        ts.isTypeAliasDeclaration(p) ||
        ts.isEnumDeclaration(p) ||
        ts.isVariableDeclaration(p)
      ) {
        return (p as { name?: ts.Node }).name === node;
      }
      return false;
    }

    /** 标识符所在声明是否为真正的顶层 `const/let/var` 语句（排除 for/catch 中的声明） */
    function isVarStatementContext(node: ts.Identifier): boolean {
      const p = node.parent;
      if (!p || !ts.isVariableDeclaration(p)) return false;
      const gp = p.parent;
      return gp !== undefined && ts.isVariableDeclarationList(gp);
    }

    function isTopLevelFunction(node: ts.Node): boolean {
      const p = node.parent;
      return p !== undefined && (ts.isSourceFile(p) || ts.isModuleBlock(p));
    }

    function collectBindingNames(pat: ts.BindingPattern, frame: Frame): void {
      for (const el of pat.elements) {
        if (ts.isBindingElement(el)) {
          if (ts.isIdentifier(el.name)) recordBinding(el.name.text, frame, false);
          else collectBindingNames(el.name as ts.BindingPattern, frame);
        }
      }
    }

    function addParams(node: ts.Node, inner: Frame): void {
      if (ts.isFunctionLike(node)) {
        for (const param of node.parameters) {
          if (ts.isIdentifier(param.name)) recordBinding(param.name.text, inner, false);
          else if (!ts.isIdentifier(param.name))
            collectBindingNames(param.name as ts.BindingPattern, inner);
        }
      }
    }

    function handleIdentifier(node: ts.Identifier, frame: Frame): void {
      const text = node.text;
      const idKind = identifierTargets.get(text);
      const p = node.parent;
      if (!p) return;

      // 导入绑定：import specifier / default import clause / namespace import
      if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) {
        recordBinding(text, frame, frame.isModule);
        if (frame.isModule && idKind !== undefined) {
          emit(idKind, text, node.getStart(source), text.length, 'import', 1.0, null);
        }
        return;
      }

      // 成员声明名（方法 / 属性 / enum 成员等）：不是可重命名的目标声明，跳过
      if (isMemberNameDecl(node)) return;

      // 顶层声明名：function / class / interface / type / enum / const
      if (isTopLevelDeclarationName(node)) {
        const isVar = ts.isVariableDeclaration(p);
        const target = frame.isModule && (!isVar || isVarStatementContext(node));
        recordBinding(text, frame, target);
        if (target && idKind !== undefined) {
          emit(idKind, text, node.getStart(source), text.length, 'declaration', 1.0, null);
        }
        return;
      }

      // 函数参数
      if (ts.isParameter(p) && (p as { name: ts.Node }).name === node) {
        recordBinding(text, frame, false);
        return;
      }

      // 解构绑定（仅顶层 `const { x } = ...` 视为 binding 命中）
      if (ts.isBindingElement(p) && (p as { name: ts.Node }).name === node) {
        const target = frame.isModule && isVarStatementContext(node);
        recordBinding(text, frame, target);
        if (target && idKind !== undefined) {
          emit(idKind, text, node.getStart(source), text.length, 'binding', 1.0, null);
        }
        return;
      }

      // 成员访问 / 限定名：接收者为 this/super 收录（0.8），否则排除
      if (ts.isPropertyAccessExpression(p) && p.name === node) {
        if (isThisOrSuper(p.expression) && idKind !== undefined) {
          emit(
            idKind,
            text,
            node.getStart(source),
            text.length,
            'member-access',
            0.8,
            '成员访问：接收者为 this/super，需人工确认',
          );
        }
        return;
      }
      if (ts.isQualifiedName(p) && p.right === node) {
        if (isThisOrSuper(p.left) && idKind !== undefined) {
          emit(
            idKind,
            text,
            node.getStart(source),
            text.length,
            'member-access',
            0.8,
            '成员访问：接收者为 this/super，需人工确认',
          );
        }
        return;
      }

      // 普通引用
      if (idKind === undefined) return;
      if (resolve(text, frame) === 'shadow') return;

      let role: HitRole = 'call';
      if (ts.isJsxSelfClosingElement(p) || ts.isJsxOpeningElement(p) || ts.isJsxClosingElement(p)) {
        role = 'jsx-tag';
      } else if (p.kind === ts.SyntaxKind.TypeReference || p.kind === ts.SyntaxKind.TypeQuery) {
        role = 'type-reference';
      }
      emit(idKind, text, node.getStart(source), text.length, role, 1.0, null);
    }

    function visit(node: ts.Node, frame: Frame): void {
      // 字符串字面量 / 无插值模板串：仅匹配 STRING_PROJECTIONS（整串精确）
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const v = node.text;
        if (stringTargets.has(v)) {
          const start = node.getStart(source) + 1; // 跳过开引号 / 开反引号
          const pos = positionOf(input.content, start);
          const kind = stringKind.get(v) ?? 'i18nKey';
          hits.push({
            refPath: input.path,
            line: pos.line,
            column: pos.column,
            length: v.length,
            matchedSymbol: kind,
            symbol: v,
            role: 'string-literal',
            confidence: 1.0,
            context: extractContext(lines, pos.line, radius),
            note: null,
          });
        }
      }

      let childFrame: Frame = frame;
      let skip: ts.Node | undefined;

      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node)
      ) {
        if (isTopLevelFunction(node) && node.name !== undefined && ts.isIdentifier(node.name)) {
          const nm = node.name.text;
          const k = identifierTargets.get(nm);
          recordBinding(nm, frame, frame.isModule);
          if (frame.isModule && k !== undefined) {
            emit(k, nm, node.name.getStart(source), nm.length, 'declaration', 1.0, null);
          }
        }
        const inner: Frame = { parent: frame, isModule: false, bindings: new Map() };
        addParams(node, inner);
        childFrame = inner;
        skip = node.name;
      } else if (
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)
      ) {
        if (node.name !== undefined && ts.isIdentifier(node.name)) {
          const nm = node.name.text;
          const k = identifierTargets.get(nm);
          recordBinding(nm, frame, frame.isModule);
          if (frame.isModule && k !== undefined) {
            emit(k, nm, node.name.getStart(source), nm.length, 'declaration', 1.0, null);
          }
        }
        const inner: Frame = { parent: frame, isModule: false, bindings: new Map() };
        childFrame = inner;
        skip = node.name;
      } else if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCatchClause(node)) {
        childFrame = { parent: frame, isModule: false, bindings: new Map() };
      }

      if (ts.isIdentifier(node)) {
        handleIdentifier(node, frame);
      }

      ts.forEachChild(node, (child) => {
        if (child === skip) return;
        visit(child, childFrame);
      });
    }

    ts.forEachChild(source, (n) => visit(n, root));

    return { hits, degradation: null };
  }
}
