import type { Database } from 'better-sqlite3';
import { Repository, newUlid, type Row } from '@ec/data';
import type { SecureRefRow } from '@ec/data';

/**
 * 敏感引用（`secure_ref` 表）。
 *
 * provider.api_key_ref 外键指向本表，因此每把 Key 都要先在这里登记一条引用，
 * 引用本身不含任何明文：真正的密文由外壳密钥环（DPAPI）持有。
 */

export class SecureRefRepo {
  private readonly repo: Repository<SecureRefRow & Row>;

  constructor(private readonly db: Database) {
    this.repo = new Repository<SecureRefRow & Row>(db, 'secure_ref');
  }

  /** 幂等获取（没有就建一条），返回 secure_ref.id */
  ensure(userId: string, kind: 'api_key' | 'token' | 'secret', refPath: string): string {
    const rows = this.db
      .prepare('SELECT id FROM secure_ref WHERE user_id = ? AND kind = ? AND ref_path = ?')
      .all(userId, kind, refPath) as Array<{ id: string }>;
    const first = rows[0];
    if (first) return first.id;

    const id = newUlid();
    const now = Date.now();
    this.repo.insert({
      id,
      user_id: userId,
      kind,
      ref_path: refPath,
      digest: null,
      created_at: now,
      updated_at: now,
    } as SecureRefRow & Row);
    return id;
  }

  removeByPath(refPath: string): number {
    return this.db.prepare('DELETE FROM secure_ref WHERE ref_path = ?').run(refPath).changes;
  }
}
