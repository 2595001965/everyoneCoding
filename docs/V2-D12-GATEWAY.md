# V2-D12 验收记录

日期：2026-10-03

## 前置核验

- **D11 已验收**：核对 [D11 验收记录](V2-D11-WALLET.md)，确认服务端 `WalletLedger` 已提供 attempt 预占、派发标记、租约续期、未知状态保留、可信最终 usage 结算、未派发释放与人工对账/冲正；D11 钱包测试 7 项通过。
- **D10 保持“已实现待验收”**：复用平台公开快照、精确 Provider+Model ULID 路由键、append-only 价格快照和已核验官方价格快照；本卡没有把 D10 改标为验收完成，也没有种入真实渠道/价格。
- 阅读 `docs/tasks/00-通用上下文与执行约定.md`、V2-D12 卡片及 PRD §7.1、§7.2、§9.4、§11.3、§12 的本地直连、平台托管、可信计量与账务规则。

## 本次交付

- 账号服务 `POST /api/ai/requests` 使用 Bearer 登录态、目录 `providerId/modelId` 和幂等 attempt ULID；服务端只从 D10 目录解析实际上游/协议/凭据，从 D10 价格版本或完全匹配的官方快照固定价格并调用 D11 原子预占。
- 用共享 OpenAI / Anthropic 流式适配器解析受控上游响应，并向客户端输出带 `V2EventEnvelope` 的 SSE。只有完整可信最终 usage 能精确计费时才结算；最终费用超过预占可用额、用量缺桶、取消、断流或连接异常都会保留冻结并进入对账。
- 新增本人查询与取消端点 `GET /api/ai/requests/:attemptId`、`POST /api/ai/requests/:attemptId/cancel`。对账状态返回 409 阻止同 attempt 再派发；同幂等键内容不同也返回 409。客户端遇到结算未确认时显示需先查询账单的错误，不将其当作成功或自动重发。
- Electron 主进程从 DPAPI 会话取得平台 access token；客户端同步目录只创建指向配置账号服务 `/api/ai/requests` 的本地平台路由。托管 origin 校验绑定当前账号服务；上游 Key 只从服务端 `env:` / `secret://` 引用解析。
- BYOK Provider 保持本机直连和本机密钥环行为。账号服务离线时，本地 BYOK 回归测试仍能完成生成，平台 token 回调未触发。
- 上游目标默认 HTTPS；DNS 解析拒绝环回、私网、链路本地及保留目标，并把经检查的地址固定到 socket lookup；不跟随重定向。`ACCOUNT_GATEWAY_ALLOW_LOOPBACK=true` 仅用于受控本机 fixture。
- 持久层只保存请求 SHA-256 指纹、attempt、用量/成本与审计，不保存聊天正文；新增错误拒绝后的原子预占释放路径，且只适用于已派发但被上游明确拒绝的 attempt。

## 验收结果

- 账号服务受控本地 HTTP 上游集成：**6 项通过**。覆盖 SSE 完整流、服务端凭据注入、固定路由/价格/attempt、D11 预占和最终结算、重复/内容冲突、显式取消、客户端断流、未知 usage 保留预占、明确 4xx 释放、目录停用和 SSRF 拒绝。
- AI 包托管适配器、客户端路由同步与 BYOK 隔离：**21 项目标测试通过**（托管适配器 4、Gateway 路由/BYOK 停服隔离 10、控制门面/平台目录同步 7）；AI 包全量 **27 个文件 / 341 项通过**。
- 全量账号服务 Vitest：**6 个文件 / 42 项通过**，含 D11 真实 SQLite 多 Worker 争抢用例和 D12 受控网关集成。
- Electron 主进程托管/BYOK 与既有模型主链路 **2 个文件 / 13 项通过**；Renderer 设置页 **9 项通过**。
- 严格类型检查通过：`@ec/account-service`、`@ec/ai`、`@ec/desktop-electron`、`@ec/renderer`。
- 未发起真实厂商请求、未产生外部 Token 费用、未接支付或充值。所有上游响应、凭据和平台售价均为合成测试夹具。
## 接口与运行边界

- `POST /api/ai/requests` 需要 `Idempotency-Key` 和 `X-EC-Logical-Request-Id`；模型标识为 `providerId/modelId` ULID 路由，不接受客户端上游 URL、Key、价格或结算金额。
- `GET /api/ai/requests/:attemptId` 只返回本人 attempt、路由键、价格版本、usage 和账务摘要，不含 prompt、上游地址或 Key。
- `ACCOUNT_PLATFORM_SECRET_DIR` 指向 `secret://` 服务端凭据根目录，默认 `data/platform-secrets`；`env:NAME` 从服务端进程环境读取。运维须限制密钥文件访问权限。
- 托管请求需要登录且平台服务可用；本地 BYOK 路由无此依赖。未知结果按 D11 管理员对账流程处理，不能自动释放或重试收费请求。
