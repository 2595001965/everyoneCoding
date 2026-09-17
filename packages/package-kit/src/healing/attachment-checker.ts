/**
 * 附件清点（T8-04 要点 3 / FR-PKG-10）。
 *
 * 附件是**内容寻址**的（`attachments/<sha256>.<ext>`），因此可以机器校验：
 * - 包内/库中缺失（被引用但没有文件）→ `missing`；
 * - 文件在但内容哈希与文件名不符 → `corrupted`。
 * 提供"从本地其他位置补齐"的入口由外壳实现（本模块只负责清点与报告）。
 */
import { sha256Hex } from '../format/checksum';

/** 附件内容端口（外壳装配；测试用内存假实现） */
export interface AttachmentContentPort {
  /** 被引用的附件清单（hashName 形如 <sha256>.<png>；referencedBy 供报告展示） */
  listReferencedAttachments(): Array<{ hashName: string; referencedBy: string }>;
  /** 读取附件内容；缺失返回 null */
  readAttachment(hashName: string): Buffer | null;
}

export interface AttachmentCheckResult {
  issues: Array<{ hashName: string; status: 'missing' | 'corrupted'; detail: string }>;
  checked: number;
}

/** 从内容寻址文件名中取出哈希部分（<hash>.<ext> → hash） */
export function hashOfHashName(hashName: string): string {
  const dotIndex = hashName.lastIndexOf('.');
  const withoutExt = dotIndex === -1 ? hashName : hashName.slice(0, dotIndex);
  return withoutExt.toLowerCase();
}

/** 清点全部被引用附件 */
export function checkAttachments(port: AttachmentContentPort): AttachmentCheckResult {
  const referenced = port.listReferencedAttachments();
  const issues: AttachmentCheckResult['issues'] = [];
  let checked = 0;

  for (const item of referenced) {
    checked += 1;
    const content = port.readAttachment(item.hashName);
    if (content === null) {
      issues.push({
        hashName: item.hashName,
        status: 'missing',
        detail: `附件缺失（被 ${item.referencedBy} 引用），可从原设备或本地其他位置补齐`,
      });
      continue;
    }
    const actual = sha256Hex(content);
    if (actual !== hashOfHashName(item.hashName)) {
      issues.push({
        hashName: item.hashName,
        status: 'corrupted',
        detail: `附件内容与文件名哈希不符（期望 ${hashOfHashName(item.hashName).slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`,
      });
    }
  }

  return { issues, checked };
}
