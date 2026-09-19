# Wave 1 — AI 接入层（T1-01 ~ T1-06）

> 目标：用户可配置任意 OpenAI / Anthropic 兼容中转，连通测试通过，客户端统一出口具备重试、限流、计费与脱敏能力。
> 本 Wave 是 M4/M6/M7 的前置：记忆抽取、上下文组装、文档生成全部依赖它。

---

## T1-01 Provider / Model 数据模型与仓库层

| 项       | 内容                                      |
| -------- | ----------------------------------------- |
| 覆盖需求 | FR-MDL-01；FR-MDL-04；FR-MDL-09；NFR-S-01 |
| 优先级   | P0                                        |
| 前置任务 | T0-07、T0-08、T0-10                       |
| 可并行   | T1-02                                     |

**产出物**

- `packages/ai/src/domain/{provider.ts,model.ts,capability.ts,purpose-binding.ts}`
- `packages/ai/src/repo/{provider-repo.ts,model-repo.ts}`（基于 T0-07 Repository）
- `packages/ai/src/dto/{create-provider.ts,update-provider.ts}`（zod）
- 单元测试

**实现要点**

1. Provider 字段：名称、协议（openai/anthropic）、baseUrl、自定义请求头、模型列表、默认超时、支持流式/工具/视觉、启用状态、排序。
2. API Key 不入库明文，只存 secure_ref 指向密钥环；读取时按命名空间 `ai-key` 解密。
3. Model 能力矩阵：上下文长度、是否支持工具、是否支持视觉、输入/输出单价（可手动修正）。
4. 用途化绑定：需求生成 / 界面生成 / 技术文档 / 代码生成 / 记忆抽取 / 提交信息 六类，可绑定不同模型，提供"全部使用默认模型"开关。

**验收标准**

- [ ] Provider CRUD 通过，Key 在 DB 与日志中均为引用而非明文
- [ ] 能力矩阵可手动修正并持久化
- [ ] 六类用途绑定可读写，默认开关生效
- [ ] zod 校验拦截非法 baseUrl（非 http/https 直接拒绝）

**▶ AI 执行提示词**

```
任务 T1-01：实现 Provider / Model 数据模型与仓库层（packages/ai）。
要求：
1) domain/provider.ts 定义 Provider：id、name、protocol('openai'|'anthropic')、baseUrl、headers、timeoutMs、supportsStream、supportsTools、supportsVision、enabled、order、keyRef。
2) API Key 绝不入库明文：写入 packages/core 的 secure-store（命名空间 'ai-key'），DB 只存 keyRef；提供 getApiKey(providerId) 解密读取，异常不泄漏明文。
3) domain/model.ts + capability.ts：Model 含 id、displayName、contextWindow、supportsTools、supportsVision、inputPricePerMTok、outputPricePerMTok、manualOverride 标记。
4) purpose-binding.ts：六类用途（requirement/interface/techdoc/code/memory-extract/commit-msg）到 modelId 的映射，提供"全部使用默认模型"快捷开关。
5) repo 层用 packages/data 的 Repository 基类实现 CRUD + 乐观锁；dto 用 zod 校验（baseUrl 必须是 http/https，超时 1~600s）。
6) 单测：Key 落库为引用、能力矩阵修正持久化、用途绑定默认值、非法 baseUrl 被拒。
验收：测试通过；在 SQLite 文件与日志中确认检索不到任何明文 Key。
```

---

## T1-02 统一内部消息模型与协议抽象

| 项       | 内容                         |
| -------- | ---------------------------- |
| 覆盖需求 | FR-MDL-03（协议统一）；§13.2 |
| 优先级   | P0                           |
| 前置任务 | T1-01                        |
| 可并行   | 无（T1-03 / T1-04 依赖它）   |

**产出物**

- `packages/ai/src/core/{message.ts,tool.ts,stream.ts,usage.ts,error.ts,adapter.ts}`
- `packages/ai/src/core/__tests__/*`

