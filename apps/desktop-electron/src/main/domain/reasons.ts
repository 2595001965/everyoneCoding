import type { DomainKind } from '@ec/shell-api';

/**
 * 未装配域的原因（面向用户展示，由 `describe()` 回传渲染层并写进启动日志）。
 *
 * 纪律：这里写的必须是**真实原因**。渲染层据此保留对应页面的装配引导，
 * 谎报可用会让用户看到一个"能打开但每个动作都失败"的界面，比引导页更差。
 *
 * 维护方式：某域落地后，从本表删掉对应条目，并在 `main/index.ts` 的
 * `createDomainRuntime({ routers })` 里补上该域的路由。
 *
 * 另：四个域均已装配（settings 16/16、workspace 18/19、docs 20/20、auth 14/14）。
 * 仍有个别方法按归口待接线：workspace 的 `importFromGit`（需 @ec/git 的克隆能力）。
 * 这些调用会得到带原因的 NOT_SUPPORTED，不做静默降级。
 *
 * auth 域另有运行时前置：系统加密能力（safeStorage/DPAPI）不可用时**不装配**，
 * 原因在 `main/index.ts` 里动态给出；装配成功后若账号服务不可达，域内进入离线模式
 * （`isOffline` 如实反映）——这与"域未装配"是两回事。
 */
export const UNAVAILABLE_DOMAIN_REASONS: Partial<Record<DomainKind, string>> = {};
