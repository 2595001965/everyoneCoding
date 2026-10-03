# 云端账号服务端（EveryoneCoding · Apache-2.0）

账号服务端承载既有账号服务（T9-06）、平台目录/价格版本（V2-D10）、平台钱包账本（V2-D11）及可信平台 AI 网关（V2-D12）。网站、管理台、本地容器部署与数据恢复见 [V2-D13 交付说明](../../docs/V2-D13-WEB.md)。客户端基础工作流仍可离线运行；平台托管模型调用与账号服务可用性由相应模式决定。

## 已实现接口（严格按 PRD §8）

| 方法            | 路径                                  | 说明                                                                             |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| POST            | `/api/auth/register`                  | 邮箱注册，自注册即开通（默认「个人工作区」+ 免费权益包 `free`）                  |
| POST            | `/api/auth/login`                     | 邮箱 + 密码登录                                                                  |
| GET             | `/api/auth/oauth/:provider/authorize` | 发起 OAuth（provider = `wechat` \| `google` \| `github`），返回授权 URL 与 state |
| GET/POST        | `/api/auth/oauth/:provider/callback`  | 回调换令牌；AuthClient 使用 POST；首次授权自动建号                               |
| POST            | `/api/auth/refresh`                   | Refresh Token 换新 Access Token（旧 refresh 轮换失效）                           |
| GET/POST/DELETE | `/api/auth/bindings`                  | 第三方身份绑定：列出 / 绑定 / 解绑                                               |
| POST            | `/api/usage/report`                   | 匿名用量上报（需授权）                                                           |
| GET             | `/api/release/check`                  | 版本检查，按 `?form=tauri\|electron` 分别下发版本与增量包清单                    |
| POST            | `/api/ai/requests`                    | 登录账号经目录路由发起平台托管流式生成；服务端内部预占并按可信最终 usage 结算    |
| GET             | `/api/ai/requests/:attemptId`         | 查询本人托管请求状态、实际平台路由、价格版本与结算摘要                           |
| POST            | `/api/ai/requests/:attemptId/cancel`  | 取消本人活动请求；派发后状态不明时保留预占并进入对账                             |

### 邮箱闭环补充接口（FR-ACC-08）

| 方法 | 路径                               | 说明                                                               |
| ---- | ---------------------------------- | ------------------------------------------------------------------ |
| POST | `/api/auth/email/verify`           | 请求验证邮件；请求体 `{ email }`，成功返回 `{ ok: true }`          |
| POST | `/api/auth/email/verify/confirm`   | 请求体 `{ token }`；验证成功返回 `{ ok: true }`                    |
| GET  | `/api/auth/email/status?email=...` | 返回 `{ emailVerified }`                                           |
| POST | `/api/auth/password/reset/request` | 请求体 `{ email }`；发送 6 位验证码，返回 `{ ok: true }`           |
| POST | `/api/auth/password/reset`         | 请求体 `{ email, code, newPassword }`；成功返回 `{ ok: true }`     |
| GET  | `/verify-email?token=...`          | 自托管静态落地页；同源静态 JS 读取 token 后调用 confirm            |
| GET  | `/api/dev/email-outbox?limit=20`   | 开发邮件 sink，返回 `{ items }`；正文保留链接/验证码，收件地址脱敏 |

### 客户端契约（2026-10-01 核对）

[OpenAPI](openapi.yaml) 描述 HTTP 字段；[contract.test.ts](src/__tests__/contract.test.ts)
通过真实 AuthClient 与 Fastify `app.inject` 联测。

| 操作                              | 请求 / 响应要点                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| register / login / OAuth callback | 返回 `{ identity, tokens }`；注册另有 `workspaceId`/`planId`，OAuth 另有 `isNew` 等字段。身份主键是 `identity.accountId`                                                                                       |
| refresh                           | 请求 `{ refreshToken }`，直接返回 `TokenPair`，没有外层 `identity`/`tokens`；旧 refresh 轮换失效                                                                                                               |
| TokenPair                         | `accessToken`、`refreshToken`、`expiresAt`、`refreshExpiresAt`；到期时间为毫秒时间戳                                                                                                                           |
| OAuth authorize                   | 查询参数 `code_challenge`、`redirect_uri`；返回 `{ authorizeUrl, state }`，客户端使用服务端签发的 state                                                                                                        |
| OAuth callback                    | 支持 GET/POST；AuthClient 使用 POST `{ code, state, codeVerifier, redirectUri }`，GET 兼容 `code_verifier`。服务端使用 state 保存的回调地址，state 过期/重用及 PKCE 不符会被拒绝；PKCE 失败后该 state 同样作废 |
| GET / POST bindings               | 需 Bearer Token；POST 请求 `{ provider, code, state, codeVerifier }`。返回 `{ bindings: [{ id, provider, externalId, boundAt }] }`，`externalId` 脱敏                                                          |
| DELETE bindings                   | 需 Bearer Token；按查询参数 `bindingId`（兼容请求体）解绑；返回更新后的 `{ bindings }`，唯一登录方式不可直接解绑                                                                                               |

