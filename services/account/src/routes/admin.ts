/** Admin-only account lookup and combined, paginated platform audit feed. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformAdmin } from '../auth-tokens.ts';
import { AppError, ErrCode } from '../errors.ts';

interface AuditRow {
  id: string;
  action: string;
  actorAccountId: string | null;
  targetAccountId: string | null;
  attemptId: string | null;
  entryId: string | null;
  reason: string | null;
  detail: string | null;
  detailsJson: string | null;
  createdAt: number;
}

function parseCursor(value: string): { createdAt: number; id: string } {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof cursor === 'object' &&
      cursor !== null &&
      'createdAt' in cursor &&
      'id' in cursor &&
      typeof cursor.createdAt === 'number' &&
      Number.isSafeInteger(cursor.createdAt) &&
      typeof cursor.id === 'string' &&
      cursor.id.length > 0 &&
      cursor.id.length <= 128
    ) {
      return { createdAt: cursor.createdAt, id: cursor.id };
    }
  } catch {
    // Return the same validation error for malformed base64 and JSON.
  }
  throw new AppError(ErrCode.BAD_REQUEST, '审计分页游标无效', 400);
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { accountId: string } }>(
    '/api/admin/accounts/:accountId',
    { preHandler: requirePlatformAdmin },
    async (request) => {
      const params = z
        .object({ accountId: z.string().trim().min(1).max(128) })
        .safeParse(request.params);
      if (!params.success) throw new AppError(ErrCode.BAD_REQUEST, '账号标识无效', 400);
      const user = app.accountDb.getUserById(params.data.accountId);
      if (!user) throw new AppError(ErrCode.NOT_FOUND, '账号不存在', 404);
      return {
        account: {
          accountId: user.id,
          displayName: user.display_name,
          createdAt: user.created_at,
        },
      };
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/api/admin/audit',
    { preHandler: requirePlatformAdmin },
    async (request) => {
      const parsed = z
        .object({
          limit: z.string().regex(/^\d+$/).optional(),
          cursor: z.string().min(1).max(512).optional(),
        })
        .strict()
        .safeParse(request.query);
      if (!parsed.success) throw new AppError(ErrCode.BAD_REQUEST, '审计筛选参数无效', 400);
      const limit = parsed.data.limit === undefined ? 50 : Number(parsed.data.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AppError(ErrCode.BAD_REQUEST, 'limit 必须在 1 到 100 之间', 400);
      }
      const cursor = parsed.data.cursor === undefined ? undefined : parseCursor(parsed.data.cursor);
      const cursorClause = cursor ? 'WHERE createdAt < ? OR (createdAt = ? AND id < ?)' : '';
      const values: Array<string | number> = cursor
        ? [cursor.createdAt, cursor.createdAt, cursor.id, limit + 1]
        : [limit + 1];
      const rows = app.accountDb.raw
        .prepare(
          `WITH audit_rows AS (
             SELECT id, action, NULL AS actorAccountId, NULL AS targetAccountId,
                    NULL AS attemptId, NULL AS entryId, NULL AS reason,
                    detail, NULL AS detailsJson, created_at AS createdAt
             FROM account_audit_log
             UNION ALL
             SELECT event_id AS id, action, actor_account_id AS actorAccountId,
                    target_account_id AS targetAccountId, attempt_id AS attemptId,
                    entry_id AS entryId, reason, NULL AS detail,
                    details_json AS detailsJson, created_at AS createdAt
             FROM billing_audit_event
           )
           SELECT * FROM audit_rows ${cursorClause}
           ORDER BY createdAt DESC, id DESC LIMIT ?`,
        )
        .all(...values) as AuditRow[];
      const hasMore = rows.length > limit;
      const events = rows.slice(0, limit).map((row) => {
        let details: unknown = null;
        if (row.detailsJson !== null) {
          try {
            details = JSON.parse(row.detailsJson) as unknown;
          } catch {
            details = { unavailable: true };
          }
        }
        return {
          id: row.id,
          action: row.action,
          actorAccountId: row.actorAccountId,
          targetAccountId: row.targetAccountId,
          attemptId: row.attemptId,
          entryId: row.entryId,
          reason: row.reason,
          detail: row.detail,
          details,
          createdAt: row.createdAt,
        };
      });
      const last = rows[Math.min(rows.length, limit) - 1];
      const nextCursor =
        hasMore && last
          ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString(
              'base64url',
            )
          : null;
      return { events, nextCursor };
    },
  );
}
