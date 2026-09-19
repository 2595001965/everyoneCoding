/**
 * 导入模式选择器（T8-03）。
 *
 * 依据五种模式决定哪些 `PackageObjectType` 参与导入，并产出 `ModePreview`
 * （各类别"将新增 / 将覆盖 / 将跳过"的明细与中文说明），供 UI 在选模式阶段展示。
 *
 * 参与口径（与 §14.1 布局一致）：
 * - full-restore：全部 7 类；
 * - merge：全部 7 类，冲突走逐条/批量决策；
 * - memory-only：仅 memory；
 * - documents-only：仅 document（且无条件复制 attachments 附件文件，与文档同属资源）；
 * - code-only：code + design + registry + anchor + pipeline（不含文档与记忆）。
 */

import {
  IMPORT_MODE_LABELS,
  type ImportMode,
  type ModePreview,
  type PackageDiffPreview,
  type PackageObjectType,
} from './import-types';

/** 各模式参与的包内对象类别 */
export const MODE_PARTICIPATING_TYPES: Record<ImportMode, ReadonlySet<PackageObjectType>> = {
  'full-restore': new Set<PackageObjectType>([
    'memory',
    'document',
    'design',
    'registry',
    'code',
    'anchor',
    'pipeline',
  ]),
  merge: new Set<PackageObjectType>([
    'memory',
    'document',
    'design',
    'registry',
    'code',
    'anchor',
    'pipeline',
  ]),
  'memory-only': new Set<PackageObjectType>(['memory']),
  'documents-only': new Set<PackageObjectType>(['document']),
  'code-only': new Set<PackageObjectType>(['code', 'design', 'registry', 'anchor', 'pipeline']),
};

/** 任意模式都允许复制附件文件的判定：文档参与时一并复制附件 */
export function attachmentsAllowed(mode: ImportMode): boolean {
  return MODE_PARTICIPATING_TYPES[mode].has('document');
}

/** 用 IMPORT_MODE_LABELS 取得模式的中文标签 */
export function describeMode(mode: ImportMode): string {
  return IMPORT_MODE_LABELS[mode];
}

function emptyByType(): Record<
  PackageObjectType,
  { apply: number; overwrite: number; skip: number }
> {
  return {
    memory: { apply: 0, overwrite: 0, skip: 0 },
    document: { apply: 0, overwrite: 0, skip: 0 },
    design: { apply: 0, overwrite: 0, skip: 0 },
    registry: { apply: 0, overwrite: 0, skip: 0 },
    code: { apply: 0, overwrite: 0, skip: 0 },
    anchor: { apply: 0, overwrite: 0, skip: 0 },
    pipeline: { apply: 0, overwrite: 0, skip: 0 },
  };
}

function buildSummary(
  mode: ImportMode,
  types: ReadonlySet<PackageObjectType>,
  toApply: number,
  toOverwrite: number,
  toSkip: number,
): string {
  const typeLabel = [...types].join('、');
  const extra =
    mode === 'documents-only'
      ? '（含附件文件，无条件复制）'
      : mode === 'code-only'
        ? '（含设计/注册表/锚点/流水线，不含文档与记忆）'
        : mode === 'memory-only'
          ? '（仅记忆，不触及文档、代码与项目容器）'
          : '';
  return (
    `模式「${IMPORT_MODE_LABELS[mode]}」将参与类别：${typeLabel}。` +
    `预计新增 ${toApply} 个对象、覆盖 ${toOverwrite} 个冲突对象（需逐条或按类型决策）、跳过 ${toSkip} 个不变/不涵盖对象。${extra}`
  );
}

/**
 * 预览某模式下的导入影响。
 *
 * 决策未知时按默认口径统计：added → 新增（apply）、conflicted → 覆盖风险（overwrite）、
 * unchanged / 不涵盖类别 → 跳过（skip）。`byType` 给出每类明细。
 */
export function previewMode(mode: ImportMode, diff: PackageDiffPreview): ModePreview {
  const types = MODE_PARTICIPATING_TYPES[mode];
  const byType = emptyByType();
  let toApply = 0;
  let toOverwrite = 0;
  let toSkip = 0;

  for (const item of diff.items) {
    const t = item.incoming.type;
    const bucket = byType[t];
    if (!types.has(t)) {
      bucket.skip += 1;
      toSkip += 1;
      continue;
    }
    if (item.classification === 'added') {
      bucket.apply += 1;
      toApply += 1;
    } else if (item.classification === 'conflicted') {
      // 冲突默认不覆盖（keepLocal），但属于"将覆盖风险"，单独计列以便用户决策
      bucket.overwrite += 1;
      toOverwrite += 1;
    } else {
      bucket.skip += 1;
      toSkip += 1;
    }
  }

  return {
    mode,
    toApply,
    toOverwrite,
    toSkip,
    byType,
    summary: buildSummary(mode, types, toApply, toOverwrite, toSkip),
  };
}
