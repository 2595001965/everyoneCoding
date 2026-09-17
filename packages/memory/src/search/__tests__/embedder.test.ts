import { describe, expect, it } from 'vitest';
import {
  GatewayEmbedder,
  NullEmbedder,
  blobToFloats,
  floatsToBlob,
  type EmbeddingOutcome,
} from '../embedder';

describe('NullEmbedder', () => {
  it('永远不可用且返回 unavailable', async () => {
    const e = new NullEmbedder();
    expect(e.available()).toBe(false);
    const out = await e.embed(['x']);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('unavailable');
      expect(out.reason).toContain('关键词模式');
    }
  });
});

describe('GatewayEmbedder', () => {
  it('成功路径原样透传向量与维度', async () => {
    const e = new GatewayEmbedder((texts) =>
      Promise.resolve({ ok: true, vectors: texts.map(() => [0.1, 0.2]), dimensions: 2, model: 'm' }),
    );
    expect(e.available()).toBe(true);
    const out = await e.embed(['a', 'b']);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.dimensions).toBe(2);
      expect(out.vectors).toHaveLength(2);
    }
  });

  it('embedFn 抛错被收敛为 ok:false（不向外抛出）', async () => {
    const e = new GatewayEmbedder(() => Promise.reject(new Error('boom')));
    expect(e.available()).toBe(true);
    const out = await e.embed(['a']);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('failed');
    // 失败后 available 转 false，避免反复无效调用
    expect(e.available()).toBe(false);
  });

  it('网关返回 ok:false 时收敛并置为不可用', async () => {
    const e = new GatewayEmbedder(() =>
      Promise.resolve({ ok: false, code: 'unavailable', reason: '未配置' }),
    );
    const out = await e.embed(['a']);
    expect(out.ok).toBe(false);
    expect(e.available()).toBe(false);
  });

  it('维度一致性校验：后续不同维度返回 ok:false', async () => {
    let call = 0;
    const e = new GatewayEmbedder((_texts): Promise<EmbeddingOutcome> => {
      call += 1;
      const dims = call === 1 ? 4 : 8;
      return Promise.resolve({ ok: true, vectors: [new Array(dims).fill(0)], dimensions: dims, model: 'm' });
    });
    expect((await e.embed(['a'])).ok).toBe(true);
    const second = await e.embed(['b']);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('维度不一致');
  });
});

describe('floatsToBlob / blobToFloats 往返', () => {
  it('Float32 小端往返无损（可精确表示的值）', () => {
    const vec = [0, 1, -2, 3.5, 100, -0.25];
    const blob = floatsToBlob(vec);
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(blob.byteLength).toBe(vec.length * 4);
    const back = blobToFloats(blob);
    expect(back).toEqual(vec);
  });

  it('接受 Uint8Array 输入并正确解析', () => {
    const vec = [1, 2, 3];
    const blob = floatsToBlob(vec);
    const u8 = new Uint8Array(blob);
    expect(blobToFloats(u8)).toEqual(vec);
  });

  it('空向量往返为空数组', () => {
    expect(blobToFloats(floatsToBlob([]))).toEqual([]);
  });
});
