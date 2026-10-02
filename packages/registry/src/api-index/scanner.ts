import ts from 'typescript';
import {
  apiRouteKeyOf,
  normalizePathTemplate,
  redactText,
  type HttpMethod,
  type SourceRef,
} from '@ec/core';
import { parseTsSource } from '../occurrence/ast/ts-parser';
import { tokenizePython } from '../occurrence/ast/python-parser';
import type {
  ApiCallDraft,
  ApiEndpointDraft,
  ApiEvidence,
  ApiService,
  ApiSourceFile,
} from './types';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const dirname = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const joinPath = (...parts: string[]): string =>
  normalizePathTemplate(
    '/' +
      parts
        .map((p) => p.replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
        .join('/'),
  );
const moduleKey = (path: string, name: string): string => `${path}#${name}`;

/** The shell injects the existing OpenAPI loader; this package never loads URLs. */
export interface ApiContractParser {
  (text: string): {
    routes: Array<{
      method: string;
      path: string;
      operationId: string | null;
      summary: string | null;
      tags: string[];
      requestSchema: unknown;
      responseSchema: unknown;
      parameters?: unknown;
      authentication?: unknown;
      servers?: string[];
    }>;
    servers?: string[];
    warnings: string[];
  };
}

export interface ApiScanResult {
  endpoints: ApiEndpointDraft[];
  calls: ApiCallDraft[];
  services: ApiService[];
  warnings: string[];
  complete: boolean;
}

interface RouterNode {
  key: string;
  file: string;
  name: string;
  root: string;
  app: boolean;
  prefix: string | null;
  origins: string[];
}
interface Mount {
  parent: string;
  child: string;
  prefix: string | null;
  evidence: ApiEvidence;
}
interface Route {
  receiver: string;
  method: HttpMethod;
  path: string | null;
  expression: string;
  title: string;
  evidence: ApiEvidence;
  parameters: unknown;
  response: unknown;
  auth: string[];
  implementation: SourceRef[];
}
interface ImportRef {
  path: string;
  exported: string;
}
interface TsUnit {
  file: ApiSourceFile;
  source: ts.SourceFile;
  root: string;
  constants: Map<string, ts.Expression>;
  imports: Map<string, ImportRef>;
  exports: Map<string, string>;
  express: Set<string>;
  routerFactories: Set<string>;
  axios: Set<string>;
  clients: Map<string, { base: string | null; dynamic: boolean }>;
  nest: Map<string, string>;
  nestFactories: Set<string>;
  nestApps: Set<string>;
  localNames: Set<string>;
}

function asObject(node: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  return node && ts.isObjectLiteralExpression(node) ? node : null;
}
function property(node: ts.Expression | undefined, name: string): ts.Expression | undefined {
  return asObject(node)?.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, '') === name,
  )?.initializer;
}
function staticString(node: ts.Expression | undefined, unit: TsUnit, depth = 0): string | null {
  if (!node || depth > 8) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
    return staticString(node.expression, unit, depth + 1);
  if (ts.isIdentifier(node)) return staticString(unit.constants.get(node.text), unit, depth + 1);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left, unit, depth + 1),
      right = staticString(node.right, unit, depth + 1);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}
function symbolicString(node: ts.Expression | undefined, unit: TsUnit): string | null {
  const literal = staticString(node, unit);
  if (literal !== null) return literal;
  if (node && ts.isTemplateExpression(node))
    return (
      node.head.text + node.templateSpans.map((s, i) => `{dynamic${i}}${s.literal.text}`).join('')
    );
  if (node && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = symbolicString(node.left, unit),
      right = symbolicString(node.right, unit);
    return left === null ? null : left + (right ?? '{dynamic}');
  }
  return null;
}
function sourceRef(unit: TsUnit, node: ts.Node, symbol: string | null = null): SourceRef {
  return {
    filePath: unit.file.path,
    startLine: unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    endLine: unit.source.getLineAndCharacterOfPosition(node.end).line + 1,
    symbol,
  };
}
function bindingName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isVariableDeclaration(node)) &&
    node.name
  )
    return node.name.getText();
  return null;
}
function enclosingSymbol(node: ts.Node): string {
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    const name = bindingName(cursor);
    if (name) return name;
  }
  return 'module';
}
function handlerDetails(
  unit: TsUnit,
  handler: ts.Expression | undefined,
): { parameters: string[]; response: string[]; implementation: SourceRef[] } {
  const details = {
    parameters: [] as string[],
    response: [] as string[],
    implementation: [] as SourceRef[],
  };
  if (!handler) return details;
  const body = ts.isIdentifier(handler)
    ? (unit.constants.get(handler.text) ??
      unit.source.statements.find(
        (s) => ts.isFunctionDeclaration(s) && s.name?.text === handler.text,
      ) ??
      handler)
    : handler;
  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(n) &&
      /^(req|request)\.(params|query|body|headers)(\.|$)/.test(n.getText())
    )
      details.parameters.push(n.getText());
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const name = n.expression.getText();
      if (/^(res|response)\.(json|send|status)$/.test(name))
        details.response.push(redactText(n.getText().slice(0, 300)));
      if (/service/i.test(n.expression.expression.getText()))
        details.implementation.push(sourceRef(unit, n, name));
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  details.parameters = [...new Set(details.parameters)];
  return details;
}
/** Reject local shadow bindings. Only explicit imported HTTP clients/routers count. */
function shadowed(node: ts.Node, name: string): boolean {
  for (let cursor = node.parent; cursor && !ts.isSourceFile(cursor); cursor = cursor.parent) {
    if (ts.isFunctionLike(cursor) && cursor.parameters.some((p) => hasBinding(p.name, name)))
      return true;
    if (ts.isBlock(cursor)) {
      for (const s of cursor.statements) {
        if (
          ts.isVariableStatement(s) &&
          s.declarationList.declarations.some((d) => hasBinding(d.name, name))
        )
          return true;
      }
    }
  }
  return false;
}
function hasBinding(binding: ts.BindingName, name: string): boolean {
  return ts.isIdentifier(binding)
    ? binding.text === name
    : binding.elements.some((e) => ts.isBindingElement(e) && hasBinding(e.name, name));
}
function localModule(from: string, spec: string, paths: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = [...dirname(from).split('/').filter(Boolean), ...spec.split('/')];
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  const base = out.join('/').replace(/\.(js|mjs|cjs)$/, '');
  return (
    [
      base,
      ...[
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.mts',
        '.cts',
        '/index.ts',
        '/index.js',
      ].map((e) => base + e),
    ].find((p) => paths.has(p)) ?? null
  );
}
function rootOf(path: string, roots: string[]): string {
  return (
    roots
      .filter((r) => r === '' || path.startsWith(r + '/'))
      .sort((a, b) => b.length - a.length)[0] ?? ''
  );
}

