import { describe, expect, it } from 'vitest';
import { DEFAULT_PREVIEW_PORT, allocatePort, nextFreePort } from '../port-manager';

describe('nextFreePort 纯函数', () => {
  it('起点被占用时顺延 +1', () => {
    const r = nextFreePort(4173, [4173]);
    expect(r).not.toBeNull();
    expect(r?.port).toBe(4174);
    expect(r?.shifted).toBe(true);
    expect(r?.log).not.toBeNull();
  });

  it('起点空闲不偏移', () => {
    const r = nextFreePort(4173, []);
    expect(r?.port).toBe(4173);
    expect(r?.shifted).toBe(false);
    expect(r?.log).toBeNull();
  });

  it('连续占用时继续顺延', () => {
    const r = nextFreePort(4173, [4173, 4174, 4175]);
    expect(r?.port).toBe(4176);
    expect(r?.attempts).toBe(4);
  });

  it('超出有效范围或尝试次数不足返回 null', () => {
    const r = nextFreePort(65534, [65534, 65535], 5);
    expect(r).toBeNull();
  });
});

describe('allocatePort 注入 probe', () => {
  it('probe 命中可用端口', async () => {
    const alloc = await allocatePort({
      start: 4173,
      probe: (port) => port === 4174,
    });
    expect(alloc.port).toBe(4174);
    expect(alloc.shifted).toBe(true);
  });

  it('probe 接受 Promise 返回值', async () => {
    const alloc = await allocatePort({
      start: 3000,
      probe: async (port) => port === 3000,
    });
    expect(alloc.port).toBe(3000);
    expect(alloc.shifted).toBe(false);
  });

  it('全部占用返回起点并带日志', async () => {
    const alloc = await allocatePort({
      start: 8000,
      probe: () => false,
      maxAttempts: 3,
    });
    expect(alloc.port).toBe(8000);
    expect(alloc.shifted).toBe(false);
    expect(alloc.log).not.toBeNull();
  });
});

describe('默认端口常量', () => {
  it('DEFAULT_PREVIEW_PORT 为 4173', () => {
    expect(DEFAULT_PREVIEW_PORT).toBe(4173);
  });
});
