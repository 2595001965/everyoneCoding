/**
 * 账号数据访问层：用户、工作区、绑定、刷新令牌、幂等键、用量上报。
 * 全部走 SQLite（better-sqlite3）。自注册即开通「个人工作区」+ 免费权益包(free)。
 */
import type { Database } from 'better-sqlite3';
// 与仓库既有约定一致：@types/better-sqlite3 以 export = 形式导出，按类型名导入。
import { randomUUID } from 'node:crypto';

export interface UserRow {
  id: string;
  email: string | null;
  password_hash: string | null;
  display_name: string;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceRow {
  id: string;
  owner_id: string;
  name: string;
  plan_id: string;
  created_at: number;
  updated_at: number;
}

export interface BindingRow {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  created_at: number;
}

export interface IdempotencyRow {
  key: string;
  status_code: number;
  response_body: string;
  created_at: number;
}

/** 邮箱验证 / 重置密码令牌行（0002 迁移） */
export interface EmailTokenRow {
  id: string;
  user_id: string;
  kind: string;
  token_hash: string;
  code: string;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

export interface RegisterResult {
  userId: string;
  email: string;
  workspaceId: string;
  planId: string;
}

export const DEFAULT_WORKSPACE_NAME = '个人工作区';
export const FREE_PLAN_ID = 'free';

export class AccountDb {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  get raw(): Database {
    return this.db;
  }

  /** 邮箱注册：创建用户 + 默认工作区（免费权益包）。 */
  registerEmailUser(email: string, passwordHash: string, displayName: string): RegisterResult {
    const now = Date.now();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO account_user (id, email, password_hash, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, email, passwordHash, displayName, now, now);
      this.db
        .prepare(
          `INSERT INTO account_workspace (id, owner_id, name, plan_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(workspaceId, userId, DEFAULT_WORKSPACE_NAME, FREE_PLAN_ID, now, now);
    });
    tx();
    return { userId, email, workspaceId, planId: FREE_PLAN_ID };
  }

  getUserByEmail(email: string): UserRow | null {
    return (
      (this.db.prepare('SELECT * FROM account_user WHERE email = ?').get(email) as
        UserRow | undefined) ?? null
    );
  }

  getUserById(id: string): UserRow | null {
    return (
      (this.db.prepare('SELECT * FROM account_user WHERE id = ?').get(id) as UserRow | undefined) ??
      null
    );
  }

  /**
   * OAuth：按 (provider, provider_user_id) 查找已有账号；
   * 没有则按邮箱匹配；再没有则新建（无密码）+ 默认工作区 + 绑定。
   * 返回是否本次为新建。
   */
  upsertOAuthUser(opts: {
    provider: string;
    providerUserId: string;
    email: string | null;
    name: string | null;
  }): { userId: string; workspaceId: string; planId: string; isNew: boolean } {
    const now = Date.now();
    const existingBinding = this.findBinding(opts.provider, opts.providerUserId);
    if (existingBinding) {
      const ws = this.getPrimaryWorkspace(existingBinding.user_id);
      return {
        userId: existingBinding.user_id,
        workspaceId: ws?.id ?? '',
        planId: ws?.plan_id ?? FREE_PLAN_ID,
        isNew: false,
      };
    }

    let target = opts.email ? this.getUserByEmail(opts.email) : null;
    let isNew = false;
    let workspaceId = '';
    let planId = FREE_PLAN_ID;
    const tx = this.db.transaction(() => {
      if (!target) {
        const userId = randomUUID();
        const displayName = opts.name?.trim() || `用户_${opts.providerUserId.slice(0, 6)}`;
        this.db
          .prepare(
            `INSERT INTO account_user (id, email, password_hash, display_name, created_at, updated_at)
             VALUES (?, ?, NULL, ?, ?, ?)`,
          )
          .run(userId, opts.email, displayName, now, now);
        target = {
          id: userId,
          email: opts.email,
          password_hash: null,
          display_name: displayName,
          created_at: now,
          updated_at: now,
        };
        isNew = true;
        const wsId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO account_workspace (id, owner_id, name, plan_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(wsId, userId, DEFAULT_WORKSPACE_NAME, FREE_PLAN_ID, now, now);
        workspaceId = wsId;
      } else {
        const ws = this.getPrimaryWorkspace(target.id);
        workspaceId = ws?.id ?? '';
        planId = ws?.plan_id ?? FREE_PLAN_ID;
      }
      this.db
        .prepare(
          `INSERT INTO account_binding (id, user_id, provider, provider_user_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), target.id, opts.provider, opts.providerUserId, now);
    });
    tx();
    return { userId: target!.id, workspaceId, planId, isNew };
  }

  getPrimaryWorkspace(userId: string): WorkspaceRow | null {
    return (
      (this.db
        .prepare(
          'SELECT * FROM account_workspace WHERE owner_id = ? ORDER BY created_at ASC LIMIT 1',
        )
        .get(userId) as WorkspaceRow | undefined) ?? null
    );
  }