**实现要点**

1. 内部消息模型：`SystemMessage / UserMessage / AssistantMessage / ToolResultMessage`，内容块支持 text / image / tool_use / tool_result，屏蔽两协议差异。
2. 流式统一为 `AsyncIterable<StreamChunk>`，chunk 类型：delta / tool_call / usage / error / done。
3. 统一错误：`AuthError / RateLimitError / TimeoutError / ContextLengthError / ContentFilterError / ProtocolError / ProviderUnavailable`，各带可操作建议（对齐 PRD §13.3）。
4. Adapter 接口：`chat(request): AsyncIterable<StreamChunk>`、`listModels()`、`countTokens(messages)`。

**验收标准**

- [ ] 两种协议的响应都能映射为同一内部消息模型（含 tool_use）
- [ ] 流式 chunk 序列可无损重组为完整消息
- [ ] 七类错误均可构造并带处理建议
- [ ] token 计数在无 tokenizer 时用启发式估算并标注误差

**▶ AI 执行提示词**

```
任务 T1-02：定义统一内部消息模型与协议适配抽象（packages/ai/src/core）。
要求：
1) message.ts：System/User/Assistant/ToolResult 四类消息，内容块支持 text、image(url|base64)、tool_use、tool_result；与具体协议解耦。
2) stream.ts：把流式响应统一为 AsyncIterable<StreamChunk>，chunk 类型为 delta|tool_call|usage|error|done；提供 collect() 把流重组为完整消息。
3) usage.ts：统一 usage（promptTokens/completionTokens/totalTokens）与费用计算（按 Provider 单价）。
4) error.ts：AuthError、RateLimitError(含 retryAfterMs)、TimeoutError、ContextLengthError、ContentFilterError、ProtocolError(附实际返回片段)、ProviderUnavailable；每类带 userMessage 与 actionable 建议，对齐 docs/PRD-EveryoneCoding.md §13.3。
5) adapter.ts：ProviderAdapter 接口 { chat(request): AsyncIterable<StreamChunk>; listModels(): Promise<Model[]>; countTokens(messages): number }。countTokens 无 tokenizer 时用启发式估算并标注估算标记。
6) tool.ts：工具定义与调用结果结构，支持 function calling 与 Anthropic tool_use 的双向映射。
7) 单测：消息映射、流重组、费用计算、七类错误构造、启发式 token 估算误差范围。
验收：测试通过；给出 OpenAI 与 Anthropic 各一份样例响应到内部模型的映射示例。
```

---

## T1-03 OpenAI 兼容协议适配器

| 项       | 内容                             |
| -------- | -------------------------------- |
| 覆盖需求 | FR-MDL-02；FR-MDL-01（连接测试） |
| 优先级   | P0                               |
| 前置任务 | T1-02                            |
| 可并行   | T1-04                            |

**产出物**

- `packages/ai/src/adapters/openai/{client.ts,request-map.ts,response-map.ts,sse-parser.ts,models.ts}`
- `packages/ai/src/adapters/openai/__tests__/*`（用本地 mock server 跑真实 HTTP）

**实现要点**

1. 请求 `/chat/completions`：messages / model / stream / tools / temperature / max_tokens；支持自定义 baseUrl 拼接与自定义 header。
2. SSE 解析：`data: {...}` 增量解析、`[DONE]` 终止、跨 chunk 粘包处理、心跳注释行忽略。
3. 兼容常见中转（One API / New API）：允许非标准字段透传，解析失败附原始片段。
4. `listModels()` 调 `/models`，失败时回退到用户手填模型列表。
5. 连接测试：列出模型 + 发起一次最小对话（`hi`，max_tokens=1）。

**验收标准**

- [ ] 对本地 mock OpenAI 服务：非流式、流式、工具调用三种请求全部成功
- [ ] SSE 粘包与心跳场景解析正确（构造 3 类异常流测试）
- [ ] 401/429/超时/内容过滤分别映射为对应错误类型
- [ ] 连接测试返回结果结构与耗时

