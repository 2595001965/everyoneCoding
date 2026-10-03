# V2-D13 网站、管理台与本地部署

日期：2026-10-03。实现复用账号服务和 D10/D11/D12 的目录、账本与 AI 网关接口；本网站不是桌面设置页或浏览器 IDE。

## 网站范围

- `/`、`/catalog`、`/privacy`：公开产品说明、可配置下载入口、服务健康状态、平台公开目录与价格快照。
- `/auth`：复用既有邮箱/密码注册和登录接口。Access token 只保存在当前页面内存，刷新后要求重新登录；不使用 cookie、localStorage 或 sessionStorage。
- `/account`：显示本人钱包、冻结/可用金额、账本和平台请求账单；账单从服务端游标分页，并按日期、Provider、模型、项目和会话筛选。服务端仍按 account ID 隔离数据。
- `/admin`：展示渠道、模型、价格预览/发布、官网价格证据、人工额度调整、预算、对账队列和审计。页面是否显示不是授权边界；每个管理 API 都重新检查服务端 `ACCOUNT_PLATFORM_ADMIN_IDS`。
- 平台公开目录只暴露已发布字段，不暴露上游地址、凭据引用/密钥、内部证据原文或采购成本。目录刷新失败时保留上次快照并显示错误提示；空目录显示明确空状态。

D10 仍为“已实现待验收”，没有真实 Provider 与价格种子。本地验收可以使用明确标为本地夹具的虚构 Provider/价格，不能把夹具写成官网来源或可用于生产的真实价格。

## 本地启动

需要 Docker Engine + Compose v2。以下命令从仓库根目录运行；首次生成随机 JWT secret：

```powershell
node deploy/bootstrap-local.mjs
docker compose --env-file deploy/.env -f deploy/compose.yml up --build -d
docker compose --env-file deploy/.env -f deploy/compose.yml ps
```

打开 `http://127.0.0.1:8080`。网站端口只绑定本机回环；账号容器没有宿主机端口映射，只能由网站容器访问。开发时也可分别运行 `pnpm --filter @ec/account-service dev` 和 `pnpm --filter @ec/platform-web dev`，Vite 网站地址为 `http://127.0.0.1:5174`。

本地注册一个管理员账号后，从账号中心复制 account ID，在 `deploy/.env` 设置 `ACCOUNT_PLATFORM_ADMIN_IDS=<account-id>`，重启服务：

```powershell
docker compose --env-file deploy/.env -f deploy/compose.yml up -d --force-recreate account web
```

allowlist 只接受服务端环境配置，普通用户不能通过注册字段或自带 JWT role 获取管理员权限。不要把 `.env` 或 `deploy/secrets/platform/` 提交到版本库；在 Windows 上也要用 ACL 限制 `deploy/.env` 的读取者，`.gitignore` 不等于文件访问控制。为生产 Provider 配置密钥时，使用权限受限的 secret 文件和 `secret://` 引用；不在管理表单、日志或截图里填写/展示密钥。

常用操作：

```powershell
docker compose --env-file deploy/.env -f deploy/compose.yml logs --tail=100 account web
docker compose --env-file deploy/.env -f deploy/compose.yml restart account web
docker compose --env-file deploy/.env -f deploy/compose.yml down
```

`down` 保留命名卷中的账号数据库。只有明确要删除本地全部账号与账务数据时才运行带 `-v` 的命令。

## 上线前的安全边界

- compose 默认仅供本机使用：`web` 绑定 `127.0.0.1`，不发布账号端口；开发邮件 outbox 和 loopback 上游测试入口在 production 容器中关闭。
- 公网服务须另行获准并由 TLS 反向代理终止 HTTPS。只允许受控代理连接 web 端口；代理必须覆盖（不能追加客户端伪造的）`X-Forwarded-Proto`。确认代理配置后设置 `ACCOUNT_REQUIRE_HTTPS=true`，服务会拒绝非 HTTPS 请求并返回 426。Compose 内部健康探针通过受信任的容器回环/私网链路发送 HTTPS 标记，以便启用强制 HTTPS 时仍能检查进程健康；这不能替代外部 TLS 终止与代理头覆盖。不得以关闭证书校验绕过 TLS 错误。
- 网站与 API 走同源路径，没有启用 CORS；前端 `fetch` 使用 same-origin、`credentials: omit`、`redirect: error`。认证不依赖浏览器自动携带的 cookie，因此没有 cookie CSRF 信任边界。Access token 只存在内存并通过显式 Bearer header 发送。
- Nginx 设置 CSP、`X-Frame-Options`、nosniff、Referrer-Policy、Permissions-Policy；静态 bundle 不含 source map。验证邮箱页把脚本和样式作为同源静态资源提供，不需要 CSP inline 放行，页面不回显 URL token。TLS 终止代理需配置 HTTPS/HSTS 策略。Nginx access log 只写 `$uri`，不记录 query string、请求体或 Authorization header；带单次 token 的 `/verify-email` 路由将 Nginx error log 降到 `crit`，入口代理也必须配置成不记录此路由的 query string。
- D12 上游访问仍经过地址解析、DNS 固定及私网/元数据地址拒绝；正式环境禁止 `ACCOUNT_GATEWAY_ALLOW_LOOPBACK`。不要把公开服务配置成用户可任意提交 URL 的代理。
- 人工额度调整要求原因、幂等键并写入审计；页面明确标识为人工调整。网站没有支付商户、支付表单或“支付成功”状态，不能用余额调整冒充在线支付。真实使用账单只能来自 D12 上游响应和可信 usage 结算。
- 公网运营前仍需单独决定域名、数据保留周期、隐私/账务删除规则、邮件投递和管理员名单；本卡不会自动发布公网服务。