## 明确边界（验收要求）

> **本服务不提供云同步、远程配置下发与分享链接。**

依据 PRD §2.2 决策，下列接口**已被移除且不实现**：`/api/config/remote`、`/api/sync/memory`、`/api/sync/project-meta`、`/api/share`。用户配置与同步由客户端本地处理（远程配置走用户自配 URL，数据同步走 `.ecpkg` 手动导入导出，预览仅限本地/局域网）。

## V2-D10 平台目录与价格版本

### 公开接口

| 方法 | 路径                    | 说明                                                                                                                            |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/api/catalog`          | 公开 ProviderModel 目录、已生效平台价格历史和精确 canonical 身份匹配的官网价格证据                                              |
| GET  | `/api/catalog/snapshot` | 可保存为本地 JSON 快照；离线读取方用 `@ec/core` 的 `parsePlatformCatalogSnapshot` 校验，再用 `resolveCatalogPrice` 读取路由价格 |

公开快照不包含上游地址、Key 引用、Key、管理员证据原文或采购成本。官网价格只按完整相等的
`canonicalVendor + canonicalModel` 身份匹配；身份未知的中转别名保持未匹配。平台价按
`providerId/modelId` 路由键单独匹配，两个渠道的同名模型不会共用价格。

### 管理接口与授权

管理接口位于 `/api/admin/catalog/*`，使用既有 Bearer access token，并要求账号 ID 在
服务端环境变量 `ACCOUNT_PLATFORM_ADMIN_IDS` 的逗号分隔 allowlist 中。公开注册、客户端 JWT
自带 role 或普通用户请求都不能授予管理权限。未配置 allowlist 时管理端默认无人可用。

- `GET/POST /api/admin/catalog/providers`、`PATCH /api/admin/catalog/providers/:providerId`
- `GET /api/admin/catalog/models`、`POST /api/admin/catalog/providers/:providerId/models`、
  `PATCH /api/admin/catalog/providers/:providerId/models/:modelId`
- `GET/POST /api/admin/catalog/providers/:providerId/models/:modelId/prices`；
  `POST .../prices/preview` 先预览逐桶变化，再提交新版本
- `GET/POST /api/admin/catalog/official-prices` 登记与审查官网价格证据

Provider 的上游地址仅能通过管理 API 读写；上游凭据只接受 `env:NAME` 或 `secret://...`
形式的**服务端引用名**，不会接收或回传原始 Key。管理视图只返回 `credentialConfigured` 和
`credentialRotatedAt`。D10 不负责解析引用或发送模型请求；网关执行属于后续平台调用任务。

### 价格与证据语义

发布价格使用 `@ec/core` 的 `PriceVersion` 契约：费率为币种微单位/百万 Token，缓存写费率是完整费率。
`null` 表示未定价，`0` 表示免费。桶未定价时该桶费用仍未知，不会从官网快照或另一 Provider 补入。
官网估算只使用已登记的 source URL、核验时间、版本、SHA-256 证据快照和适用条件；本服务保留
证据原文以便管理员审计，公开快照只发送证据链接、版本和哈希。

价格发布和官网证据均为 append-only；数据库触发器拒绝直接 UPDATE/DELETE。`effectiveTo` 从下一
版本 `effectiveFrom` 推导，改价只会追加未来版本。服务不预置真实 Provider/模型售价或官网快照；
测试里的 URL 和金额是明确标为合成夹具的值。API 校验 HTTPS 与管理员来源，但不会自动判定域名
是否属于该厂商；管理员需在录入前人工核验来源。

## V2-D11 平台钱包、预占与对账

`0005_wallet_ledger` 增加独立于客户端本地用量记录的服务端钱包、预占、计费 attempt、不可变流水、预算策略、对账队列和审计事件。余额按定点微单位整数保存：`availableMicros = postedMicros - heldMicros`。数据库触发器阻止无匹配流水的余额改写、流水/价格快照/对账受理记录的修改删除，以及 attempt/hold 状态倒退。

用户只能读取自己各币种钱包、账本和 attempt；管理员 allowlist 才能调整额度、设置预算、查对账队列和冲正。管理员额度调整及冲正要求 `Idempotency-Key` 和原因，调整、预占、结算、释放和冲正都与钱包变化处于同一 SQLite `BEGIN IMMEDIATE` 事务。日/月硬预算按币种原子检查；两个上限都为 `null` 表示移除该预算策略。未配置前不擅自设免费额度或币种规则。

`WalletLedger.reserveAttempt()` 只接受服务端传入的上下文估算，并从 D10 的不可变平台价或已核验官网快照读取价格；按受理时快照调用 `@ec/core/v2` 的 `computeUsageCost` 算预占。结算同样只收可信最终 Token 分桶，不收客户端金额。精确费用无法确定、上游执行状态未知或可用余额不足时保留冻结并开待对账记录。只有标记为未派发的请求可直接释放；开始派发后取消必须保持待对账，管理员确认未执行后才可释放。`buildApp` 启动时把超出租约且未结束的 attempt 转入对账队列，不自动归零或释放。

`WalletLedger` 不暴露接受客户端金额或 usage 的原始预占/结算写接口。D12 的 `/api/ai/requests` 是唯一面向桌面托管流量的受控入口：它按 D10 目录解析 Provider+Model，固定价格快照并预占，再由服务端适配器取得上游 Key、转发流式结果并用可信最终 usage 结算。**没有在线充值、支付商户、支付回调或真实支付接入**；充值只能等运营与支付方案确认后另行实施。人工额度调整是有审计的后台入账能力，不代表在线充值。

用户读接口：`GET /api/wallets`、`GET /api/wallets/:currency`、`GET /api/wallets/:currency/ledger`、
`GET /api/billing/attempts` 和 `GET /api/billing/attempts/:attemptId`。管理员接口：
`GET /api/admin/wallets/:accountId/:currency`、`POST .../adjustments`、`PUT .../budgets`、
`GET /api/admin/billing/reconciliation`、`POST .../reconciliation/:attemptId/resolve`、
`POST .../attempts/:attemptId/reversal`。所有用户账单读接口按访问令牌账号过滤；管理员写接口继续由
`ACCOUNT_PLATFORM_ADMIN_IDS` allowlist 限定。

对账租约与提醒期限可经 `ACCOUNT_BILLING_ATTEMPT_LEASE_MS`（默认 30 秒）和
`ACCOUNT_BILLING_RECONCILIATION_SLA_MS`（默认 24 小时）配置。SLA 超期只会显示在管理员队列，不能自动释放余额。

## V2-D12 平台可信网关与桌面托管模式

桌面端同步 `/api/catalog/snapshot` 后只在本机创建指向账号服务 `/api/ai/requests` 的平台路由，模型名携带 D10 的稳定 Provider+Model ULID。渲染层不接触账号令牌或上游 Key；Electron 主进程从 DPAPI 会话读取账号 access token。服务端从 D10 目录读取上游地址/凭据引用，并从 `env:NAME` 或 `secret://relative/path` 解析密钥；明文只在请求内存中存在，不返回客户端、不写入账单。

托管请求必须带 `Idempotency-Key`（作为 attempt ULID）与 `X-EC-Logical-Request-Id`。attempt 按受理时价格快照预占；OpenAI/Anthropic 流式协议由共享适配器解析后转成带 `V2EventEnvelope` 的 SSE。只有上游报告完整、可信最终用量且费用可精确计算时才结算。内容指纹只保存 SHA-256，不保留提示词或生成正文。明确的上游 4xx 拒绝会释放预占；派发后断流、取消、用量缺项或服务异常会保留预占并转待对账，不自动重发。用 `GET /api/ai/requests/:attemptId` 查询本人状态，再由管理员按 D11 对账流程核实；不得将未知状态当作未执行。

服务端上游默认必须为 HTTPS，DNS 解析结果拒绝环回、私网、链路本地及保留地址，连接阶段固定使用已校验地址且不跟随重定向。`ACCOUNT_GATEWAY_ALLOW_LOOPBACK=true` 只供本机受控测试上游使用；生产不得启用。上游密钥目录可用 `ACCOUNT_PLATFORM_SECRET_DIR` 配置（默认 `data/platform-secrets`），该目录和文件须限制服务运营账号读取。目录停用/维护、缺少价格或未配置凭据都会在派发前拒绝。

BYOK 仍由本机安全进程直接访问用户自选上游，Key 留在本机 DPAPI；不会因同步平台目录而生成本地 Provider，也不会向平台上传 BYOK Key。平台停服或登出只会使托管请求不可用。

受控本地 HTTP 上游集成覆盖平台路由、密钥注入、预占、流式转发、最终结算、幂等重放/内容冲突、显式取消、客户端断流、未知 usage、上游明确拒绝、停用目录与 SSRF 拒绝。未接入真实厂商付费流量，测试价格和上游密钥均为合成夹具。

## 技术栈

- Node.js 24 + Fastify（HTTP 框架）
- better-sqlite3（本地 SQLite 存储，原生模块，按 Node 24 编译）
- zod（入参校验）
- 认证：Node 内置 `node:crypto` 手写 HMAC-SHA256 JWT（不引入 jsonwebtoken），密码使用 `scrypt` + 随机盐
- 运行期依赖：`@ec/ai`、`@ec/core`、`@ec/data`、`fastify`、`better-sqlite3` 与 `zod`

## 设计要点

- **统一错误结构** `{ code, message, traceId }`；未捕获异常不泄漏堆栈。
- **bindings 列表**当前返回全部绑定与空 `nextCursor`，未实现 `limit`/`cursor` 分页。
- **幂等键**：一般写接口使用 `account_idempotency` 响应缓存；钱包写操作将请求指纹和账本变更放在同一事务校验，同键不同内容返回冲突。
- **限流**：登录/注册每 IP 每分钟 20 次（内存令牌桶，可经环境变量调整）。
- **审计日志脱敏**：密码、令牌、邮箱等敏感字段只记前 4 位 + `***`。
- **自注册开通**：注册即创建默认工作区（名「个人工作区」）并授予免费权益包（`planId = free`），无人工审核。
- **OAuth**：服务端校验客户端传入的 `code_challenge`（PKCE S256）；`state` 内存暂存并带有效期。

## 目录结构

```
services/account/
├── src/
│   ├── server.ts            # 入口（监听端口）
│   ├── app.ts               # 应用装配（buildApp + inject 测试）
│   ├── config.ts            # 配置（环境变量覆盖）
│   ├── crypto.ts            # 密码哈希 scrypt
│   ├── jwt.ts               # HMAC-SHA256 JWT + PKCE
│   ├── errors.ts            # 统一业务异常与错误码
│   ├── logger.ts            # 审计与脱敏
│   ├── db.ts                # SQLite 初始化与三段式迁移
│   ├── auth-tokens.ts       # 令牌签发 / 鉴权前置
│   ├── models/account.ts    # 账号数据访问层
│   ├── models/platform-catalog.ts # 平台目录与不可变价格存储
│   ├── models/wallet-ledger.ts # 服务端钱包、attempt 与账本
│   ├── routes/              # auth / usage / release / catalog / wallet / admin / ai-gateway 路由
│   ├── gateway/             # 上游地址防护与服务端凭据引用解析
│   ├── oauth/               # google / github / wechat 策略 + 流程
│   ├── middleware/          # error / idempotency / rate-limit
│   └── __tests__/           # 集成测试
├── migrations/              # 0001～0006 三段式迁移（目录/价格/钱包账本/账单筛选字段）
├── Dockerfile
├── scripts/                # SQLite 一致性备份与显式确认恢复
├── start.sh / start.cmd
└── openapi.yaml
```

## 本地运行

```bash
# 依赖安装（使用腾讯镜像）
corepack enable
pnpm install --registry=https://mirrors.cloud.tencent.com/npm/

# 开发 / 启动
pnpm dev          # 或 pnpm start
# 测试
pnpm test
# 类型检查
pnpm typecheck
```

环境变量（均带默认值，详见 `src/config.ts`）：`ACCOUNT_HOST`、`ACCOUNT_PORT`、`ACCOUNT_DB_PATH`、
`ACCOUNT_JWT_SECRET`、`ACCOUNT_ACCESS_TTL`、`ACCOUNT_REFRESH_TTL`、
`ACCOUNT_LOGIN_LIMIT`、`ACCOUNT_REGISTER_LIMIT`、`ACCOUNT_OAUTH_*_ID/SECRET/REDIRECT` 等。
V2-D10/D11 使用 `ACCOUNT_PLATFORM_ADMIN_IDS`（逗号分隔的平台运营账号 ID；为空时不启用管理权限）。
托管网关使用 `ACCOUNT_PLATFORM_SECRET_DIR`（`secret://` 凭据根目录）；生产上游只能使用 HTTPS 且不得解析到本机/内网。`ACCOUNT_GATEWAY_ALLOW_LOOPBACK=true` 仅用于受控本机测试，公网部署不得启用。

### 邮件与邮箱验证（FR-ACC-08）

| 变量                               | 默认值                       | 说明                                                                      |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| `ACCOUNT_PUBLIC_BASE_URL`          | `http://localhost:<PORT>`    | 服务对外基础地址。**公网/反代部署必须设置**，否则邮件里会出现 `localhost` |
| `ACCOUNT_EMAIL_VERIFY_BASE_URL`    | 取 `ACCOUNT_PUBLIC_BASE_URL` | 验证链接前缀，最终链接为 `<该值>/verify-email?token=…`                    |
| `ACCOUNT_EMAIL_VERIFY_TTL`         | `86400`（24h）               | 验证链接有效期（秒）                                                      |
| `ACCOUNT_PASSWORD_RESET_TTL`       | `600`（10min）               | 重置验证码有效期（秒）                                                    |
| `ACCOUNT_EMAIL_RESEND_COOLDOWN_MS` | `60000`                      | 同一用户同类邮件最小发送间隔（限流）                                      |
| `ACCOUNT_MAIL_WEBHOOK_URL`         | 空                           | 邮件投递 webhook；留空时写入开发 outbox，生产须配置真实投递               |

验证链接由本服务自托管（`GET /verify-email`），**不依赖桌面端是否运行**：用户常在邮件客户端里
点开链接，此时应用可能根本没启动。链接令牌单次有效、过期拒绝。

验证使用随机 URL 安全令牌；服务端按 SHA-256 哈希查询，再检查有效期及消费状态，不是客户端验签
JWT 链接。重置码成功使用后失效，旧 refresh 全部撤销。默认 24 小时验证有效期、10 分钟重置有效期，
同账号同类邮件默认冷却 60 秒；这些发送限制不应描述为完整的验证码错误尝试锁定策略。
当前未验证邮箱也可登录。注册接口本身只建号；renderer 注册表单随后调用发送验证邮件接口，
直接使用 API 的调用方需执行同样的第二步。

仅本地开发期取验证令牌 / 重置码（生产默认关闭）：

```bash
curl http://localhost:3000/api/dev/email-outbox            # 最近 20 封（正文含链接或 6 位验证码）
curl 'http://localhost:3000/api/dev/email-outbox?limit=50'
```

### 开发环境完整操作

1. 仓库根执行 `pnpm --filter @ec/account-service dev`，默认 `http://localhost:3000`；
   `ACCOUNT_MAIL_WEBHOOK_URL` 留空，邮件写入 `account_email_outbox`。
2. 在客户端注册新邮箱。用上述 outbox 端点读取验证邮件的 `body`，在浏览器打开其中的链接；
   页面显示“邮箱验证完成”后回客户端刷新验证状态，退出后用原密码登录，状态应保持已验证。
3. 在登录页进入“找回密码”，输入邮箱请求验证码；outbox 中取 `kind=reset` 邮件的 6 位码，
   提交验证码和新密码。确认新密码可登录、旧密码失败、旧 refresh 不能再换令牌。
4. 重用验证链接或重置码应被拒绝；等待过期后使用也应被拒绝。同邮箱同类邮件在冷却期内重发应得到 429。
   测试环境可在启动前缩短 `ACCOUNT_EMAIL_VERIFY_TTL` / `ACCOUNT_PASSWORD_RESET_TTL`，只对之后签发的令牌生效。

**投递与部署边界**：配置 `ACCOUNT_MAIL_WEBHOOK_URL` 后服务 POST `{ to, subject, text, kind }`，
由接收方完成真实投递；本服务没有内置 SMTP 配置。当前网络异常会回写 outbox，HTTP 非 2xx 响应不会
触发这条回退，亦未实现自动重试队列。`/api/dev/email-outbox` 仅在非 production 且
`ACCOUNT_ENABLE_DEV_EMAIL_OUTBOX` 未设为 `false` 时启用；正式容器强制关闭。容器部署、TLS、备份
与恢复步骤见 [V2-D13 交付说明](../../docs/V2-D13-WEB.md)。

### 自动化与手工验收

2026-09-30 服务端实测 3 文件 / 26 项通过（account 10、contract 7、email-flow 9）。
新增证据包含邮件链接可达、静态 HTML 不反射 token、confirm 的 `{ ok: true }` 与页面成功判据一致，
以及 PKCE 校验失败后的 state 消费。2026-10-01 仅同步文档，未据此声称重新执行测试。

复跑：仓库根执行 `pnpm --filter @ec/account-service test --no-file-parallelism`。
真实投递与第三方凭据验收见 [E2E 清单 M-01/M-02](../../docs/E2E-CHECKLIST.md)。

---

Copyright 2026 EveryoneCoding. Licensed under the Apache License, Version 2.0 — 见仓库根目录 [LICENSE](../../LICENSE)。
