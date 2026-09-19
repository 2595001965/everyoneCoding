# 云端账号服务端（EveryoneCoding · Apache-2.0）

账号服务端最小实现，对应任务卡 **T9-06**。客户端可完全离线工作，服务端**仅负责账号注册/登录与版本更新**。

## 已实现接口（严格按 PRD §8）

| 方法            | 路径                                  | 说明                                                                             |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| POST            | `/api/auth/register`                  | 邮箱注册，自注册即开通（默认「个人工作区」+ 免费权益包 `free`）                  |
| POST            | `/api/auth/login`                     | 邮箱 + 密码登录                                                                  |
| GET             | `/api/auth/oauth/:provider/authorize` | 发起 OAuth（provider = `wechat` \| `google` \| `github`），返回授权 URL 与 state |
| GET             | `/api/auth/oauth/:provider/callback`  | 回调换令牌；首次授权自动建号                                                     |
| POST            | `/api/auth/refresh`                   | Refresh Token 换新 Access Token（旧 refresh 轮换失效）                           |
| GET/POST/DELETE | `/api/auth/bindings`                  | 第三方身份绑定：列出 / 绑定 / 解绑                                               |
| POST            | `/api/usage/report`                   | 匿名用量上报（需授权）                                                           |
| GET             | `/api/release/check`                  | 版本检查，按 `?form=tauri\|electron` 分别下发版本与增量包清单                    |

## 明确边界（验收要求）

> **本服务不提供云同步、远程配置下发与分享链接。**

依据 PRD §2.2 决策，下列接口**已被移除且不实现**：`/api/config/remote`、`/api/sync/memory`、`/api/sync/project-meta`、`/api/share`。用户配置与同步由客户端本地处理（远程配置走用户自配 URL，数据同步走 `.ecpkg` 手动导入导出，预览仅限本地/局域网）。

## 技术栈

- Node.js 24 + Fastify（HTTP 框架）
- better-sqlite3（本地 SQLite 存储，原生模块，按 Node 24 编译）
- zod（入参校验）
- 认证：Node 内置 `node:crypto` 手写 HMAC-SHA256 JWT（不引入 jsonwebtoken），密码使用 `scrypt` + 随机盐
- 仅运行期依赖：`fastify` + `better-sqlite3` + `zod`

## 设计要点

- **统一错误结构** `{ code, message, traceId }`；未捕获异常不泄漏堆栈。
- **分页**采用 cursor（`bindings` 列表支持 `?limit=&cursor=`）。
- **幂等键**：所有写接口支持 `Idempotency-Key` 头，重复提交返回首次结果（落库 `account_idempotency`）。
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
│   ├── models/account.ts    # 数据访问层
│   ├── routes/              # auth / usage / release 路由
│   ├── oauth/               # google / github / wechat 策略 + 流程
│   ├── middleware/          # error / idempotency / rate-limit
│   └── __tests__/           # 集成测试
├── migrations/0001_init.sql # 三段式迁移
├── Dockerfile
├── docker-compose.yml
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

> 生产部署请使用 Docker（`docker compose up --build`），并将 `ACCOUNT_JWT_SECRET` 设置为强随机值。

---

Copyright 2026 EveryoneCoding. Licensed under the Apache License, Version 2.0 — 见仓库根目录 [LICENSE](../LICENSE)。