**▶ AI 执行提示词**

```
任务 T1-03：实现 OpenAI 兼容协议适配器（packages/ai/src/adapters/openai）。
要求：
1) 遵循 /chat/completions 请求响应格式，支持 messages/model/stream/tools/temperature/max_tokens；baseUrl 拼接容错（末尾有无 /v1 都能正确请求）；支持用户自定义请求头透传。
2) sse-parser.ts：解析 text/event-stream，处理 data: 行、[DONE]、跨 chunk 粘包、心跳注释行、空行；提供单元测试用字节流构造器。
3) request-map / response-map：内部消息模型 ↔ OpenAI 格式双向映射，含 tool_calls 与 tool 结果。
4) models.ts：调用 /models 列举模型并映射为内部 Model；失败时回退用户手填列表并在结果中标注来源。
5) 提供 testConnection(provider)：列出模型 + 发起一次最小对话（max_tokens=1），返回 {ok, models, latencyMs, error?}。
6) 错误映射：401/403→AuthError，402→ProviderUnavailable(余额不足)，408/超时→TimeoutError，429→RateLimitError(解析 Retry-After)，5xx→ProviderUnavailable，内容过滤→ContentFilterError，上下文超限→ContextLengthError，返回体非预期→ProtocolError(附原始片段)。
7) 测试：起本地 mock HTTP 服务，覆盖非流式/流式/工具调用三种成功路径 + 粘包/心跳/中断三类异常流 + 六类错误映射。
验收：全部测试通过；给出一份 SSE 解析的字节级测试用例说明。
```

---

## T1-04 Anthropic 兼容协议适配器

| 项       | 内容      |
| -------- | --------- |
| 覆盖需求 | FR-MDL-03 |
| 优先级   | P0        |
| 前置任务 | T1-02     |
| 可并行   | T1-03     |

**产出物**

- `packages/ai/src/adapters/anthropic/{client.ts,request-map.ts,response-map.ts,sse-parser.ts,models.ts}`
- `packages/ai/src/adapters/anthropic/__tests__/*`

**实现要点**

1. 请求 `/v1/messages`，必带 `anthropic-version` 头（可配置版本），`system` 为独立顶层字段而非消息数组。
2. 响应 `content` 块数组（text / tool_use）；`stop_reason` 映射为 finish reason；`usage` 字段差异处理。
3. 流式事件：message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop，按 block 累积。
4. `tool_use` 与内部工具模型双向映射；`tool_result` 放在 user 消息的 content 块中。
5. Key 头为 `x-api-key`，与 OpenAI 的 Authorization 区分。

**验收标准**

- [ ] 对本地 mock Anthropic 服务：非流式、流式、工具调用三种请求全部成功
- [ ] system 字段正确置于顶层；tool_result 结构正确
- [ ] 多 content block 流式场景能正确累积与切分
- [ ] 错误映射与 OpenAI 适配器保持同一套类型

**▶ AI 执行提示词**

```
任务 T1-04：实现 Anthropic 兼容协议适配器（packages/ai/src/adapters/anthropic）。
要求：
1) 请求 /v1/messages，带 anthropic-version 头（默认 2023-06-01，可配置）与 x-api-key；system 作为顶层独立字段，不进 messages 数组。
2) request-map/response-map：内部消息模型 ↔ Anthropic 格式双向映射；content 块支持 text 与 tool_use；tool_result 放在 user 消息 content 块中；stop_reason → finish reason；usage 字段差异归一化。
3) sse-parser：处理 message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop / ping，按 content block index 累积，支持多个并行 block。
4) models.ts：Anthropic 无标准 /models 时，回退为用户手填模型列表或固定清单，并在结果中标注来源。
5) 错误映射复用 packages/ai/src/core/error.ts 的同一套错误类型。
6) 测试：起本地 mock HTTP 服务，覆盖非流式/流式/多 block/工具调用成功路径，与 401/429/529/overloaded 等错误映射。
验收：全部测试通过；给出 system 字段与 tool_result 结构的真实请求体示例。
```

