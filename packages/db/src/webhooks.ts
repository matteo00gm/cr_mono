import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';
import type { Connection } from './email-suppressions.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * The inbound-webhook idempotency ledger (P0-64b, and P0-33 after it).
 *
 * Here rather than in `packages/core` for the reason the header of `index.ts`
 * gives: statements live in this package so no app or domain module imports a
 * driver. What an event *means* — whether an address stops being mailed — is in
 * `packages/core/src/webhooks`, which has no database at all.
 *
 * **This is an un-scoped transaction, and it is a decision rather than an
 * oversight.** A webhook arrives outside any request: there is no session, no
 * membership row, and no tenant to set. Both tables it touches are among the
 * handful that carry no `tenant_id` and no RLS policy — `processed_webhooks`
 * because the tenant is derived *from* the event and may not exist, and
 * `email_suppressions` because the reputation it protects belongs to the
 * sending domain rather than to any one winery (P0-64). So there is no scoped
 * read for a missing context to silently narrow and no other tenant's rows for
 * one to widen into, which is the same argument `createRateLimiter` makes for
 * `rate_limit_buckets` (P2-02).
 *
 * It is **not** a fourth GUC. Nothing here sets a setting or relies on a policy
 * admitting one; it is an ordinary connection touching two tables that are
 * global on purpose. A handler that reaches for a tenant table from inside
 * `apply` would be the design change, and would get nothing back.
 */

/**
 * Claims an event, returning `true` only for the delivery that got there first.
 *
 * `ON CONFLICT DO NOTHING ... RETURNING` is one round trip with no
 * read-then-write race: two concurrent deliveries of the same event both
 * attempt the insert, exactly one gets a row back, and the loser does nothing.
 * A `SELECT` followed by an `INSERT` lets both through on a slow day.
 *
 * `processed_webhooks` is append-only at the grant level (P0-33a) — `app_rw`
 * holds `INSERT` and `SELECT` and neither `UPDATE` nor `DELETE` — so this is
 * the only shape available, which is what the grant is for.
 */
export const claimWebhookEvent = async (
  db: Connection,
  event: { readonly provider: string; readonly eventId: string },
): Promise<boolean> => {
  const rows = await db.execute(
    sql`insert into processed_webhooks (provider, event_id)
        values (${event.provider}, ${event.eventId})
        on conflict (provider, event_id) do nothing
        returning event_id`,
  );

  return [...rows].length > 0;
};

export interface WebhookEvent {
  /** `resend` today; `stripe` arrives with P0-33. */
  readonly provider: string;
  /** The provider's own id for this delivery. Svix sends it as `svix-id`. */
  readonly eventId: string;
}

/** `claimed: false` means some earlier delivery already did the work. */
export type ClaimedRun<T> =
  { readonly claimed: false } | { readonly claimed: true; readonly result: T };

/**
 * Runs `apply` exactly once per event, ever.
 *
 * **The claim and the effect share one transaction, and that is the entire
 * point of this function existing rather than the two calls being made side by
 * side.** Claim separately and there is a window in which the event is recorded
 * as processed and the work has not happened — a crash, a timeout, a rolled-back
 * write — and the provider's redelivery, the one mechanism that would have
 * repaired it, is refused because the ledger says it is done. That failure is
 * permanent, silent, and indistinguishable from success.
 *
 * Written generically because P0-33's Stripe handler needs the identical
 * guarantee over completely different work, and the property being protected is
 * the transaction boundary rather than anything about email.
 */
export const withWebhookEvent = async <T>(
  event: WebhookEvent,
  apply: (tx: DbTransaction) => Promise<T>,
  database: Database = getDb(),
): Promise<ClaimedRun<T>> =>
  database.transaction(async (tx): Promise<ClaimedRun<T>> => {
    if (!(await claimWebhookEvent(tx, event))) return { claimed: false };

    return { claimed: true, result: await apply(tx) };
  });
