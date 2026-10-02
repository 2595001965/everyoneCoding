import { describe, expect, it } from 'vitest';
import {
  DomSourceRegistry,
  createDomInspectionPlugin,
  injectDomSelector,
  sourceHash,
} from '../dom/source-mapping';
import { domSelectionSchema, readDomEvent } from '../dom/contracts';

const session = {
  projectId: 'p-1',
  runtimeId: 'run-1',
  nonce: 'nonce-1',
  parentOrigin: 'http://localhost:5173',
};
const tokenOf = (source: string): string => /data-ec-source="([^"]+)"/.exec(source)![1]!;
describe('D03 compiled source evidence', () => {
  it('maps original HTML offsets, preserves disk content and rotates tokens on revision', () => {
    const registry = new DomSourceRegistry();
    const source = '<!doctype html>\n<html><body>\n<button>保存</button>\n</body></html>';
    const output = registry.instrument(source, 'index.html', 'static_html');
    const button = [...output.matchAll(/<button data-ec-source="([^"]+)"/g)][0]![1]!;
    expect(registry.get(button)).toMatchObject({
      tag: 'button',
      sourceRef: { filePath: 'index.html', startLine: 3 },
      startColumn: 1,
      sourceRevision: { contentHash: sourceHash(source) },
    });
    expect(registry.instrument(source, 'index.html', 'static_html')).toBe(output);
    const next = registry.instrument('\n' + source, 'index.html', 'static_html');
    expect(next).not.toBe(output);
    expect(registry.get(button)).toBeNull();
    expect(source).not.toContain('data-ec-source');
    expect(injectDomSelector(output, session).indexOf('ec-dom-v1')).toBeLessThan(
      injectDomSelector(output, session).indexOf('<button'),
    );
  });
  it('React maps native JSX into component definitions, without guessing component calls/spreads', () => {
    const registry = new DomSourceRegistry();
    const output = registry.instrument(
      'export function Shared(){\n return <button>删除</button>;\n}\nconst App=()=> <><Shared/><div {...props}/></>;',
      'src/Shared.tsx',
      'react_compiled',
    );
    expect(registry.get(tokenOf(output))).toMatchObject({
      sourceRef: { symbol: 'Shared', startLine: 2 },
      mappingKind: 'react_compiled',
    });
    expect(output).toContain('<Shared/>');
    expect(output).toContain('<div {...props}/>');
  });
  it('Vue parses v-for/v-if and interpolation using the actual SFC compiler', () => {
    const registry = new DomSourceRegistry();
    const source =
      '<script setup>const list=[1,2]</script>\n<template>\n<button v-for="i in list" v-if="list.length">{{ i }}</button>\n</template>';
    const output = registry.instrument(source, 'src/Shared.vue', 'vue_compiled');
    expect(output).toContain('data-ec-source');
    expect(registry.get(tokenOf(output))).toMatchObject({
      sourceRef: { filePath: 'src/Shared.vue', startLine: 3, symbol: 'Shared' },
      mappingKind: 'vue_compiled',
    });
  });
  it('ignores production artifacts, escapes and author-provided source metadata', () => {
    const registry = new DomSourceRegistry();
    for (const path of [
      'dist/index.html',
      'build/index.html',
      '../foreign.html',
      'C:/private.html',
    ])
      expect(registry.instrument('<button>x</button>', path, 'static_html')).toBe(
        '<button>x</button>',
      );
    expect(registry.get('generated-element-E1')).toBeNull();
    expect(
      registry.instrument(
        '<button data-ec-source="forged">x</button>',
        'index.html',
        'static_html',
      ),
    ).toContain('"forged"');
    expect(registry.get('forged')).toBeNull();
    const plugin = createDomInspectionPlugin({ root: '/local', registry, session });
    expect(plugin.apply).toBe('serve');
    expect(plugin.transform('const x=1', '/foreign/App.tsx')).toBeNull();
  });
  it('allows opaque-origin code imports only, without broadening API/JSON/other-origin CORS', () => {
    const plugin = createDomInspectionPlugin({
      root: '/local',
      registry: new DomSourceRegistry(),
      session,
    });
    let handler: any;
    plugin.configureServer({
      middlewares: {
        use: (value) => {
          handler = value;
        },
      },
    });
    const allowed: Array<[string, string, string]> = [];
    const run = (url: string, origin = 'null', method = 'GET') =>
      handler(
        { url, method, headers: { origin } },
        { setHeader: (name: string, value: string) => allowed.push([url, name, value]) },
        () => {},
      );
    run('/Shared.vue');
    run('/@id/__x00__plugin-vue:export-helper');
    expect(allowed).toHaveLength(2);
    run('/api/private.js');
    run('/secrets.json');
    run('/src/App.tsx', 'https://foreign.example');
    run('/src/App.tsx', 'null', 'POST');
    expect(allowed).toHaveLength(2);
    expect(allowed.every((entry) => entry[2] === 'null')).toBe(true);
  });
});

describe('D03 message boundary', () => {
  it('requires exact source + opaque origin + runtime + nonce + strict payload', () => {
    const source = {} as Window;
    const message = {
      channel: 'ec-dom-v1',
      projectId: session.projectId,
      runtimeId: session.runtimeId,
      nonce: session.nonce,
      documentId: 'doc-1',
      seq: 1,
      type: 'ready',
      payload: null,
    };
    const event = (data: unknown = message, origin = 'null', sender: Window = source) =>
      ({ data, origin, source: sender }) as MessageEvent;
    expect(readDomEvent(event(), source, session)?.type).toBe('ready');
    for (const data of [
      { ...message, nonce: 'foreign' },
      { ...message, runtimeId: 'foreign' },
      { ...message, projectId: 'foreign' },
      { ...message, payload: { value: 'password' } },
      { ...message, command: 'fs.readFile' },
      { type: 'element-click', payload: { elementId: 'E1' } },
    ])
      expect(readDomEvent(event(data), source, session)).toBeNull();
    expect(readDomEvent(event(message, 'http://localhost:4173'), source, session)).toBeNull();
    expect(readDomEvent(event(message, 'null', {} as Window), source, session)).toBeNull();
  });
  it('rejects source paths, current input values and unbounded/unusable snapshots', () => {
    const node = {
      nodeId: 'node-1',
      tag: 'button',
      name: '',
      id: null,
      classes: [],
      sourceToken: null,
      rect: { x: 0, y: 0, width: 10, height: 10 },
    };
    const selection = {
      node,
      ancestors: [],
      route: '/',
      documentId: 'doc-1',
      instanceIndex: 0,
      instanceCount: 1,
      boundary: 'dom',
    };
    expect(domSelectionSchema.safeParse(selection).success).toBe(true);
    for (const patch of [
      { value: 'secret' },
      { filePath: '../private.ts' },
      { rect: { x: NaN, y: 0, width: -1, height: 1 } },
    ])
      expect(
        domSelectionSchema.safeParse({ ...selection, node: { ...node, ...patch } }).success,
      ).toBe(false);
  });
});
