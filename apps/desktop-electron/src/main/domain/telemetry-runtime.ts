import type Database from 'better-sqlite3';

import {
  Telemetry,
  TelemetryClient,
  buildEvent,
  type KeyEventName,
  type TelemetryEventPayload,
} from '@ec/core';

import { createTelemetryFileStore } from './telemetry-store';

/**
 * 主进程遥测运行时（T10-01 / FR-SET-06 / NFR-S-03）。
 *
 * ## 为什么需要它
 *
 * `TelemetryClient` 与 `Telemetry` 在 `@ec/core` 里实现完备，但**没有任何生产调用点**：
 * 关键路径（项目创建、阶段推进、导出导入、登录…）跑完不产生任何埋点，
 * 于是「关键路径埋点覆盖率 ≥90%」在真实运行中无从谈起，隐私面板也没有对象可清。
 *
 * ## 三条硬约束（逐条落到代码）
 *
 * 1. **默认关闭**：授权位来自 `settings.privacy.telemetryEnabled`（默认 false）。
 *    未授权时 `track()` 直接返回，**不写缓冲、不发网络**——不是"发了再丢"。
 * 2. **只允许白名单字段**：所有事件经 `buildEvent()` 构造，它内部调
 *    `assertEventPayloadSafe()`；夹带内容字段（提示词/代码/文档正文/Key）会**抛错**，
 *    在开发期就把问题暴露出来，而不是悄悄上传。
 * 3. **一键清除覆盖三层**：内存队列（Telemetry 实例）、文件缓冲（telemetry-buffer.json）、
 *    数据库记录（本仓库遥测不落库；若有历史遗留表则一并清空）。
 *    「清除内存、文件缓冲和数据库记录」是验收明文要求，缺一层都算没清干净。
 *
 * ## 边界
 *
 * 本模块只负责"记录与本地缓冲"，**不做任何网络上报**：
 * `Telemetry` 的 endpoint 未配置时 `flush()` 直接返回 false（零网络调用）。
 * 用户未显式配置上报端点，数据就只留在本地缓冲里。
 */

export interface TelemetryRuntimeOptions {
  /** 业务库（用于清理可能存在的遥测表） */
  db: Database.Database;
  /** 本地缓冲文件路径 */
  bufferPath: string;
  /** 是否已获用户显式授权（来自 settings.privacy.telemetryEnabled） */
  enabled: boolean;
}

export interface TelemetryRuntime {
  /** 记录一条关键路径事件（未授权时零副作用） */
  track(payload: TelemetryEventPayload): void;
  /** 便捷入口：按事件名构造并记录 */
  record(
    name: KeyEventName,
    result: TelemetryEventPayload['result'],
    extra?: {
      durationMs?: number;
      errorKind?: string;
      dims?: Record<string, string | number | boolean>;
    },
  ): void;
  /** 运行时切换授权（设置页调用） */
  setEnabled(enabled: boolean): void;
  /** 本地缓冲条数 */
  buffered(): number;
  /** 待发（内存队列）条数 */
  pending(): number;
  /** 一键清除：内存 + 文件缓冲 + 数据库记录 */
  clearAll(): { memoryCleared: number; fileCleared: number; dbCleared: number };
  /** 清点（隐私面板展示） */
  inspect(): { telemetryRecords: number; pendingRecords: number };
}

/**
 * 遥测**不落库**是本项目的既定口径（本地缓冲用 JSON 文件）。
 * 这里仍显式尝试清理同名历史表：早期版本或第三方插件可能建过，
 * 「数据库记录」这一层不能因为"我们没建过"就跳过。
 */
const LEGACY_TELEMETRY_TABLES = ['telemetry_event', 'telemetry_record'] as const;

export function createTelemetryRuntime(options: TelemetryRuntimeOptions): TelemetryRuntime {
  const store = createTelemetryFileStore(options.bufferPath);
  const telemetry = new Telemetry({ enabled: options.enabled });
  const client = new TelemetryClient({ telemetry, store });

  const clearDbRecords = (): number => {
    let cleared = 0;
    for (const table of LEGACY_TELEMETRY_TABLES) {
      const exists = options.db
        .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) as { x: number } | undefined;
      if (!exists) continue;
      const before = options.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      };
      options.db.prepare(`DELETE FROM ${table}`).run();
      cleared += before.n;
    }
    return cleared;
  };

  return {
    track(payload: TelemetryEventPayload): void {
      // 未授权：TelemetryClient.track 内部即返回（零缓冲、零 IO）
      client.track(payload);
    },

    record(name, result, extra): void {
      // buildEvent 内含白名单断言：夹带内容字段会抛错，绝不静默上传
      this.track(buildEvent(name, result, extra));
    },

    setEnabled(enabled: boolean): void {
      telemetry.setEnabled(enabled);
      // 撤销授权时立刻清空本地缓冲：用户点"关闭"就是不想留数据
      if (!enabled) client.clearLocalBuffer();
    },

    buffered(): number {
      return client.buffered();
    },

    pending(): number {
      return telemetry.pending;
    },

    clearAll(): { memoryCleared: number; fileCleared: number; dbCleared: number } {
      const memoryCleared = telemetry.pending;
      const fileCleared = client.buffered();
      // ① 内存队列：置空 Telemetry 的待发队列（setEnabled(false) 的既有语义）
      telemetry.setEnabled(false);
      telemetry.setEnabled(options.enabled);
      // ② 文件缓冲
      client.clearLocalBuffer();
      // ③ 数据库记录（历史遗留表）
      const dbCleared = clearDbRecords();
      return { memoryCleared, fileCleared, dbCleared };
    },

    inspect(): { telemetryRecords: number; pendingRecords: number } {
      return { telemetryRecords: client.buffered(), pendingRecords: telemetry.pending };
    },
  };
}
