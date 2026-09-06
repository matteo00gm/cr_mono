import { sql } from 'drizzle-orm';

import type { Database } from './client.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * Reads and writes for `email_suppressions` (P0-64).
 *
 * Here rather than in `packages/core` for the reason the header of `index.ts`
 * gives: statements live in this package so no app or domain module imports a
 * driver. The *decision* — whether a send is refused, and what the caller is
 * told — stays in `packages/core`, which has no database at all.
 *
 * These take a connection rather than opening one, and they accept a
 * transaction as readily as a pool. That is what keeps this from being a third
 * un-scoped path into the database: the send that consults the list already
 * runs inside `withTenant` — an invite is sent while handling a request for a
 * tenant — so it passes the transaction it is holding, and no new connection is
 * created. The table carries no RLS policy, so a tenant-scoped transaction
 * reads it in full.
 *
 * The bounce webhook (P0-64b) is the caller that will genuinely have no tenant,
 * because a bounce arrives outside any request. What connection *it* gets is a
 * decision for that row, and it is the same decision `auth-db.ts` had to make.
 */

/** A pool or a transaction — see the note above on why both. */
export type Connection = Database | DbTransaction;

export interface SuppressionRow {
  /** Already normalised by the caller — see `normaliseAddress` in core. */
  readonly address: string;
  /** `hard_bounce`, `complaint`, or whatever the provider invents next. */
  readonly reason: string;
  readonly detail?: string | undefined;
}

/**
 * True when the address must not be mailed.
 *
 * A plain existence check rather than a fetch of the row: the send path only
 * ever asks the yes/no question, and returning the row would invite a caller to
 * branch on `reason`, which is provider-shaped free text.
 */
export const isSuppressed = async (db: Connection, address: string): Promise<boolean> => {
  const rows = await db.execute(
    sql`select 1 from email_suppressions where address = ${address} limit 1`,
  );

  return [...rows].length > 0;
};

/**
 * Records a suppression, idempotently.
 *
 * `ON CONFLICT DO NOTHING` because providers redeliver webhooks, and the first
 * record of a bounce is the accurate one — a redelivery must not overwrite
 * `suppressed_at` and make an old problem look new to the bounce-rate alarm.
 */
export const suppressAddress = async (db: Connection, row: SuppressionRow): Promise<void> => {
  await db.execute(
    sql`insert into email_suppressions (address, reason, detail)
        values (${row.address}, ${row.reason}, ${row.detail ?? null})
        on conflict (address) do nothing`,
  );
};

/**
 * Lifts a suppression.
 *
 * Exists because the alternative is someone doing it by hand in a production
 * console, and a mailbox that was full last month is a customer who cannot
 * reset their password this month. Deliberately not exposed to tenants: a
 * seller who could un-suppress their own bounces could also spend our sending
 * reputation on a list they bought.
 */
export const unsuppressAddress = async (db: Connection, address: string): Promise<void> => {
  await db.execute(sql`delete from email_suppressions where address = ${address}`);
};
