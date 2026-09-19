import type { EmbeddingPort } from '../embedder';
import { GatewayEmbedder } from '../embedder';

/**
 * 测试工具：不依赖真实 AI 网关的确定性「伪嵌入器」与伪向量生成。
 * 仅在测试中使用，不进入生产代码路径。
 */

/** 把文本确定性地映射为 `dims` 维单位向量（字符 bigram 哈希累加后归一化）。
 * 共享越多 bigram 的文本，余弦相似度越高——足以驱动语义路 KNN 的收敛行为。 */
export function fakeEmbedding(text: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  const runes = [...text];
  const hash = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  for (let i = 0; i < runes.length; i++) {
    const gram = runes.slice(i, i + 2).join('');
    const h = hash(gram);
    for (let d = 0; d < dims; d++) {
      vec[d] = (vec[d] ?? 0) + ((h >>> (d % 24)) & 1 ? 1 : -1);
    }
  }
  const len = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / len);
}

/** 成功的伪嵌入器（GatewayEmbedder 包一层） */
export function makeFakeEmbedder(dims: number, name = 'fake'): EmbeddingPort {
  return new GatewayEmbedder(
    (texts) =>
      Promise.resolve({
        ok: true,
        vectors: texts.map((t) => fakeEmbedding(t, dims)),
        dimensions: dims,
        model: 'fake',
      }),
    { name },
  );
}

/** 永远返回 ok:false 的嵌入器（模拟未配置 / 调用失败） */
export function makeFailingEmbedder(
  code: 'unavailable' | 'failed' = 'unavailable',
  reason = '测试用失败',
): EmbeddingPort {
  return new GatewayEmbedder(() => Promise.resolve({ ok: false, code, reason }), {
    name: 'failing',
  });
}
