/**
 * 增量导出/导入（T8-04 要点 5 / FR-PKG-11，P2）。
 *
 * 口径：**updatedAt 游标**。上次导出/备份完成后记录水位
 * `IncrementalCursor.since`（= 本次导出时见到的最大 updatedAt）；
 * 下一次增量导出把 `updatedSince` 传给导出流水线（`ExportJobRequest.updatedSince`，
 * 由 export-job 只挑 updatedAt > updatedSince 的对象），仅导出变更对象。
 *
 * 增量包体积与变更量成正比（验收）：变更越少包越小；全量 = updatedSince 缺省。
 * 增量包的导入复用 T8-03 的导入流水线（merge 模式按 id + updatedAt 合并）。
 */

/** 游标（持久化由外壳负责：建议存项目工作区设置） */
export interface IncrementalCursor {
  /** 水位：epoch 毫秒；下一次只导出 updatedAt > since 的对象 */
  since: number;
  /** 游标生成时间 */
  savedAt: number;
}

/** 游标来源端口：从数据源统计当前最大 updatedAt（外壳装配） */
export interface CursorSourcePort {
  /** 全部记忆/文档/项目对象的 updatedAt 最大值；无数据时返回 0 */
  maxUpdatedAt(): number;
}

/** 生成下一次增量导出用的游标（在导出完成时调用） */
export function advanceCursor(port: CursorSourcePort, now: number): IncrementalCursor {
  return { since: port.maxUpdatedAt(), savedAt: now };
}

/** 判断一个对象是否应进入增量包（导出流水线的过滤判据） */
export function isInIncrementalWindow(updatedAt: number, updatedSince: number | undefined): boolean {
  if (updatedSince === undefined) return true; // 全量
  return updatedAt > updatedSince;
}

export interface VolumeComparison {
  /** 全量包字节数 */
  fullBytes: number;
  /** 增量包字节数 */
  incrementalBytes: number;
  /** 增量/全量 比（0–1，越小代表增量越有效） */
  ratio: number;
  /** 结论文案（报告用） */
  summary: string;
}

/** 对比全量与增量包体积（验收：增量包体积与变更量成正比） */
export function compareIncrementalVolume(fullBytes: number, incrementalBytes: number): VolumeComparison {
  const ratio = fullBytes > 0 ? incrementalBytes / fullBytes : 1;
  const percent = (ratio * 100).toFixed(1);
  return {
    fullBytes,
    incrementalBytes,
    ratio,
    summary: `增量包 ${incrementalBytes} 字节，为全量包 ${fullBytes} 字节的 ${percent}%`,
  };
}