---

## T1-05 AI Gateway Client 统一出口

| 项       | 内容                                                 |
| -------- | ---------------------------------------------------- |
| 覆盖需求 | FR-AI-06；FR-AI-09；FR-AI-10；FR-MDL-10/11/12；§13.3 |
| 优先级   | P0                                                   |
| 前置任务 | T1-03、T1-04                                         |
| 可并行   | 无                                                   |

**产出物**

- `packages/ai/src/gateway/{client.ts,retry.ts,queue.ts,budget.ts,usage-tracker.ts,failover.ts,proxy.ts}`
- `packages/ai/src/gateway/__tests__/*`

**实现要点**

1. 统一出口：按用途与 Provider 选择模型 → 适配 → 流式返回；支持 AbortSignal 中断，中断保留已生成部分。
2. 重试：指数退避（初始 500ms，最多 3 次），仅对 408/429/5xx 与网络错误重试；429 按 Retry-After 排队并展示位次。
3. 队列：按 Provider 配置 QPS 与并发上限，超限排队；单日预算超限拒绝并提示。
4. 容灾：主 Provider 连续失败（可配置次数）自动切备用，切换前通知用户并记录。
5. 用量统计：按 Provider/模型/项目记录 token 与费用，落 `usage_record`；支持月度预算告警。
6. 代理：HTTP/HTTPS/SOCKS5 单独配置，与系统代理分离，提供连通性测试。

**验收标准**

- [ ] 超时/429/5xx 分别触发正确重试或排队，非重试类错误立即失败
- [ ] 中断信号可中止生成并保留已产出内容
- [ ] QPS 与并发上限生效，超限请求排队而非丢弃
- [ ] 用量统计落库，月度预算触发告警事件
- [ ] 代理配置生效且连通性测试可用

**▶ AI 执行提示词**

```
任务 T1-05：实现 AI Gateway Client 统一出口（packages/ai/src/gateway）。
要求：
1) client.ts：入口 chat({purpose, projectId, messages, tools?, signal}) → 按用途绑定选模型 → 选 Provider → 调适配器 → 返回统一 AsyncIterable<StreamChunk>；支持 AbortSignal 中断且保留已生成部分（中断时返回 partial 标记）。
2) retry.ts：指数退避（初始 500ms、倍数 2、抖动 ±20%、最多 3 次）；仅 408/429/5xx 与网络错误重试；402/401/内容过滤/上下文超限直接失败；上下文超限时抛出 ContextLengthError 供上层触发裁剪。
3) queue.ts：按 Provider 配置 qpsLimit / concurrencyLimit，超限排队并暴露队列位次事件；单日预算超限时拒绝并给明确提示。
4) failover.ts：主 Provider 连续失败 N 次（默认 2，可配）自动切换备用（按用户配置顺序），切换前发事件通知 UI 并记录到日志。
5) usage-tracker.ts：按 provider/model/project/purpose 记录 promptTokens、completionTokens、费用、耗时，落 usage_record 表；提供月度汇总与预算告警事件。
6) proxy.ts：AI 请求独立代理配置（HTTP/HTTPS/SOCKS5），与系统代理分离；提供 testConnectivity()。
7) 所有日志经 redaction 脱敏；Key 不出现在任何日志与错误信息中。
8) 单测：重试策略分类、退避时间、中断保留、队列限流、容灾切换、用量统计、预算拒绝。
验收：测试通过；给出一次"429 → 排队 → 成功"与"连续失败 → 切备用"的事件时间线示例。
```

---

## T1-06 Provider 设置 UI 与用户自配远程配置页面

