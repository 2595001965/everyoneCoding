/**
 * @ec/ai —— Provider 适配、上下文引擎、代码写入管线。
 *
 * 分层：
 * - `core`：内部消息模型、流式、用量、错误、HTTP 传输抽象（与协议无关）
 * - `domain`：Provider / Model / 能力矩阵 / 用途绑定
 * - `dto`：入参校验（zod）
 * - `repo`：SQLite 读写（基于 @ec/data 的 Repository）
 * - `adapters`：OpenAI 兼容 / Anthropic 兼容两套实现
 * - `gateway`：统一出口（重试、限流、预算、容灾、用量、代理）
 * - `context`：AI 上下文引擎（八类块组装、Token 预算与裁剪、面板视图模型）
 * - `remote-config`：用户自配远程配置（不依赖平台服务端）
 * - `service`：装配与设置门面（渲染层只接触这一层）
 *
 * 跨包引用只允许通过本单一入口，禁止深路径导入。
 */

/* ------------------------------- core ------------------------------- */
export * from './core/message';
export * from './core/tool';
export * from './core/usage';
export * from './core/stream';
export * from './core/error';
export * from './core/adapter';
export * from './core/http';
export * from './core/tunnel';
export * from './core/node-transport';
export * from './core/connection-test';
export * from './core/embedding';

/* ------------------------------ domain ------------------------------ */
export * from './domain/provider';
export * from './domain/model';
export * from './domain/capability';
export * from './domain/purpose-binding';

/* -------------------------------- dto ------------------------------- */
export * from './dto/create-provider';
export * from './dto/update-provider';

/* -------------------------------- repo ------------------------------ */
export * from './repo/provider-repo';
export * from './repo/model-repo';
export * from './repo/purpose-binding-repo';
export * from './repo/usage-repo';
export * from './repo/remote-config-repo';

/* ------------------------------ adapters ---------------------------- */
export * from './adapters/shared/sse-parser';
export * from './adapters/shared/error-map';

export { OpenAiAdapter } from './adapters/openai/client';
export * from './adapters/openai/request-map';
export {
  chunksFromOpenAiResponse,
  chunksFromOpenAiStreamEvent,
  finishReasonFromOpenAi,
  parseOpenAiEvent,
  usageFromOpenAi,
} from './adapters/openai/response-map';
export type { OpenAiResponse, OpenAiChoice, OpenAiDelta, OpenAiUsage } from './adapters/openai/response-map';
export { fetchOpenAiModels } from './adapters/openai/models';
export {
  buildOpenAiEmbeddingBody,
  embedWithOpenAi,
  parseOpenAiEmbeddingResponse,
  vectorsFromEmbeddingResponse,
} from './adapters/openai/embeddings';
export type { OpenAiEmbeddingResponse, OpenAiEmbeddingRequestBody } from './adapters/openai/embeddings';

export { AnthropicAdapter } from './adapters/anthropic/client';
export * from './adapters/anthropic/request-map';
export {
  chunksFromAnthropicResponse,
  chunksFromAnthropicStreamEvent,
  finishReasonFromAnthropic,
  parseAnthropicEvent,
  usageFromAnthropic,
} from './adapters/anthropic/response-map';
export type { AnthropicResponse, AnthropicStreamEvent, AnthropicUsage } from './adapters/anthropic/response-map';
export { fetchAnthropicModels } from './adapters/anthropic/models';

/* ------------------------------ gateway ----------------------------- */
export * from './gateway/retry';
export * from './gateway/queue';
export * from './gateway/budget';
export * from './gateway/budget-alert';
export * from './gateway/usage-tracker';
export * from './gateway/usage-report';
export * from './gateway/failover';
export * from './gateway/proxy';
export * from './gateway/client';

/* ------------------------------ context ----------------------------- */
export * from './context';

/* ------------------------------ generate ---------------------------- */
export * from './generate';

/* -------------------------------- write ----------------------------- */
export * from './write';

/* ------------------------------- anchors ---------------------------- */
export * from './anchors';

/* -------------------------------- nav ---------------------------------- */
export * from './nav';

/* --------------------------- remote-config -------------------------- */
export * from './remote-config/fetcher';
export * from './remote-config/verifier';
export * from './remote-config/applier';

/* ------------------------------ service ----------------------------- */
export * from './service/ai-control-api';
export * from './service/ai-stack';

/* ------------------------------ secure ------------------------------ */
export * from './secure/api-key-store';
export * from './service/ai-control-api';
