import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { TelemetryBufferStore, TelemetryRecord } from '@ec/core';

/**
 * 文件落盘的遥测缓冲。
 *
 * 为什么需要它：`TelemetryClient` 缺省用内存缓冲，进程一退就丢，
 * 于是设置页「隐私」类目的 `inspectLocalTelemetry()` 永远只能报 0，
 * 「一键清除本地遥测」也没有真实对象可清。落盘后两个动作才有意义。
 *
 * 边界（沿用遥测模块既有口径）：
 * - **默认关闭、未授权零上报**；本存储只负责"本地缓冲"，不发任何网络请求；
 * - 读坏文件不抛错，退化为空缓冲（坏数据不该让应用起不来）；
 * - 写入走"临时文件 + rename"，避免掉电留下半截 JSON。
 */

const EMPTY: TelemetryRecord[] = [];

export function createTelemetryFileStore(filePath: string): TelemetryBufferStore {
  const read = (): TelemetryRecord[] => {
    try {
      if (!existsSync(filePath)) return EMPTY;
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!Array.isArray(parsed)) return EMPTY;
      return parsed.filter(
        (item): item is TelemetryRecord =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as TelemetryRecord).seq === 'number' &&
          typeof (item as TelemetryRecord).recordedAt === 'number',
      );
    } catch {
      // 缓冲损坏按空处理：遥测是可选能力，不能拖垮主流程
      return EMPTY;
    }
  };

  const write = (records: TelemetryRecord[]): void => {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(records), 'utf8');
    // 与 fs.writeAtomic 同语义：先写临时文件，再整体替换（Windows 上 rename 可覆盖已存在文件）
    renameSync(tmp, filePath);
  };

  return {
    append(events: TelemetryRecord[]): void {
      if (events.length === 0) return;
      write([...read(), ...events]);
    },
    load(): TelemetryRecord[] {
      return read();
    },
    removeUpTo(seq: number): void {
      write(read().filter((record) => record.seq > seq));
    },
    clear(): void {
      write([]);
    },
    count(): number {
      return read().length;
    },
  };
}
