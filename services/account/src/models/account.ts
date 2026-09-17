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
        | UserRow
        | undefined) ?? null
    );
  }

  getUserById(id: string): UserRow | null {
    return (
      (this.db.prepare('SELECT * FROM account_user WHERE id = ?').get(id) as
        | UserRow
        | undefined) ?? null
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
        .prepare('SELECT * FROM account_workspace WHERE owner_id = ? ORDER BY created_at ASC LIMIT 1')
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

  getIdempotency(key: string): IdempotencyRow | null {
    return (
      (this.db.prepare('SELECT * FROM account_idempotency WHERE key = ?').get(key) as
        | IdempotencyRow
        | undefined) ?? null
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
}