| 项       | 内容                                             |
| -------- | ------------------------------------------------ |
| 覆盖需求 | FR-MDL-01；FR-MDL-05/06/07/08/13；E2E-10；E2E-11 |
| 优先级   | P0                                               |
| 前置任务 | T1-01、T1-05、T0-06                              |
| 可并行   | 无                                               |

**产出物**

- `apps/renderer/src/features/settings/provider/{ProviderList.tsx,ProviderEditor.tsx,ConnectionTest.tsx,ModelCapabilityTable.tsx,PurposeBinding.tsx}`
- `apps/renderer/src/features/settings/remote-config/{RemoteConfigList.tsx,RemoteConfigEditor.tsx,DiffPreview.tsx}`
- `packages/ai/src/remote-config/{fetcher.ts,verifier.ts,applier.ts}`（Ed25519 签名可选校验）
- 集成测试

**实现要点**

1. Provider 列表/编辑/删除/排序；编辑项与 T1-01 字段一致；保存前必须能"连接测试"并展示返回的模型列表与延迟。
2. 能力矩阵表格可就地编辑；用途绑定六个下拉 + "全部使用默认模型"开关。
3. 远程配置页面：多配置源（名称、URL、可选公钥、启用、更新频率），支持「立即拉取 / 预览差异 / 设为默认 / 停用 / 导入导出」；**不依赖平台服务端**，直连用户填写的 URL。
4. 优先级：用户本地 > 远程默认；远程更新默认模型时弹窗询问，用户拒绝后记录已读版本不再弹。
5. 拉取失败用本地缓存、不阻塞启动；未配置远程源时该能力默认关闭。

**验收标准**

- [ ] E2E-10：填入第三方 OpenAI 兼容 baseUrl + Key → 测试连通 → 列出模型 → 完成一次生成
- [ ] E2E-11：填入自配 URL → 拉取 → 预览差异 → 设为默认 → 默认模型生效；URL 不可达时启动不阻塞
- [ ] 状态栏与设置页不出现任何云端同步入口（D-02/D-06）
- [ ] 明文 Key 在 UI 上默认掩码显示（前 4 后 4）

**▶ AI 执行提示词**

```
任务 T1-06：实现 Provider 设置 UI 与用户自配远程配置页面。
要求：
1) Provider 设置页（apps/renderer/src/features/settings/provider）：列表 + 新增/编辑/删除/排序；字段与 T1-01 一致；Key 输入框默认掩码（前 4 后 4），保存走 secure-store；保存前提供「连接测试」按钮，展示返回模型列表与延迟。
2) ModelCapabilityTable：上下文长度/工具/视觉/单价可就地编辑并标注 manualOverride。
3) PurposeBinding：需求生成/界面生成/技术文档/代码生成/记忆抽取/提交信息 六类下拉 + "全部使用默认模型"开关。
4) 远程配置：packages/ai/src/remote-config 实现 fetcher（直连用户填写的 URL，不经平台服务端）、verifier（用户填公钥时做 Ed25519 校验，未填则跳过）、applier（按"本地 > 远程默认"优先级应用）。
5) 远程配置页面：多源管理（名称/URL/可选公钥/启用/更新频率），操作「立即拉取 / 预览差异 / 设为默认 / 停用 / 导入导出」；展示上次拉取结果与失败原因；拉取失败用本地缓存且不阻塞启动；未配置源时能力默认关闭；远程更新默认模型时弹窗询问，拒绝后记录已读版本不再弹。
6) 全页不得出现云端同步或官方配置服务入口（D-02/D-06）。
7) 集成测试：mock 一个远程配置 HTTP 服务，覆盖拉取成功/签名校验失败/不可达三条路径；UI 用 Testing Library 覆盖 Provider 保存与连接测试。
验收：E2E-10 与 E2E-11 手工走通；无云端同步入口；Key 掩码显示。
```

---

**Wave 1 出口检查**：任意 OpenAI / Anthropic 兼容中转可配置、可连通、可流式对话；用量与错误可观测；远程配置页面可独立工作且不依赖平台服务端。
