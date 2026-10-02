import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, relative, resolve } from 'node:path';
import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5';
import { parse as parseVue, type TemplateChildNode } from '@vue/compiler-dom';
import ts from 'typescript';
import type { MappingKind, SourceRef, SourceRevision } from '@ec/core';
import type { DomSession } from './contracts';
import { domSelectorScript } from './selector';

export interface SourceEvidence {
  token: string;
  tag: string;
  sourceRef: SourceRef;
  sourceRevision: SourceRevision;
  mappingKind: MappingKind;
  startColumn: number;
  endColumn: number;
}
export const sourceHash = (source: string): string =>
  `sha256:${createHash('sha256').update(source).digest('hex')}`;
const prohibited = /(?:^|\/)(?:node_modules|dist|build|out|\.git|\.output)(?:\/|$)/;

/** The registry belongs to one runtime. Tokens carry no paths and are never resolved by selector/id heuristics. */
export class DomSourceRegistry {
  private readonly entries = new Map<string, SourceEvidence>();
  private readonly files = new Map<string, string[]>();

  get(token: string): SourceEvidence | null {
    return this.entries.get(token) ?? null;
  }
  clear(): void {
    this.entries.clear();
    this.files.clear();
  }
  instrument(
    source: string,
    filePath: string,
    kind: 'static_html' | 'react_compiled' | 'vue_compiled',
  ): string {
    if (
      !filePath ||
      filePath.includes('\\') ||
      filePath.startsWith('/') ||
      filePath.split('/').includes('..') ||
      /^[a-z]:/i.test(filePath) ||
      prohibited.test(filePath)
    )
      return source;
    // Re-serving identical source retains tokens. An HMR revision invalidates all old tokens.
    const hash = sourceHash(source);
    const old = this.files.get(filePath) ?? [];
    if (old.length && this.entries.get(old[0]!)?.sourceRevision.contentHash === hash)
      return this.transform(source, filePath, kind, old);
    for (const token of old) this.entries.delete(token);
    this.files.set(filePath, []);
    return this.transform(source, filePath, kind);
  }
  private transform(
    source: string,
    filePath: string,
    kind: SourceEvidence['mappingKind'],
    reuse?: string[],
  ): string {
    const contentHash = sourceHash(source);
    const edits: Array<{ offset: number; text: string }> = [];
    let index = 0;
    const register = (
      tag: string,
      start: number,
      end: number,
      offset: number,
      symbol: string | null,
    ): void => {
      const token = reuse?.[index++] ?? randomUUID();
      const startText = source.slice(0, start).split('\n');
      const endText = source.slice(0, end).split('\n');
      const entry: SourceEvidence = {
        token,
        tag,
        sourceRef: { filePath, startLine: startText.length, endLine: endText.length, symbol },
        sourceRevision: { gitCommit: null, contentHash },
        mappingKind: kind,
        startColumn: (startText.at(-1)?.length ?? 0) + 1,
        endColumn: (endText.at(-1)?.length ?? 0) + 1,
      };
      this.entries.set(token, entry);
      if (!reuse) this.files.get(filePath)!.push(token);
      edits.push({ offset, text: ` data-ec-source="${token}"` });
    };
    if (kind === 'react_compiled') {
      const ast = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node, symbol: string | null): void => {
        if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
          symbol = node.name.text;
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) symbol = node.name.text;
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(ast);
          // Component invocations, spreads and reserved attrs can overwrite or forward metadata: unresolved.
          if (
            /^[a-z][a-zA-Z0-9-]*$/.test(tag) &&
            !node.attributes.properties.some(
              (p) =>
                ts.isJsxSpreadAttribute(p) ||
                p.name.getText(ast).toLowerCase() === 'data-ec-source',
            )
          ) {
            const parent = ts.isJsxElement(node.parent) ? node.parent : node;
            register(tag, node.getStart(ast), parent.getEnd(), node.tagName.getEnd(), symbol);
          }
        }
        ts.forEachChild(node, (child) => visit(child, symbol));
      };
      visit(ast, null);
    } else if (kind === 'vue_compiled') {
      let ast: ReturnType<typeof parseVue>;
      try {
        ast = parseVue(source, { parseMode: 'sfc' });
      } catch {
        return source;
      }
      const template = ast.children.find((node) => node.type === 1 && node.tag === 'template');
      if (
        !template ||
        template.type !== 1 ||
        template.props.some((prop) => prop.type === 6 && ['lang', 'src'].includes(prop.name))
      )
        return source;
      // Vue's SFC parse mode retains original source offsets, interpolation and directives.
      const walk = (node: TemplateChildNode): void => {
        if (node.type !== 1) return;
        if (
          node.tagType === 0 &&
          !node.props.some((p) =>
            p.type === 6
              ? p.name === 'data-ec-source'
              : p.name === 'bind' &&
                (!p.arg ||
                  p.arg.type !== 4 ||
                  !p.arg.isStatic ||
                  p.arg.content === 'data-ec-source'),
          )
        ) {
          const start = node.loc.start.offset;
          const end = node.loc.end.offset;
          register(node.tag, start, end, start + 1 + node.tag.length, basename(filePath, '.vue'));
        }
        for (const child of node.children) walk(child);
      };
      for (const child of template.children) walk(child);
    } else {
      const ast = parseHtml(source, { sourceCodeLocationInfo: true });
      const walk = (node: DefaultTreeAdapterMap['node']): void => {
        if ('tagName' in node) {
          const loc = node.sourceCodeLocation;
          if (
            loc?.startTag &&
            !node.attrs.some((a) => a.name === 'data-ec-source') &&
            !['script', 'style', 'template'].includes(node.tagName)
          )
            register(
              node.tagName,
              loc.startOffset,
              loc.endOffset,
              loc.startOffset + 1 + node.tagName.length,
              null,
            );
          // Template contents are inert; cloning them at runtime cannot prove an instance source mapping.
          if (node.tagName === 'template') return;
        }
        if ('childNodes' in node) for (const child of node.childNodes) walk(child);
      };
      walk(ast);
    }
    for (const edit of edits.sort((a, b) => b.offset - a.offset))
      source = source.slice(0, edit.offset) + edit.text + source.slice(edit.offset);
    return source;
  }
}

