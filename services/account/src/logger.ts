/**
 * 审计日志与脱敏工具。
 * 安全约束（NFR-S-04）：密码、令牌、邮箱等敏感信息必须脱敏后才记录。
 */
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/** 脱敏：仅保留前 4 位，其余以 *** 替代；过短则整体打码。 */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return '';
  if (value.length <= 4) return '***';
  return `${value.slice(0, 4)}***`;
}

/** 邮箱脱敏：保留首字符与域名。 */
export function maskEmail(email: string | undefined | null): string {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at <= 0) return maskSecret(email);
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 1);
  return `${head}***${domain}`;
}

export interface AuditRecord {
  id: string;
  action: string;
  detail: string;
  createdAt: number;
}

/** 写入一条脱敏后的审计日志（落库）。 */
export function writeAudit(db: Database, action: string, detail: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO account_audit_log (id, action, detail, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(randomUUID(), action, detail, now);
}
