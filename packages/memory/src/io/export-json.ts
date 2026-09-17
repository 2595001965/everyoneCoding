import type { MemoryItem } from '../domain/memory-item';
import { MemoryImportError } from './import';

/**
 * 记忆导出格式标识（写在导出包 `format` 字段，用于导入时识别来源）。
 */
export const MEMORY_EXPORT_FORMAT = 'everyonecoding.memory' as const;

/** 当前导出结构版本，导入端据此判断是否兼容。 */
export const MEMORY_EXPORT_VERSION = 1;

/**
 * 导出信封：把一批记忆条目打包成可重新导入的 JSON 结构。
 *
 * `items` 直接存放领域对象（`MemoryItem`），导入端原样取回即可，
 * 但 `embedding` 在导出时被强制置 `null`（见下）。
 */
export interface MemoryExportEnvelope {
  format: typeof MEMORY_EXPORT_FORMAT;
  version: number;
  exportedAt: number;
  userId: string;
  projectId: string | null;
  count: number;
  items: MemoryItem[];
}

/**
 * 导出元信息。
 * @param userId    导出归属用户（必填）
 * @param projectId 限定项目（可选；不传视为跨项目导出）
 * @param exportedAt 导出时间戳（可选，默认取当前时间）
 */
export interface ExportMeta {
  userId: string;
  projectId?: string | null;
  exportedAt?: number;
}

/**
 * 拼装导出信封。
 *
 * 注意：`embedding`（向量）默认不导出——它体积大且与具体模型绑定，
 * 重新导入到别的模型会失真。为保证往返结构一致，这里仍保留
 * `embedding: null` 字段位（详见 `exportJson` 的 TSDoc）。
 */
export function buildExportEnvelope(items: readonly MemoryItem[], meta: ExportMeta): MemoryExportEnvelope {
  const exportedAt = meta.exportedAt ?? Date.now();
  return {
    format: MEMORY_EXPORT_FORMAT,
    version: MEMORY_EXPORT_VERSION,
    exportedAt,
    userId: meta.userId,
    projectId: meta.projectId ?? null,
    count: items.length,
    // 全字段序列化，但 embedding 强制置 null 以减小体积并避免模型绑定问题
    items: items.map((item) => ({ ...item, embedding: null })),
  };
}

/**
 * 导出为格式化的 JSON 字符串（全字段）。
 *
 * 字段覆盖：`id / userId / scope / 各归属 id / title / content / structured /
 * tags / sourceType / sourceRef / confidence / importance / status /
 * issueStatus / pinned / version / createdAt / updatedAt` 全部保留。
 *
 * `embedding` 默认不导出（体积大、与模型绑定），但保留 `embedding: null`
 * 字段位，保证"导出 → 导入"结构一致、字段数不丢。如需携带向量，请在导入端
 * 单独重新生成。
 */
export function exportJson(items: readonly MemoryItem[], meta: ExportMeta): string {
  return JSON.stringify(buildExportEnvelope(items, meta), null, 2);
}

/**
 * 导出为 JSONL（每行一条 `MemoryItem` JSON）。
 *
 * 适合大批量记忆的流式导入/导出：解析时按行 `JSON.parse` 即可，
 * 单条坏数据不影响其余行（坏行计入 `skipped`）。
 */
export function exportJsonl(items: readonly MemoryItem[]): string {
  return items.map((item) => JSON.stringify({ ...item, embedding: null })).join('\n');
}

/**
 * 解析导出 JSON 字符串，还原为 `MemoryExportEnvelope`。
 *
 * 校验 `format` 与 `version`：
 * - `format` 不匹配 → 抛 `MemoryImportError`，code = `'FORMAT'`；
 * - `version` 高于当前支持版本 → 抛 `MemoryImportError`，code = `'VERSION'`；
 * - 顶层不是合法 JSON → 抛 `MemoryImportError`，code = `'PARSE'`。
 *
 * 解析时**不静默丢字段**：信封与 `items` 原样返回，字段取舍交给上层决定。
 */
export function parseExportJson(raw: string): MemoryExportEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MemoryImportError('PARSE', `导出文件不是合法 JSON：${reason}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MemoryImportError('PARSE', '导出文件顶层不是对象（应为 MemoryExportEnvelope）');
  }

  const envelope = parsed as Record<string, unknown>;
  if (envelope.format !== MEMORY_EXPORT_FORMAT) {
    throw new MemoryImportError(
      'FORMAT',
      `导出格式不支持：期望 "${MEMORY_EXPORT_FORMAT}"，实际为 "${String(envelope.format)}"`,
    );
  }

  const version = envelope.version;
  if (typeof version !== 'number' || version > MEMORY_EXPORT_VERSION) {
    throw new MemoryImportError(
      'VERSION',
      `导出版本不兼容：当前支持 v${MEMORY_EXPORT_VERSION}，文件为 v${version === undefined ? '未知' : String(version)}`,
    );
  }

  return parsed as MemoryExportEnvelope;
}