export function injectDomSelector(html: string, session: DomSession): string {
  const script = `<script>${domSelectorScript(session).replace(/<\/script/gi, '<\\/script')}</script>`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const offset = doctype?.[0].length ?? 0;
  return html.slice(0, offset) + script + html.slice(offset);
}

/** Host-controlled Vite adapter: only local serve, enforced pre-transform, never build/config files. */
export function createDomInspectionPlugin(options: {
  root: string;
  registry: DomSourceRegistry;
  session: DomSession;
}) {
  return {
    name: 'ec-local-dom-inspection',
    apply: 'serve' as const,
    enforce: 'pre' as const,
    configureServer(server: {
      middlewares: {
        use: (
          handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void,
        ) => void;
      };
    }) {
      server.middlewares.use((req, res, next) => {
        // An opaque sandbox must be able to import local modules. Grant only GET code assets,
        // never API/JSON requests, arbitrary origins or a global Vite CORS override.
        const path = req.url?.split('?')[0] ?? '';
        if (
          req.method === 'GET' &&
          req.headers.origin === 'null' &&
          !/^\/api(?:\/|$)/.test(path) &&
          (path === '/@vite/client' ||
            path === '/@react-refresh' ||
            path === '/@id/__x00__plugin-vue:export-helper' ||
            /\.(?:[cm]?[jt]sx?|vue|css)$/.test(path))
        )
          res.setHeader('Access-Control-Allow-Origin', 'null');
        next();
      });
    },
    transform(code: string, id: string) {
      if (id.includes('?')) return null;
      const path = relative(resolve(options.root), resolve(id)).replace(/\\/g, '/');
      if (path.startsWith('../') || prohibited.test(path)) return null;
      const kind = /\.[jt]sx$/.test(path)
        ? 'react_compiled'
        : /\.vue$/.test(path)
          ? 'vue_compiled'
          : null;
      return kind ? { code: options.registry.instrument(code, path, kind), map: null } : null;
    },
    transformIndexHtml: {
      order: 'pre' as const,
      handler: (html: string) =>
        injectDomSelector(
          options.registry.instrument(html, 'index.html', 'static_html'),
          options.session,
        ),
    },
  };
}
