/** 导入渲染层测试夹具（非 .test.ts，仅被各测试复用） */

import type {
  PackageDiffItem,
  PackageDiffPreview,
  PackageObjectType,
  VerificationReport,
} from '../package-api';

export function conflictItem(
  id: string,
  type: PackageObjectType,
  name: string,
  incomingUpdatedAt: number,
  localUpdatedAt: number | null,
): PackageDiffItem {
  return {
    incoming: { id, type, projectId: null, name, updatedAt: incomingUpdatedAt },
    local: localUpdatedAt === null ? null : { id, name, updatedAt: localUpdatedAt },
    classification: 'conflicted',
  };
}

export function addedItem(id: string, type: PackageObjectType, name: string = id): PackageDiffItem {
  return {
    incoming: { id, type, projectId: null, name, updatedAt: 1 },
    local: null,
    classification: 'added',
  };
}

export function diffWithConflicts(items: PackageDiffItem[]): PackageDiffPreview {
  const counts = { added: 0, conflicted: items.length, unchanged: 0, missing: 0 };
  return { items, counts, missingLocals: [] };
}

export function okVerify(): VerificationReport {
  return {
    ok: true,
    steps: [{ step: 'format-version', ok: true, detail: 'ok' }],
    failureCode: null,
    failureMessage: null,
  };
}

export function failVerify(
  code: VerificationReport['failureCode'],
  message: string,
): VerificationReport {
  return {
    ok: false,
    steps: [{ step: 'format-version', ok: false, detail: message }],
    failureCode: code,
    failureMessage: message,
  };
}
