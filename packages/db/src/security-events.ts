import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';
import { securityEventType } from './schema/security-events.js';
import { withTenant } from './with-tenant.js';

/**
 * The `security_events` writer and its count (P2-16, P0-32).
 *
 * **Here rather than in `packages/security` where the row puts it**, on the
 * terms this package has established: statements live where queries belong, so
 * no domain module imports a driver (P0-09) — the same deviation the limiter
 * and the audit insert record. What is worth recording stays in `apps/api`,
 * which maps a refusal onto one of these rows.
 *
 * **It opens its own transaction, and that is the point.** A refusal is a fact
 * about an attempt, so the row must not roll back with the request that caused
 * it. Nothing here can be handed a caller's transaction by mistake.
 */

/** Derived from the table, never hand-written (P0-42). */
export type SecurityEventType = (typeof securityEventType.enumValues)[number];

export interface SecurityEvent {
  readonly type: SecurityEventType;
  /**
   * Absent when no tenant could be resolved, which for an unknown key is the
   * reason it was refused. The policy admits such a row on purpose: its
   * `WITH CHECK` allows a null tenant, so the events most worth having are not
   * the ones that cannot be written.
   */
  readonly tenantId?: string | undefined;
  /** The Origin header as sent, kept verbatim: what was claimed is the evidence. */
  readonly origin?: string | undefined;
  /** The `pk_` presented. Public by design, so storing it leaks nothing. */
  readonly publicKey?: string | undefined;
  /** P2-04's daily-salted bucket, never an address. */
  readonly ipBucket?: string | undefined;
  /** Flat, small, and nothing a visitor wrote: the exact refusal reason and its like. */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * No `RETURNING`.
 *
 * `app_rw` holds INSERT on this table and nothing else (P0-31's append-only
 * revoke), and Postgres applies the SELECT policy to a RETURNING clause — so
 * asking for the row back fails with 42501 on a write that is otherwise allowed.
 */
const write = (tx: Transaction, event: SecurityEvent): Promise<unknown> =>
  tx.execute(sql`
    insert into security_events (tenant_id, type, origin, public_key, ip_bucket, metadata)
    values (
      ${event.tenantId ?? null}::uuid,
      ${event.type}::security_event_type,
      ${event.origin ?? null},
      ${event.publicKey ?? null},
      ${event.ipBucket ?? null},
      ${event.metadata === undefined ? null : JSON.stringify(event.metadata)}::jsonb
    )
  `);

/**
 * Records one refusal.
 *
 * With a tenant it writes under that tenant's scope; without one it writes the
 * unattributed row the policy admits by name. It reads nothing back, and it is
 * the caller's job that a failure here cannot fail a request — `apps/api`
 * reports through a hook that swallows a throw and a rejection alike.
 */
export const insertSecurityEvent = async (
  event: SecurityEvent,
  db: Database = getDb(),
): Promise<void> => {
  if (event.tenantId === undefined) {
    await db.transaction((tx) => write(tx, event));
    return;
  }

  await withTenant(event.tenantId, (tx) => write(tx, event), db);
};

export interface SecurityEventQuery {
  readonly tenantId: string;
  readonly publicKey?: string | undefined;
  readonly origin?: string | undefined;
  readonly type?: SecurityEventType | undefined;
}

/**
 * How many of a tenant's refusals match a key and an origin — P6-05's panel,
 * and the threshold behind it.
 *
 * Under `withTenant`, so it counts one winery's rows. The unattributed ones — an
 * unknown key belongs to nobody — are invisible here by design, and reaching
 * them across tenants is `app_admin`'s, which is what P7-02's alert will need.
 */
export const countSecurityEvents = async (
  { tenantId, publicKey, origin, type }: SecurityEventQuery,
  db: Database = getDb(),
): Promise<number> =>
  withTenant(
    tenantId,
    async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as total
        from security_events
        where ${publicKey === undefined ? sql`true` : sql`public_key = ${publicKey}`}
          and ${origin === undefined ? sql`true` : sql`origin = ${origin}`}
          and ${type === undefined ? sql`true` : sql`type = ${type}::security_event_type`}
      `);

      return Number(([...rows][0] as { total: number | string } | undefined)?.total ?? 0);
    },
    db,
  );
