/**
 * 嵌入（向量化）端口 —— 依赖倒置。
 *
 * `@ec/memory` 不依赖 `@ec/ai`：向量化能力通过 {@link EmbeddingPort} 注入，
 * 使记忆检索在「未配置向量化模型」时可优雅降级为纯关键词检索。
 *
 * 上层接入真实网关的写法（仅作示例，本文件不 import `@ec/ai`）：
 *
 * ```ts
 * import { GatewayEmbedder } from '@ec/memory';
 * // 把网关调用包成 (texts) => Promise<EmbeddingOutcome>
 * const embedder = new GatewayEmbedder(
 *   (texts) => gateway.embed({ userId, inputs: texts }).then(toOutcome),
 *   { name: 'my-embedding-gateway' },
 * );
 * ```
 *
 * 其中 `toOutcome` 把网关返回转换成 {@link EmbeddingOutcome}：
 * 成功 → `{ ok: true, vectors, dimensions, model }`；失败/未配置 → `{ ok: false, code, reason }`。
 */

/* ------------------------------ 端口 ------------------------------ */

/** 单次向量化结果（成功 / 失败二选一） */
export type EmbeddingOutcome =
  | { ok: true; vectors: number[][]; dimensions: number; model: string }
  | { ok: false; code: 'unavailable' | 'failed'; reason: string };

/**
 * 向量化端口。
 * - `available()`：当前实例是否已具备向量化能力（用于提前决定要不要走语义路）。
 * - `embed()`：批量把文本转成向量；**任何**异常都必须被收敛到 `ok:false`，绝不向外抛错。
 */
export interface EmbeddingPort {
  readonly name: string;
  available(): boolean;
  embed(texts: readonly string[]): Promise<EmbeddingOutcome>;
}

/* ------------------------------ 空实现 ------------------------------ */

/**
 * 永远不可用的嵌入器：上层据此把语义路整体关闭，仅用关键词检索。
 */
export class NullEmbedder implements EmbeddingPort {
  readonly name = 'null';

  available(): boolean {
    return false;
  }

  async embed(_texts: readonly string[]): Promise<EmbeddingOutcome> {
    return {
      ok: false,
      code: 'unavailable',
      reason: '未配置向量化模型，检索使用关键词模式',
    };
  }
}

/* ------------------------------ 网关实现 ------------------------------ */

/**
 * 通过注入的 `embedFn` 接入真实网关（如 `@ec/ai` 的 embedding 用途）。
 *
 * 职责：
 * 1. 把 `embedFn` 的抛错 try/catch 收敛为 `ok:false`（code: 'failed'）；
 * 2. **维度一致性校验**：同一实例内首次成功的维度为准，后续返回值维度不一致时返回 `ok:false`，
 *    避免把不同模型/不同版本混在一起做 KNN（距离失去意义）；
 * 3. 一旦确认不可用（首次失败），`available()` 转为 `false`，避免反复无效调用。
 */
export class GatewayEmbedder implements EmbeddingPort {
  readonly name: string;
  private readonly embedFn: (texts: readonly string[]) => Promise<EmbeddingOutcome>;
  private usable = true;
  private dimensions: number | null = null;

  constructor(
    embedFn: (texts: readonly string[]) => Promise<EmbeddingOutcome>,
    options: { name?: string } = {},
  ) {
    this.embedFn = embedFn;
    this.name = options.name ?? 'gateway';
  }

  available(): boolean {
    return this.usable;
  }

  async embed(texts: readonly string[]): Promise<EmbeddingOutcome> {
    if (!this.usable) {
      return { ok: false, code: 'unavailable', reason: '嵌入器已确认不可用，不再发起调用' };
    }
    let outcome: EmbeddingOutcome;
    try {
      outcome = await this.embedFn(texts);
    } catch (error) {
      this.usable = false;
      return {
        ok: false,
        code: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (!outcome.ok) {
      this.usable = false;
      return outcome;
    }

    if (this.dimensions === null) {
      this.dimensions = outcome.dimensions;
    } else if (this.dimensions !== outcome.dimensions) {
      this.usable = false;
      return {
        ok: false,
        code: 'failed',
        reason: `向量维度不一致：期望 ${this.dimensions}，实际 ${outcome.dimensions}`,
      };
    }
    return outcome;
  }
}

/* ------------------------------ 序列化 ------------------------------ */

/**
 * 浮点向量 → BLOB（Float32 小端）。
 * 与 `domain/memory-item.ts` 的 `embeddingToBlob` 约定一致（sqlite 存储 embedding 用）。
 */
export function floatsToBlob(vec: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/**
 * BLOB → 浮点向量（Float32 小端）。
 * 接受 `Buffer` 或 `Uint8Array`，统一按小端 Float32 解析；与 `domain/memory-item.ts` 的 `blobToEmbedding` 互逆。
 */
export function blobToFloats(blob: Buffer | Uint8Array): number[] {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.byteLength === 0) return [];
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return Array.from(new Float32Array(view));
}
