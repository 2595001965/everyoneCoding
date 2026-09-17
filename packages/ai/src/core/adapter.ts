import type { AiError } from './error';
import type { HttpTransport, ProxyConfig } from './http';
import type { ChatMessage } from './message';
import type { StreamChunk } from './stream';
import type { ToolDefinition } from './tool';
import type { TokenEstimate } from './usage';
import type { ModelDiscovery, Model } from '../domain/model';
import type { Provider, Protocol } from '../domain/provider';

/**
 * 协议适配器抽象。
 *
 * 上层（Gateway / 上下文引擎 / 记忆抽取）只依赖本接口，
 * 不感知 OpenAI 与 Anthropic 的报文差异。
 */

export interface ChatRequest {
  provider: Provider;
  /** 服务端模型标识 */
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** 关闭时一次性返回（连接测试等场景用） */
  stream?: boolean;
  signal?: AbortSignal;
}

/** 适配器运行上下文：由 Gateway 注入，便于测试替换传输实现 */
export interface AdapterContext {
  transport: HttpTransport;
  /** 解密后的明文 Key，仅内存使用 */
  apiKey: string | null;
  proxy?: ProxyConfig | undefined;
  /** 单次请求超时覆盖（毫秒） */
  timeoutMs?: number;
}

export interface ProviderAdapter {
  readonly protocol: Protocol;
  /** 发起对话；流式与非流式都返回 AsyncIterable，由 collect() 统一收口 */
  chat(request: ChatRequest, context: AdapterContext): AsyncIterable<StreamChunk>;
  /** 列举模型；不可用时回退手填列表并在 discovery.source 标注 */
  listModels(provider: Provider, context: AdapterContext): Promise<ModelDiscovery>;
  /** token 计数：无 tokenizer 时用启发式估算（结果带 estimated 标记） */
  countTokens(messages: ChatMessage[], model?: Model): TokenEstimate;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** 即便失败也尽量返回模型列表（可能是手填回退） */
  models: ModelDiscovery;
  latencyMs: number;
  error?: AiError;
}

/** 适配器工厂：按协议返回实现 */
export type AdapterFactory = (protocol: Protocol) => ProviderAdapter;