export function scanApiSources(
  files: readonly ApiSourceFile[],
  parseContract?: ApiContractParser,
): ApiScanResult {
  const paths = new Set(files.map((f) => f.path));
  const roots = files
    .filter((f) => /(^|\/)(package\.json|pyproject\.toml|requirements\.txt)$/.test(f.path))
    .map((f) => dirname(f.path));
  const units = new Map<string, TsUnit>();
  const routers = new Map<string, RouterNode>();
  const mounts: Mount[] = [],
    routes: Route[] = [],
    calls: ApiCallDraft[] = [],
    warnings: string[] = [];
  const globals = new Map<string, string | null>();
  const nestInstances = new Map<string, Set<string>>();
  const nestOrigins = new Map<string, string[]>();
  let complete = true;
  const proxies: Array<{
    root: string;
    prefix: string;
    target: string | null;
    rewritten: boolean;
    ref: SourceRef;
  }> = [];

  for (const file of files.filter(
    (f) => /\.[cm]?[jt]sx?$/.test(f.path) && !/\.(test|spec)\./.test(f.path),
  )) {
    const source = parseTsSource(file.path, file.content);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics;
    if (diagnostics?.length) {
      complete = false;
      warnings.push(`${file.path} 存在语法错误，跳过该文件并保留旧接口`);
      continue;
    }
    const unit: TsUnit = {
      file,
      source,
      root: rootOf(file.path, roots),
      constants: new Map(),
      imports: new Map(),
      exports: new Map(),
      express: new Set(),
      routerFactories: new Set(),
      axios: new Set(),
      clients: new Map(),
      nest: new Map(),
      nestFactories: new Set(),
      nestApps: new Set(),
      localNames: new Set(),
    };
    units.set(file.path, unit);
    for (const s of source.statements) {
      if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name)
        unit.localNames.add(s.name.text);
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
        const spec = s.moduleSpecifier.text,
          clause = s.importClause,
          target = localModule(file.path, spec, paths);
        if (clause?.name) {
          const name = clause.name.text;
          unit.localNames.add(name);
          if (spec === 'express') unit.express.add(name);
          if (spec === 'axios') unit.axios.add(name);
          if (target) unit.imports.set(name, { path: target, exported: 'default' });
        }
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          unit.localNames.add(bindings.name.text);
          if (spec === 'express') unit.express.add(bindings.name.text);
          if (spec === 'axios') unit.axios.add(bindings.name.text);
        }
        if (bindings && ts.isNamedImports(bindings))
          for (const b of bindings.elements) {
            const exported = (b.propertyName ?? b.name).text,
              name = b.name.text;
            unit.localNames.add(name);
            if (spec === 'express' && exported === 'Router') unit.routerFactories.add(name);
            if (spec === '@nestjs/common') unit.nest.set(name, exported);
            if (spec === '@nestjs/core' && exported === 'NestFactory') unit.nestFactories.add(name);
            if (target) unit.imports.set(name, { path: target, exported });
          }
      }
      if (ts.isVariableStatement(s))
        for (const d of s.declarationList.declarations) {
          if (
            ts.isObjectBindingPattern(d.name) &&
            d.initializer &&
            ts.isCallExpression(d.initializer) &&
            ts.isIdentifier(d.initializer.expression) &&
            d.initializer.expression.text === 'require' &&
            d.initializer.arguments[0] &&
            ts.isStringLiteral(d.initializer.arguments[0]) &&
            d.initializer.arguments[0].text === 'express'
          ) {
            for (const b of d.name.elements)
              if (
                ts.isIdentifier(b.name) &&
                (b.propertyName?.getText() ?? b.name.text) === 'Router'
              )
                unit.routerFactories.add(b.name.text);
          }
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          unit.localNames.add(d.name.text);
          if ((s.declarationList.flags & ts.NodeFlags.Const) !== 0)
            unit.constants.set(d.name.text, d.initializer);
          if (s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
            unit.exports.set(d.name.text, d.name.text);
          if (
            ts.isCallExpression(d.initializer) &&
            ts.isIdentifier(d.initializer.expression) &&
            d.initializer.expression.text === 'require' &&
            ts.isStringLiteral(d.initializer.arguments[0]!)
          ) {
            const spec = (d.initializer.arguments[0] as ts.StringLiteral).text;
            if (spec === 'express') unit.express.add(d.name.text);
            if (spec === 'axios') unit.axios.add(d.name.text);
            const target = localModule(file.path, spec, paths);
            if (target) unit.imports.set(d.name.text, { path: target, exported: 'default' });
          }
        }
      if (ts.isExportAssignment(s) && ts.isIdentifier(s.expression))
        unit.exports.set('default', s.expression.text);
      if (
        ts.isExpressionStatement(s) &&
        ts.isBinaryExpression(s.expression) &&
        ts.isIdentifier(s.expression.right) &&
        ts.isPropertyAccessExpression(s.expression.left)
      ) {
        const left = s.expression.left;
        if (left.getText() === 'module.exports')
          unit.exports.set('default', s.expression.right.text);
        else if (ts.isIdentifier(left.expression) && left.expression.text === 'exports')
          unit.exports.set(left.name.text, s.expression.right.text);
      }
      if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause))
        for (const b of s.exportClause.elements)
          unit.exports.set(b.name.text, (b.propertyName ?? b.name).text);
    }
    const nestBindings = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = ts.isAwaitExpression(n.initializer) ? n.initializer.expression : n.initializer;
        if (
          ts.isCallExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          ts.isIdentifier(init.expression.expression) &&
          unit.nestFactories.has(init.expression.expression.text) &&
          init.expression.name.text === 'create'
        ) {
          unit.nestApps.add(n.name.text);
          const instances = nestInstances.get(unit.root) ?? new Set<string>();
          instances.add(moduleKey(file.path, n.name.text));
          nestInstances.set(unit.root, instances);
        }
      }
      ts.forEachChild(n, nestBindings);
    };
    nestBindings(source);
    for (const [name, value] of unit.constants) {
      if (!ts.isCallExpression(value)) continue;
      const fn = value.expression;
      const app = ts.isIdentifier(fn) && unit.express.has(fn.text);
      const router =
        (ts.isIdentifier(fn) && unit.routerFactories.has(fn.text)) ||
        (ts.isPropertyAccessExpression(fn) &&
          ts.isIdentifier(fn.expression) &&
          unit.express.has(fn.expression.text) &&
          fn.name.text === 'Router');
      if (app || router)
        routers.set(moduleKey(file.path, name), {
          key: moduleKey(file.path, name),
          file: file.path,
          name,
          root: unit.root,
          app,
          prefix: '',
          origins: [],
        });
      if (
        ts.isPropertyAccessExpression(fn) &&
        ts.isIdentifier(fn.expression) &&
        unit.axios.has(fn.expression.text) &&
        fn.name.text === 'create'
      ) {
        const baseNode = property(value.arguments[0], 'baseURL');
        unit.clients.set(name, {
          base: baseNode ? staticString(baseNode, unit) : '',
          dynamic: !!baseNode && staticString(baseNode, unit) === null,
        });
      }
    }
  }
  const resolveReceiver = (unit: TsUnit, name: string): string => {
    const imp = unit.imports.get(name),
      imported = imp ? units.get(imp.path) : undefined;
    return imp && imported
      ? moduleKey(imp.path, imported.exports.get(imp.exported) ?? imp.exported)
      : moduleKey(unit.file.path, name);
  };
  // Imported axios instances reuse the declaration's baseURL, without loading modules.
  for (const unit of units.values())
    for (const [name, imp] of unit.imports) {
      const target = units.get(imp.path);
      const client = target?.clients.get(target.exports.get(imp.exported) ?? imp.exported);
      if (client) unit.clients.set(name, client);
    }
  for (const unit of units.values()) {
    const counters = new Map<string, number>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const access = node.expression,
          receiver = access.expression,
          verb = access.name.text;
        let baseReceiver: ts.Expression = receiver,
          chainPath: ts.Expression | undefined;
        while (
          ts.isCallExpression(baseReceiver) &&
          ts.isPropertyAccessExpression(baseReceiver.expression)
        ) {
          if (baseReceiver.expression.name.text === 'route') {
            chainPath = baseReceiver.arguments[0];
            baseReceiver = baseReceiver.expression.expression;
            break;
          }
          baseReceiver = baseReceiver.expression.expression;
        }
        const name = ts.isIdentifier(baseReceiver) ? baseReceiver.text : null;
        const routerKey = name ? resolveReceiver(unit, name) : '';
        const router = routers.get(routerKey);
        if (name && !shadowed(node, name) && router) {
          const ref = sourceRef(unit, node, enclosingSymbol(node));
          const ev: ApiEvidence = {
            kind: 'router_decl',
            sourceRef: ref,
            detail: node.getText().slice(0, 300),
            confidence: 1,
            key: '',
          };
          if (verb === 'use') {
            const first = node.arguments[0];
            const hasPrefix =
              first && (!ts.isIdentifier(first) || !routers.has(resolveReceiver(unit, first.text)));
            const prefix = hasPrefix ? staticString(first, unit) : '';
            for (const child of node.arguments.slice(hasPrefix ? 1 : 0))
              if (ts.isIdentifier(child) && routers.has(resolveReceiver(unit, child.text)))
                mounts.push({
                  parent: routerKey,
                  child: resolveReceiver(unit, child.text),
                  prefix,
                  evidence: {
                    ...ev,
                    kind: 'configuration',
                    key: `mount:${unit.file.path}:${name}:${child.text}`,
                  },
                });
          } else if (verb === 'listen') {
            const portArg = node.arguments[0];
            const port =
              portArg && ts.isNumericLiteral(portArg) ? portArg.text : staticString(portArg, unit);
            if (router.app && port && /^\d+$/.test(port))
              router.origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
          } else if (METHODS.has(verb.toUpperCase())) {
            const handler = node.arguments.at(-1);
            const symbol = handler && ts.isIdentifier(handler) ? handler.text : `${name}.${verb}`;
            const key = `${unit.file.path}#${name}:${verb}:${symbol}`;
            const ordinal = counters.get(key) ?? 0;
            counters.set(key, ordinal + 1);
            ev.key = `${key}:${ordinal}`;
            ev.sourceRef.symbol = symbol;
            const details = handlerDetails(unit, handler),
              pathNode = chainPath ?? node.arguments[0];
            routes.push({
              receiver: routerKey,
              method: verb.toUpperCase() as HttpMethod,
              path: staticString(pathNode, unit),
              expression: pathNode?.getText() ?? '',
              title: symbol,
              evidence: ev,
              parameters: details.parameters.length ? details.parameters : null,
              response: details.response.length ? details.response : null,
              auth: node.arguments
                .slice(chainPath ? 0 : 1, -1)
                .filter((a) => /auth|guard|permission/i.test(a.getText()))
                .map((a) => a.getText()),
              implementation: details.implementation,
            });
          }
        }
        if (name && unit.nestApps.has(name) && verb === 'setGlobalPrefix')
          globals.set(
            unit.root,
            node.arguments.length > 1 ? null : staticString(node.arguments[0], unit),
          );
        if (name && unit.nestApps.has(name) && verb === 'listen') {
          const port = node.arguments[0];
          if (port && ts.isNumericLiteral(port))
            nestOrigins.set(unit.root, [
              `http://localhost:${port.text}`,
              `http://127.0.0.1:${port.text}`,
            ]);
        }
        if (
          verb === 'fetch' &&
          ts.isIdentifier(receiver) &&
          ['window', 'globalThis'].includes(receiver.text) &&
          !shadowed(node, receiver.text) &&
          !unit.localNames.has(receiver.text)
        ) {
          const methodNode = property(node.arguments[1], 'method');
          const method = methodNode
            ? (staticString(methodNode, unit)?.toUpperCase() ?? null)
            : 'GET';
          addCall(
            unit,
            node,
            node.arguments[0],
            method && METHODS.has(method) ? (method as HttpMethod) : null,
            '',
            false,
          );
        }
        if (
          name &&
          ts.isIdentifier(receiver) &&
          !shadowed(node, name) &&
          (unit.axios.has(name) || unit.clients.has(name)) &&
          (METHODS.has(verb.toUpperCase()) || verb === 'request')
        ) {
          const options = verb === 'request' ? node.arguments[0] : node.arguments[1];
          const url = verb === 'request' ? property(options, 'url') : node.arguments[0];
          const method =
            verb === 'request'
              ? (staticString(property(options, 'method'), unit)?.toUpperCase() ?? 'GET')
              : verb.toUpperCase();
          const localBase = property(options, 'baseURL');
          const client = unit.clients.get(name);
          addCall(
            unit,
            node,
            url,
            METHODS.has(method) ? (method as HttpMethod) : null,
            localBase ? staticString(localBase, unit) : (client?.base ?? ''),
            (!!localBase && staticString(localBase, unit) === null) || (client?.dynamic ?? false),
          );
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (name === 'fetch' && !shadowed(node, name) && !unit.localNames.has(name)) {
          const methodNode = property(node.arguments[1], 'method');
          const method = methodNode
            ? (staticString(methodNode, unit)?.toUpperCase() ?? null)
            : 'GET';
          addCall(
            unit,
            node,
            node.arguments[0],
            method && METHODS.has(method) ? (method as HttpMethod) : null,
            '',
            false,
          );
        }
        if (!shadowed(node, name) && (unit.axios.has(name) || unit.clients.has(name))) {
          const obj = asObject(node.arguments[0]);
          const url = obj ? property(obj, 'url') : node.arguments[0];
          const methodNode =
            property(obj ?? undefined, 'method') ?? property(node.arguments[1], 'method');
          const method = methodNode
            ? (staticString(methodNode, unit)?.toUpperCase() ?? null)
            : 'GET';
          addCall(
            unit,
            node,
            url,
            method && METHODS.has(method) ? (method as HttpMethod) : null,
            unit.clients.get(name)?.base ?? '',
            unit.clients.get(name)?.dynamic ?? false,
          );
        }
      }
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText().replace(/['"]/g, '') === 'proxy' &&
        asObject(node.initializer)
      ) {
        for (const p of (node.initializer as ts.ObjectLiteralExpression).properties)
          if (ts.isPropertyAssignment(p)) {
            const prefix = p.name.getText().replace(/['"]/g, '');
            if (prefix.startsWith('/'))
              proxies.push({
                root: unit.root,
                prefix,
                target: staticString(property(p.initializer, 'target') ?? p.initializer, unit),
                rewritten: !!property(p.initializer, 'rewrite'),
                ref: sourceRef(unit, p),
              });
          }
      }
      if (ts.isClassDeclaration(node)) {
        const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
        const controller = decorators
          .map((d) => d.expression)
          .find(
            (e) =>
              ts.isCallExpression(e) &&
              ts.isIdentifier(e.expression) &&
              unit.nest.get(e.expression.text) === 'Controller',
          );
        if (controller && ts.isCallExpression(controller)) {
          const prefix = controller.arguments.length
            ? staticString(controller.arguments[0], unit)
            : '';
          const key = `nest:${unit.root}`;
          routers.set(key, {
            key,
            file: unit.file.path,
            name: 'Nest',
            root: unit.root,
            app: true,
            prefix: globals.has(unit.root) ? globals.get(unit.root)! : '',
            origins: [],
          });
          for (const member of node.members)
            if (ts.isMethodDeclaration(member)) {
              const decorators = ts.getDecorators(member) ?? [];
              for (const d of decorators)
                if (ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression)) {
                  const method = unit.nest.get(d.expression.expression.text)?.toUpperCase();
                  if (!method || !METHODS.has(method)) continue;
                  const local = d.expression.arguments.length
                    ? staticString(d.expression.arguments[0], unit)
                    : '';
                  const symbol = `${node.name?.text ?? 'Controller'}.${member.name.getText()}`;
                  const ev: ApiEvidence = {
                    kind: 'router_decl',
                    sourceRef: sourceRef(unit, member, symbol),
                    detail: d.getText(),
                    confidence: 1,
                    key: `${unit.file.path}#${symbol}:${method}`,
                  };
                  const impl: SourceRef[] = [];
                  const collect = (n: ts.Node): void => {
                    if (
                      ts.isCallExpression(n) &&
                      ts.isPropertyAccessExpression(n.expression) &&
                      /service/i.test(n.expression.expression.getText())
                    )
                      impl.push(sourceRef(unit, n, n.expression.getText()));
                    ts.forEachChild(n, collect);
                  };
                  if (member.body) collect(member.body);
                  routes.push({
                    receiver: key,
                    method: method as HttpMethod,
                    path: prefix === null || local === null ? null : joinPath(prefix, local),
                    expression: d.getText(),
                    title: symbol,
                    evidence: ev,
                    parameters: member.parameters.map((p) => p.getText()),
                    response: member.type?.getText() ?? null,
                    auth: [...decorators, ...decoratorsOf(node)]
                      .filter((d) => /Guard|Auth|Permission/.test(d.getText()))
                      .map((d) => d.getText()),
                    implementation: impl,
                  });
                }
            }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(unit.source);
  }
  function addCall(
    unit: TsUnit,
    node: ts.CallExpression,
    url: ts.Expression | undefined,
    method: HttpMethod | null,
    base: string | null,
    baseDynamic: boolean,
  ): void {
    const literal = staticString(url, unit),
      symbolic = symbolicString(url, unit);
    let value = literal ?? symbolic;
    const absolute = value !== null && /^(https?:)?\/\//.test(value);
    if (value !== null && !absolute && base)
      value = base.replace(/\/$/, '') + '/' + value.replace(/^\//, '');
    let origin: string | null = null,
      path: string | null = value;
    if (value && /^(https?:)?\/\//.test(value)) {
      try {
        const parsed = new URL(value.startsWith('//') ? 'https:' + value : value);
        origin = parsed.origin;
        path = parsed.pathname;
      } catch {
        path = null;
      }
    }
    const ref = sourceRef(unit, node, enclosingSymbol(node));
    const signature = `${unit.file.path}#${ref.symbol}:call`;
    const ordinal = calls.filter((c) => c.key.startsWith(signature + ':')).length;
    calls.push({
      key: `${signature}:${ordinal}`,
      method,
      expression: redactText(node.getText().slice(0, 500)),
      path: path ? normalizePathTemplate(path) : null,
      origin,
      serviceHint: null,
      sourceRef: ref,
      dynamic: literal === null || method === null || (!absolute && baseDynamic),
      reason:
        literal === null || (!absolute && baseDynamic) || method === null
          ? '动态 URL、方法或 baseURL 无法静态确定'
          : null,
    });
  }
  // Python uses the existing comment/string-aware tokenizer, never a Python process.
  scanPython(files, roots, routers, mounts, routes, warnings);
  for (const router of routers.values())
    if (router.key.startsWith('nest:')) {
      const ambiguous = (nestInstances.get(router.root)?.size ?? 0) > 1;
      router.prefix = ambiguous ? null : globals.has(router.root) ? globals.get(router.root)! : '';
      router.origins = ambiguous ? [] : (nestOrigins.get(router.root) ?? []);
      if (ambiguous)
        warnings.push(`${router.root || '根工程'} 存在多个 Nest 运行实例，Controller 归属待确认`);
    }
  const services: ApiService[] = [...routers.values()]
    .filter((r) => r.app)
    .map((r) => ({
      serviceId: `service:${r.key}`,
      name: r.root || r.file,
      root: r.root,
      origins: r.origins,
    }));
  const serviceByKey = new Map(
    [...routers.values()].filter((r) => r.app).map((r) => [r.key, `service:${r.key}`]),
  );
  const mountedPaths = (
    key: string,
    seen = new Set<string>(),
  ): Array<{ serviceId: string; prefix: string | null; evidence: ApiEvidence[] }> => {
    if (seen.has(key)) return [];
    const next = new Set([...seen, key]),
      router = routers.get(key);
    if (!router) return [];
    if (router.app)
      return [{ serviceId: serviceByKey.get(key)!, prefix: router.prefix, evidence: [] }];
    return mounts
      .filter((m) => m.child === key)
      .flatMap((m) =>
        mountedPaths(m.parent, next).map((parent) => ({
          serviceId: parent.serviceId,
          prefix:
            parent.prefix === null || m.prefix === null || router.prefix === null
              ? null
              : joinPath(parent.prefix, m.prefix, router.prefix),
          evidence: [...parent.evidence, m.evidence],
        })),
      );
  };
  const endpoints: ApiEndpointDraft[] = [];
  for (const route of routes) {
    const contexts = mountedPaths(route.receiver);
    if (!contexts.length)
      contexts.push({ serviceId: `unmounted:${route.receiver}`, prefix: null, evidence: [] });
    for (const context of contexts) {
      const path =
        route.path === null || context.prefix === null
          ? null
          : joinPath(context.prefix, route.path);
      const unresolved = path === null;
      const rawPath = path ?? `/__unresolved__/${encodeURIComponent(route.evidence.key)}`;
      endpoints.push({
        serviceId: context.serviceId,
        method: route.method,
        rawPath,
        normalizedPath: normalizePathTemplate(rawPath),
        title: route.title,
        tags: [],
        evidence: [route.evidence, ...context.evidence],
        parameters: route.parameters,
        response: route.response,
        authentication: route.auth,
        implementation: route.implementation,
        tests: [],
        documents: [],
        status: unresolved ? 'pending_confirmation' : 'active',
        modifiedAt:
          files.find((f) => f.path === route.evidence.sourceRef.filePath)?.modifiedAt ?? null,
      });
      if (unresolved)
        warnings.push(
          `${route.evidence.sourceRef.filePath}:${route.evidence.sourceRef.startLine} 路径/挂载未解析：${route.expression}`,
        );
    }
  }
  if (parseContract)
    for (const file of files.filter(
      (f) => /\.(json|ya?ml)$/.test(f.path) && /["']?openapi["']?\s*:/.test(f.content),
    )) {
      try {
        const spec = parseContract(file.content),
          root = rootOf(file.path, roots);
        const localServices = services.filter((s) => s.root === root);
        for (const route of spec.routes) {
          if (!METHODS.has(route.method.toUpperCase())) continue;
          const servers = route.servers?.length
            ? route.servers
            : spec.servers?.length
              ? spec.servers
              : [''];
          for (const server of [...new Set(servers)]) {
            let prefix: string | null = '',
              origin: string | null = null;
            try {
              const parsed = new URL(server || '/', 'http://local.invalid');
              prefix = /\{/.test(server) ? null : parsed.pathname;
              origin = parsed.origin === 'http://local.invalid' ? null : parsed.origin;
            } catch {
              prefix = null;
            }
            const originMatches = origin
              ? services.filter((s) => s.origins.includes(origin!))
              : localServices;
            const matched = originMatches.length === 1 ? originMatches[0]! : null;
            const serviceId =
              matched?.serviceId ?? `contract:${file.path}${origin ? '#' + origin : ''}`;
            if (!services.some((s) => s.serviceId === serviceId))
              services.push({
                serviceId,
                name: file.path + (origin ? ' · ' + origin : ''),
                root,
                origins: origin ? [origin] : [],
              });
            const path = prefix === null ? route.path : joinPath(prefix, route.path);
            const ev: ApiEvidence = {
              kind: 'openapi',
              sourceRef: {
                filePath: file.path,
                startLine: null,
                endLine: null,
                symbol: route.operationId,
              },
              detail: `${route.method} ${route.path} · server ${server || '相对路径'}`,
              confidence: prefix === null ? null : 1,
              key: `${file.path}#operation:${route.operationId ?? `${route.method}:${route.path}`}`,
            };
            endpoints.push({
              serviceId,
              method: route.method.toUpperCase() as HttpMethod,
              rawPath: path,
              normalizedPath:
                prefix === null
                  ? `/__unresolved__/${encodeURIComponent(ev.key)}`
                  : normalizePathTemplate(path),
              title: route.summary ?? route.operationId ?? path,
              tags: route.tags,
              evidence: [ev],
              parameters: { parameters: route.parameters ?? null, body: route.requestSchema },
              response: route.responseSchema,
              authentication:
                route.authentication === undefined || route.authentication === null
                  ? []
                  : [JSON.stringify(route.authentication)],
              implementation: [],
              tests: [],
              documents: [ev.sourceRef],
              status:
                prefix === null || (!origin && localServices.length > 1)
                  ? 'pending_confirmation'
                  : 'active',
              modifiedAt: file.modifiedAt,
            });
          }
        }
        warnings.push(...spec.warnings);
      } catch (error) {
        complete = false;
        warnings.push(
          `${file.path} 契约解析失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  // Local proxy declarations provide service evidence; rewrite functions stay unresolved.
  for (const call of calls.filter((c) => !c.origin && c.path)) {
    const root = rootOf(call.sourceRef.filePath, roots);
    const matching = proxies.filter(
      (p) => p.root === root && (call.path === p.prefix || call.path!.startsWith(p.prefix + '/')),
    );
    if (matching.length > 1) {
      call.dynamic = true;
      call.reason = '多个代理候选，待确认';
    } else if (matching.length === 1) {
      const proxy = matching[0]!;
      if (proxy.rewritten || !proxy.target) {
        call.dynamic = true;
        call.reason = '代理 rewrite/target 未解析，待确认';
      } else {
        try {
          const target = new URL(proxy.target),
            matches = services.filter((s) => s.origins.includes(target.origin));
          call.origin = target.origin;
          call.path = joinPath(target.pathname, call.path!);
          call.serviceHint = matches.length === 1 ? matches[0]!.serviceId : null;
        } catch {
          call.dynamic = true;
          call.reason = '代理 target 未解析，待确认';
        }
      }
    }
  }
  const merged = new Map<string, ApiEndpointDraft>();
  for (const e of endpoints) {
    const key = apiRouteKeyOf(e),
      previous = merged.get(key);
    if (!previous) {
      merged.set(key, e);
      continue;
    }
    previous.evidence.push(...e.evidence);
    previous.tags = [...new Set([...previous.tags, ...e.tags])];
    previous.documents.push(...e.documents);
    previous.implementation.push(...e.implementation);
    if (e.evidence.some((v) => v.kind === 'openapi')) {
      previous.title = e.title;
      previous.parameters = e.parameters;
      previous.response = e.response;
      previous.authentication = [...new Set([...previous.authentication, ...e.authentication])];
    }
    previous.modifiedAt = Math.max(previous.modifiedAt ?? 0, e.modifiedAt ?? 0) || null;
  }
  // References are suggestions with source locations, never asserted test coverage.
  for (const endpoint of merged.values())
    for (const file of files.filter((f) =>
      /\.(test|spec)\.[jt]sx?$|(^|\/)test_.*\.py$|_test\.py$|\.md$/.test(f.path),
    )) {
      const line = file.content
        .split('\n')
        .findIndex(
          (l) =>
            l.includes(endpoint.rawPath) ||
            (endpoint.title.length > 3 && l.includes(endpoint.title)),
        );
      if (line < 0) continue;
      const ref: SourceRef = {
        filePath: file.path,
        startLine: line + 1,
        endLine: line + 1,
        symbol: null,
      };
      if (file.path.endsWith('.md')) endpoint.documents.push(ref);
      else endpoint.tests.push(ref);
    }
  return {
    endpoints: [...merged.values()],
    calls,
    services,
    warnings: [...new Set(warnings)],
    complete,
  };
}

function decoratorsOf(node: ts.ClassDeclaration): readonly ts.Decorator[] {
  return ts.getDecorators(node) ?? [];
}

function scanPython(
  files: readonly ApiSourceFile[],
  roots: string[],
  routers: Map<string, RouterNode>,
  mounts: Mount[],
  routes: Route[],
  warnings: string[],
): void {
  // Normalize the shared tokenizer's grouped punctuation into individual tokens.
  const units = files
    .filter((f) => f.path.endsWith('.py') && !/(^|\/)test_|_test\.py$/.test(f.path))
    .map((file) => ({
      file,
      tokens: tokenizePython(file.content).flatMap((t) =>
        t.type === 'op' ? [...t.value].map((v, i) => ({ ...t, value: v, col: t.col + i })) : [t],
      ),
      aliases: new Map<string, string>(),
      imports: new Map<string, string>(),
    }));
  for (const unit of units) {
    const { tokens: t, file, aliases, imports } = unit;
    for (let i = 0; i < t.length; i++) {
      if (t[i]?.value === 'from') {
        let j = i + 1,
          spec = '';
        while (t[j] && t[j]!.value !== 'import' && t[j]!.type !== 'nl') spec += t[j++]!.value;
        j++;
        while (t[j] && t[j]!.type !== 'nl') {
          const exported = t[j++]!.value;
          if (exported === ',') continue;
          const name = t[j]?.value === 'as' ? ((j += 2), t[j - 1]!.value) : exported;
          if (spec === 'fastapi') aliases.set(name, exported);
          else {
            const base = spec.startsWith('.')
              ? dirname(file.path) + '/' + spec.replace(/^\./, '').replace(/\./g, '/')
              : spec.replace(/\./g, '/');
            const target = [
              base.replace(/\/+/g, '/') + '.py',
              base.replace(/\/+/g, '/') + '/__init__.py',
              rootOf(file.path, roots) + '/' + base + '.py',
            ].find((p) => files.some((f) => f.path === p));
            if (target) imports.set(name, moduleKey(target, exported));
          }
        }
      }
      if (
        t[i]?.type === 'name' &&
        t[i + 1]?.value === '=' &&
        t[i + 2]?.type === 'name' &&
        ['FastAPI', 'APIRouter'].includes(aliases.get(t[i + 2]!.value) ?? '') &&
        t[i + 3]?.value === '('
      ) {
        const name = t[i]!.value,
          app = aliases.get(t[i + 2]!.value) === 'FastAPI';
        let prefix: string | null = t[i]!.col === 1 ? '' : null;
        for (let j = i + 4; t[j] && t[j]!.value !== ')'; j++)
          if (t[j]!.value === 'prefix' && t[j + 1]?.value === '=')
            prefix = t[j + 2]?.type === 'string' ? t[j + 2]!.value : null;
        routers.set(moduleKey(file.path, name), {
          key: moduleKey(file.path, name),
          file: file.path,
          name,
          root: rootOf(file.path, roots),
          app,
          prefix,
          origins: [],
        });
      }
    }
  }
  for (const { file, tokens: t, imports } of units) {
    const receiverKey = (name: string): string => imports.get(name) ?? moduleKey(file.path, name);
    for (let i = 0; i < t.length; i++) {
      const receiver = t[i]?.value,
        verb = t[i + 2]?.value;
      if (
        !receiver ||
        t[i + 1]?.value !== '.' ||
        t[i + 3]?.value !== '(' ||
        !routers.has(receiverKey(receiver))
      )
        continue;
      const startLine = t[i]!.line;
      const ref: SourceRef = { filePath: file.path, startLine, endLine: startLine, symbol: null };
      if (verb === 'include_router') {
        const child = t[i + 4]?.value;
        let prefix: string | null = '';
        for (let j = i + 5; t[j] && t[j]!.value !== ')'; j++)
          if (t[j]!.value === 'prefix' && t[j + 1]?.value === '=')
            prefix = t[j + 2]?.type === 'string' ? t[j + 2]!.value : null;
        if (child && routers.has(receiverKey(child)))
          mounts.push({
            parent: receiverKey(receiver),
            child: receiverKey(child),
            prefix,
            evidence: {
              kind: 'configuration',
              sourceRef: ref,
              detail: 'FastAPI include_router',
              confidence: prefix === null ? null : 1,
              key: `${file.path}#mount:${receiver}:${child}`,
            },
          });
      } else if (verb && METHODS.has(verb.toUpperCase()) && t[i - 1]?.value === '@') {
        let literal =
          t[i - 1]?.col === 1 && t[i + 4]?.type === 'string' && t[i + 5]?.value !== '+'
            ? t[i + 4]!.value
            : null;
        let j = i + 4;
        while (t[j]) {
          if (
            t[j]!.line > startLine &&
            t[j]!.col === 1 &&
            t[j]!.value !== '@' &&
            t[j]!.value !== 'async'
          )
            break;
          if (t[j]!.value === 'def' && t[j]!.line > startLine) break;
          j++;
        }
        if (t[j]?.value !== 'def') literal = null;
        const symbol = t[j + 1]?.type === 'name' ? t[j + 1]!.value : `${receiver}.${verb}`;
        ref.symbol = symbol;
        ref.endLine = t[j]?.line ?? startLine;
        const declaration = file.content
          .split('\n')
          .slice(startLine - 1, ref.endLine)
          .join('\n');
        routes.push({
          receiver: receiverKey(receiver),
          method: verb.toUpperCase() as HttpMethod,
          path: literal,
          expression: declaration,
          title: symbol,
          evidence: {
            kind: 'router_decl',
            sourceRef: ref,
            detail: 'FastAPI 显式路由；内置词法/缩进解析（非 Python AST）',
            confidence: 0.9,
            key: `${file.path}#${symbol}:${verb}`,
          },
          parameters: declaration,
          response: null,
          auth: /Depends|Security/.test(declaration) ? [declaration] : [],
          implementation: [],
        });
      }
    }
  }
  if (units.length)
    warnings.push(
      'FastAPI 使用已有内置词法/缩进解析器；工厂、动态注册和 Python 元编程需人工确认。',
    );
}

/** Exact method/path evidence can still have several service candidates. */
export function candidateRoutes<T extends ApiEndpointDraft>(
  call: ApiCallDraft,
  endpoints: readonly T[],
  services: readonly ApiService[],
): T[] {
  if (!call.path || !call.method) return [];
  const originServices = call.origin
    ? services.filter((s) => s.origins.includes(call.origin!)).map((s) => s.serviceId)
    : [];
  return endpoints.filter(
    (e) =>
      e.status === 'active' &&
      e.method === call.method &&
      (!call.serviceHint || e.serviceId === call.serviceHint) &&
      (!call.origin || originServices.includes(e.serviceId)) &&
      pathMatches(e.normalizedPath, call.path!),
  );
}
function pathMatches(template: string, path: string): boolean {
  const a = template.split('/'),
    b = normalizePathTemplate(path).split('/');
  return a.length === b.length && a.every((seg, i) => seg === b[i] || /^\{[^}]+\}$/.test(seg));
}
