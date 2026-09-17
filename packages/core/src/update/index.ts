/**
 * 更新领域（T10-04 / FR-SET-05）：
 * - `update-types`：版本号解析与比较（语义化版本子集）
 * - `update-policy`：静默检查节奏、渠道过滤、稍后提醒、自动下载的**纯决策函数**
 * - `update-ledger`：更新回滚台账（pending-healthy → healthy / rolled-back）
 * - `update-runner`：把上述决策串成「检查→提示→安装→健康确认→失败回滚」的编排（端口注入）
 */

export * from './update-types';
export * from './update-policy';
export * from './update-ledger';
export * from './update-runner';
