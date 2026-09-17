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
 * 另：settings 域已装配，但其中 `exportProject` / `importPackage` 两个方法
 * 依赖工程目录与文档的存储布局（属 workspace / docs 域的写路径），随之落地；
 * 当前调用会得到带原因的 NOT_SUPPORTED，详见 `domain/settings.ts` 的顶部说明。
 */
export const UNAVAILABLE_DOMAIN_REASONS: Partial<Record<DomainKind, string>> = {
  workspace: '工作台域尚未装配：缺 SQLite ProjectStore 与 ProjectService 装配、仪表盘五项指标聚合',
  docs: '文档域尚未装配：缺 SQLite DocStore 与 DocService 装配、Node 侧解析器注册表',
  auth: '账号域尚未装配：需可用的账号服务与 OAuth 凭据',
};
