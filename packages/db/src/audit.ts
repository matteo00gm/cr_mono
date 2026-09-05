import { sql } from 'drizzle-orm';
import type { DbTransaction } from './with-tenant.js';

/**
 * The `audit_log` insert (P0-53).
 *
 * Lives here rather than in `packages/core` for the reason the P0-09 rule
 * caught directly in P0-47: writing the statement in core would mean core
 * importing `drizzle-orm`, which `no-raw-db-outside-with-tenant` forbids. The
 * answer is the same as it was then — put the query where queries belong. What
 * gets recorded, and what is scrubbed out of it, stays in `packages/core/src/audit.ts`.
 *
 * **Takes the caller's transaction**, never opening its own. The audit row
 * commits or rolls back with the action it describes: an entry for something
 * that did not happen is worse than no entry, because it is a record people
 * will believe.
 */
export interface AuditRow {
  readonly tenantId: string;
  readonly actorUserId: string | undefined;
  readonly action: string;
  readonly target: string | undefined;
  /** Already redacted by the caller. Written as `jsonb`. */
  readonly metadata: string | undefined;
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
}

export const insertAuditRow = async (tx: DbTransaction, row: AuditRow): Promise<void> => {
  /*
   * No `RETURNING`. `app_rw` holds INSERT on this table and nothing else
   * (P0-31's append-only revoke), and Postgres applies the SELECT policy to a
   * RETURNING clause — so asking for the row back would fail with 42501 on a
   * table the write itself is permitted on.
   */
  await tx.execute(sql`
    insert into audit_log (tenant_id, actor_user_id, action, target, metadata, ip, user_agent)
    values (
      ${row.tenantId}::uuid,
      ${row.actorUserId ?? null},
      ${row.action},
      ${row.target ?? null},
      ${row.metadata ?? null}::jsonb,
      ${row.ip ?? null}::inet,
      ${row.userAgent ?? null}
    )
  `);
};