## SQLite 备份与恢复

`better-sqlite3` 在线 backup API 生成一致快照，随后执行 `integrity_check` 和 `foreign_key_check`。镜像以 `node` 非 root 用户运行，生产数据库位于权限为 `0700` 的命名卷 `/data`；POSIX 快照、stage 文件和恢复前快照均收紧为 `0600`。创建快照：

```powershell
docker compose --env-file deploy/.env -f deploy/compose.yml exec -T account node scripts/backup.mjs /data/backups/account-2026-10-03.sqlite
$accountContainer = docker compose --env-file deploy/.env -f deploy/compose.yml ps -q account
docker cp "${accountContainer}:/data/backups/account-2026-10-03.sqlite" ./account-2026-10-03.sqlite
```

把导出的快照放在账号卷以恢复（先保存当前快照到安全位置）：

```powershell
$accountContainer = docker compose --env-file deploy/.env -f deploy/compose.yml ps -q account
docker compose --env-file deploy/.env -f deploy/compose.yml stop web account
docker cp ./account-2026-10-03.sqlite "${accountContainer}:/data/restore.sqlite"
docker compose --env-file deploy/.env -f deploy/compose.yml run --rm --no-deps account node scripts/restore.mjs /data/restore.sqlite
docker compose --env-file deploy/.env -f deploy/compose.yml run --rm --no-deps account node scripts/restore.mjs /data/restore.sqlite --apply
docker compose --env-file deploy/.env -f deploy/compose.yml up -d account web
docker compose --env-file deploy/.env -f deploy/compose.yml ps
```

不带 `--apply` 的恢复命令只验证文件并打印目标路径，预期退出码为 2，数据库不变；实际替换必须显式带 `--apply`。恢复脚本拒绝与数据库同路径的输入及损坏/外键不一致的快照。`--apply` 之前必须停掉服务；如果 WAL/SHM sidecar 仍存在，脚本会调用 SQLite checkpoint 并确认没有未写入的数据，不会手工删除 sidecar。它会先创建恢复前 SQLite 快照，再保留被替换的原数据库文件；启动后会应用待执行迁移。最后确认 `/health` 正常并用预期账号核对余额/账单。定期把导出的快照复制到独立、受访问控制的存储，并按业务恢复点目标保留多份；只保留数据库卷不算备份。

## 验证记录

- 自动化：账号服务 Vitest 7 个文件、45 项通过；包含 D13 安全响应头、无 CORS、生产 outbox 关闭、HTTPS 拒绝、按用户隔离的账单过滤/分页、管理员 allowlist 和审计接口；也复跑 D11/D12 服务测试。账号与网站 TypeScript 检查、Vite production build、Node 脚本语法检查通过。
- 真实浏览器：本地首页/公开目录、未知密码错误、普通用户钱包与账单空态、普通用户访问 `/admin` 的服务端 403、管理员创建 Provider/Model 并预览/发布价格、公开页费率和管理员审计均已查看。窄屏 390px 检查 document/body 宽度 375px，无水平溢出。发布的 `D13 本地价格夹具` 明确是虚构、维护中、不可路由的本地验收数据，不是官网价或真实上游；没有发起上游请求或制造 usage attempt。未用人工调整伪装支付。
- 账单：浏览器确认无钱包/无真实账单时显示空态；账号服务测试用独立 fixture 覆盖真实账本查询、筛选、翻页和跨账号隔离。因为没有经过上游的真实托管调用，未在浏览器制造收费 attempt。
- 备份恢复：在临时 SQLite 数据库上对运行中的服务生成在线快照并执行 integrity/foreign-key 校验；停服后 dry-run 明确不改文件，带 `--apply` 后创建 pre-restore 快照、替换数据库并重启，`/health` 为 200，浏览器还能读出之前的目录/合成价格。Restore 若遇到 sidecar 会请求 SQLite checkpoint，不直接删除文件。
- 环境限制：本工作机没有 Docker CLI；Compose YAML/容器镜像未运行，不能声称干净容器部署已实测。Compose 与 Dockerfile 已交付；有 Docker 的环境需补一次容器 build/up/healthcheck 验收。此限制已记入任务总表。
