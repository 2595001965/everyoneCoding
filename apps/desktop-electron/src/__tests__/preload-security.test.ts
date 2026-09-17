/**
 * preload 安全审计（NFR-S / FR-ACC-07）。
 * 断言暴露面白名单：无 Node 全局、无多余方法、全部为函数。
 */
import { describe, expect, it } from 'vitest';
import { createPreloadApi, type InvokeIpcRendererLike } from '../preload/api';
import { PRELOAD_METHOD_KEYS, PRELOAD_TOP_LEVEL_KEYS } from '../main/channels';

// 注：顶层 'process' 是本产品合法的进程管理命名空间，
// Node 全局 process 的防护由 contextBridge（sandbox + contextIsolation）保证。
const FORBIDDEN_KEYS = [
  'require',
  'Buffer',
  'global',
  'globalThis',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'ipcRenderer',
  'electron',
];

function fakeIpc(): InvokeIpcRendererLike {
  return {
    invoke: async () => undefined,
    on: () => undefined,
    off: () => undefined,
  };
}

describe('preload 白名单审计', () => {
  const api = createPreloadApi(fakeIpc());

  it('顶层命名空间与白名单完全一致', () => {
    expect(Object.keys(api).sort()).toEqual([...PRELOAD_TOP_LEVEL_KEYS].sort());
  });

  it('各命名空间方法与白名单完全一致', () => {
    for (const [namespace, expected] of Object.entries(PRELOAD_METHOD_KEYS)) {
      const actual = Object.keys(api[namespace] as Record<string, unknown>).sort();
      expect(actual, `命名空间 ${namespace} 的暴露面`).toEqual([...expected].sort());
    }
  });

  it('全部暴露成员都是函数（无数据直通）', () => {
    for (const [namespace, value] of Object.entries(api)) {
      if (typeof value === 'function') {
        expect(namespace === 'openExternal').toBe(true);
        continue;
      }
      for (const [method, member] of Object.entries(value as Record<string, unknown>)) {
        expect(typeof member, `${namespace}.${method} 应为函数`).toBe('function');
      }
    }
  });

  it('不含任何 Node 全局对象', () => {
    const flat = JSON.stringify(Object.keys(api)) + JSON.stringify(PRELOAD_METHOD_KEYS);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(flat.includes(forbidden), `不应出现 ${forbidden}`).toBe(false);
    }
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(api[forbidden]).toBeUndefined();
    }
  });

  it('preload 参数校验生效', async () => {
    const fs = api.fs as { readText: (path: string) => Promise<unknown> };
    expect(() => fs.readText('')).toThrow(TypeError);
    const secureStore = api.secureStore as {
      set: (ns: string, key: string, value: string) => Promise<unknown>;
    };
    expect(() => secureStore.set('bad-ns', 'key', 'value')).toThrow(TypeError);
    const openExternal = api.openExternal as (url: string) => Promise<unknown>;
    expect(() => openExternal('javascript:alert(1)')).toThrow(TypeError);
  });
});