  getBindings(userId: string): BindingRow[] {
    return this.db
      .prepare('SELECT * FROM account_binding WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as BindingRow[];
  }

  findBinding(provider: string, providerUserId: string): BindingRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM account_binding WHERE provider = ? AND provider_user_id = ?')
        .get(provider, providerUserId) as BindingRow | undefined) ?? null
    );
  }

  addBinding(userId: string, provider: string, providerUserId: string): BindingRow {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO account_binding (id, user_id, provider, provider_user_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, userId, provider, providerUserId, now);
    return { id, user_id: userId, provider, provider_user_id: providerUserId, created_at: now };
  }

  removeBinding(userId: string, bindingId: string): void {
    this.db
      .prepare('DELETE FROM account_binding WHERE id = ? AND user_id = ?')
      .run(bindingId, userId);
  }

  /** 登录方式数量 = 是否设置密码 + 绑定数量。 */
  countLoginMethods(userId: string): number {
    const user = this.getUserById(userId);
    const hasPassword = user?.password_hash ? 1 : 0;
    const bindings = this.getBindings(userId).length;
    return hasPassword + bindings;
  }

  createRefreshToken(userId: string, jti: string, expiresAt: number): void {
    this.db
      .prepare(
        `INSERT INTO account_refresh_token (jti, user_id, revoked, expires_at, created_at)
         VALUES (?, ?, 0, ?, ?)`,
      )
      .run(jti, userId, expiresAt, Date.now());
  }

  getRefreshToken(jti: string): { user_id: string; revoked: number; expires_at: number } | null {
    return (
      (this.db
        .prepare('SELECT user_id, revoked, expires_at FROM account_refresh_token WHERE jti = ?')
        .get(jti) as { user_id: string; revoked: number; expires_at: number } | undefined) ?? null
    );
  }

  revokeRefreshToken(jti: string): void {
    this.db.prepare('UPDATE account_refresh_token SET revoked = 1 WHERE jti = ?').run(jti);
  }

  /** 撤销某用户全部刷新令牌（重置密码后强制重新登录） */
  revokeAllRefreshTokens(userId: string): void {
    this.db.prepare('UPDATE account_refresh_token SET revoked = 1 WHERE user_id = ?').run(userId);
  }

  getIdempotency(key: string): IdempotencyRow | null {
    return (
      (this.db.prepare('SELECT * FROM account_idempotency WHERE key = ?').get(key) as
        IdempotencyRow | undefined) ?? null
    );
  }

  saveIdempotency(key: string, statusCode: number, responseBody: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO account_idempotency (key, status_code, response_body, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(key, statusCode, responseBody, Date.now());
  }

  pruneIdempotency(olderThanMs: number): void {
    this.db
      .prepare('DELETE FROM account_idempotency WHERE created_at < ?')
      .run(Date.now() - olderThanMs);
  }

  insertUsage(userId: string, payloadJson: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO account_usage_report (id, user_id, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, userId, payloadJson, Date.now());
    return id;
  }

  /* --------------------- 邮箱验证与重置密码（FR-ACC-08） --------------------- */

  setEmailVerified(userId: string, verified: boolean): void {
    this.db
      .prepare('UPDATE account_user SET email_verified = ?, updated_at = ? WHERE id = ?')
      .run(verified ? 1 : 0, Date.now(), userId);
  }

  isEmailVerified(userId: string): boolean {
    const row = this.db
      .prepare('SELECT email_verified FROM account_user WHERE id = ?')
      .get(userId) as { email_verified: number } | undefined;
    return (row?.email_verified ?? 0) === 1;
  }

  hasPassword(userId: string): boolean {
    const user = this.getUserById(userId);
    return Boolean(user?.password_hash);
  }

  setPassword(userId: string, passwordHash: string): void {
    this.db
      .prepare('UPDATE account_user SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, Date.now(), userId);
  }

  createEmailToken(input: {
    userId: string;
    kind: 'verify' | 'reset';
    tokenHash: string;
    code: string;
    expiresAt: number;
  }): string {
    const id = randomUUID();
    // 单次有效 + 新令牌使旧令牌失效：同 (user, kind) 旧未消费令牌直接作废
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE account_email_token SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL`,
        )
        .run(Date.now(), input.userId, input.kind);
      this.db
        .prepare(
          `INSERT INTO account_email_token (id, user_id, kind, token_hash, code, expires_at, used_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          id,
          input.userId,
          input.kind,
          input.tokenHash,
          input.code,
          input.expiresAt,
          Date.now(),
        );
    });
    tx();
    return id;
  }

  /**
   * 消费邮箱令牌：按 kind + 哈希查找，未过期且未使用才有效。
   * 有效即置 used_at（**单次有效**：无论后续密码校验成败，令牌都已消费）。
   */
  consumeEmailToken(kind: 'verify' | 'reset', tokenHash: string): EmailTokenRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM account_email_token WHERE kind = ? AND token_hash = ? AND used_at IS NULL`,
      )
      .get(kind, tokenHash) as EmailTokenRow | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) return null;
    this.db
      .prepare('UPDATE account_email_token SET used_at = ? WHERE id = ?')
      .run(Date.now(), row.id);
    return row;
  }

  /** 按验证码消费（重置密码流程）：取该用户同 kind 最新未用且未过期的令牌比对 */
  consumeEmailTokenByCode(userId: string, kind: 'reset', code: string): EmailTokenRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM account_email_token
         WHERE user_id = ? AND kind = ? AND used_at IS NULL AND expires_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, kind, Date.now()) as EmailTokenRow | undefined;
    if (!row || row.code !== code) return null;
    this.db
      .prepare('UPDATE account_email_token SET used_at = ? WHERE id = ?')
      .run(Date.now(), row.id);
    return row;
  }

  /** 最近一次发送冷却判定（限流辅助）：kind 令牌在窗口内已发过则返回 true */
  hasRecentEmailToken(userId: string, kind: 'verify' | 'reset', windowMs: number): boolean {
    const row = this.db
      .prepare(
        `SELECT created_at FROM account_email_token WHERE user_id = ? AND kind = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, kind) as { created_at: number } | undefined;
    return row !== undefined && Date.now() - row.created_at < windowMs;
  }
}
