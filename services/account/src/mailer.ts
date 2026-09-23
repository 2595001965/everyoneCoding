/**
 * 邮件发送端口与实现（FR-ACC-08 / T9-06）。
 *
 * 边界：本服务**不内置真实 SMTP 客户端**——生产部署自备（配置 SMTP_URL 后由部署侧
 * 消费 outbox 或替换 mailer）；这里提供两种可用的投递方式：
 * - `createOutboxMailer`：把邮件落到 `account_email_outbox` 表（默认），运维可查、
 *   测试可断言、开发环境可用管理端点读取；
 * - `createSinkMailer`：测试注入的内存 sink（`send` 记录全部投递，供断言）。
 *
 * 安全：正文只含验证链接/验证码，不含密码；收件人在日志/审计里一律脱敏。
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  kind: 'verify' | 'reset';
}

export interface MailerPort {
  send(message: MailMessage): Promise<void>;
}

/** 内存 sink：测试断言投递内容与次数用 */
export function createSinkMailer(): MailerPort & { messages: MailMessage[] } {
  const messages: MailMessage[] = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
    },
  };
}

/** outbox 表落盘（默认实现）；migrations 0002 幂等建表 */
export function createOutboxMailer(db: Database.Database): MailerPort {
  return {
    async send(message) {
      db.prepare(
        `INSERT INTO account_email_outbox (id, to_addr, subject, body, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        randomBytes(16).toString('hex'),
        message.to,
        message.subject,
        message.text,
        message.kind,
        Date.now(),
      );
    },
  };
}

/** 允许从环境注入自定义投递入口（如 webhook）；空则回落 outbox */
export function createMailerFromEnv(
  db: Database.Database,
  webhookUrl: string | undefined,
): MailerPort {
  if (webhookUrl !== undefined && webhookUrl !== '') {
    return {
      async send(message) {
        try {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
          });
        } catch {
          // webhook 失败不抛出：投递失败不应阻断注册/重置主流程（审计可查 outbox）
          await createOutboxMailer(db).send(message);
        }
      },
    };
  }
  return createOutboxMailer(db);
}

/* --------------------------- 令牌与验证码生成 --------------------------- */

/** token_hash：存哈希不存原文，泄露数据库也无法直接拿链接换会话 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 邮箱验证链接令牌（URL 安全） */
export function newEmailToken(): string {
  return randomBytes(24).toString('base64url');
}

/** 6 位数字验证码（重置密码用） */
export function newEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
