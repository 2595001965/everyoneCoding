# V2-D11 验收记录

日期：2026-10-03

## 前置核验

- **D05 已验收**。复跑 `packages/ai/src/gateway/__tests__/metering-flow.test.ts`：5/5 通过。
- **D10 已实现待验收**。检查账号服务 D10 目录/价格实现，复跑 `services/account/src/__tests__/catalog.test.ts`：3/3 通过。D11 按服务端 D10 价格版本表及核验官网快照加载受理价格；未将 D10 状态提升为已验收。

## 本次交付

- 服务端 `0005_wallet_ledger` 新增独立钱包、预算策略、计费 attempt、预占、不可变钱包流水、对账队列和不可变审计事件。客户端本地 `usage_record` / `account_usage_report` 不充当平台账本。
- `WalletLedger` 接入账号服务应用装配，向后续 D12 提供 reserve、dispatch、lease renewal、unknown、trusted settlement、undispatched release、reconciliation 和 reversal 操作。预占/结算/释放/冲正使用 SQLite immediate transaction；余额检查、attempt/hold 与流水同事务。
- 受理时按 D10 不可变平台价或已核验的精确模型身份官方快照，固化 `PriceVersion` JSON。预占与结算都复用 `@ec/core/v2` `computeUsageCost`；只接收 Token 分桶，不接收请求方提供的扣款金额。
- 普通用户只读自己的钱包、流水和 attempt；管理员 allowlist 才能作审计式额度调整、预算设置、查看/解决待对账项及冲正。未知状态保留冻结和受理价格，不自动归零；只确认未派发的请求能由网关直接释放，已进入派发/未知状态须经最终用量或管理员对账。
- 当前未实现在线充值、支付回调或支付商户接入。额度调整属于人工后台账务动作，不代表真实支付。

## 验收结果

- `services/account` 全套 Vitest：5 个文件、36 项通过；包括 D10 catalog 3 项和 D11 wallet 7 项。
- 真实 SQLite 文件由两个独立 Worker thread 并发争抢同一钱包预占，结果一笔成功、一笔因可用余额不足拒绝；余额为 posted 10,000、held 6,000、available 4,000，无透支。
- 其他 D11 用例验证：精确受理价格在未来调价后不变；官方证据快照可结算；相同预占/结算/冲正重放不产生第二笔流水；相同调整幂等键搭配不同内容冲突；派发后的取消不释放冻结；超出租约的 attempt 在重开数据库后仍待对账；确认未执行才释放；未定价最终用量保留未知状态；预算在同事务中拒绝超额预占；流水写入失败整笔事务回滚，关闭并重开数据库后余额和 attempt 均无半写入。
- 服务端 TypeScript strict 检查通过；`packages/core` TypeScript 检查通过。

## 边界与后续

- 账号服务暂以可配置的 30 秒派发租约和 24 小时对账 SLA 为默认运行值；超期仅进入管理员可见队列，不会自动释放。
- D12 尚未将真实平台网关流量接入这些内部 attempt 方法；D11 完成账务存储和生命周期 API，不等于平台调用已开放。
- 测试只使用合成价格和本地 SQLite 文件，不产生外部 Provider 调用或真实支付费用。
