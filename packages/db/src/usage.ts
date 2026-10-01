import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * The usage ledger's writer (P2-31, P0-30).
 *
 * **In `packages/db` rather than `packages/core/src/usage.ts` where the row
 * puts it**, on this package's standing terms: a statement lives where the
 * driver is (P0-09). What is pure — the price table, the cost, the period —
 * *is* in `packages/core/src/usage.ts`, which is the half of the row that
 * belongs there.
 *
 * **It takes the caller's transaction**, which the row requires rather than
 * suggests: the usage row and P2-30's turn are one write, or usage and history
 * disagree about what happened.
 *
 * **The table is append-only at the grant level** (P0-31, migration 0015): the
 * runtime role holds INSERT and nothing else. So this inserts and never
 * updates, and a correction is another row rather than an edit.
 */

export interface UsageToRecord {
  /** `YYYYMM`, from `periodOf`. The column's `CHECK` refuses anything else. */
  readonly period: string;
  /** `chat_message` for a turn. */
  readonly kind: string;
  /** The widget session, or null for work with no visitor behind it. */
  readonly sessionId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Integer micros, from `costMicrosFor`. Never a float. */
  readonly costMicros: number | null;
}

/**
 * Records one billable action.
 *
 * **Billed even when the model errored after being called** (the row is
 * explicit): the tokens were spent whether or not the answer arrived, and a
 * failure loop that costs the tenant nothing and us everything is the shape of
 * every runaway bill. What distinguishes the two is the turn row P2-30 writes
 * beside it in the same transaction, which carries the reply that never came.
 */
export const recordUsage = async (tx: DbTransaction, usage: UsageToRecord): Promise<void> => {
  await tx.execute(sql`
    insert into usage_events
      (tenant_id, period, kind, session_id, input_tokens, output_tokens, cost_micros)
    values (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${usage.period}, ${usage.kind}, ${usage.sessionId},
      ${usage.inputTokens}, ${usage.outputTokens}, ${usage.costMicros}
    )
  `);
};

/**
 * How many billable actions of one kind a tenant has taken this period (P2-36).
 *
 * **Counts rows, not tokens.** The tenant-facing limit is messages, because
 * that is the unit a seller understands and the unit the plan advertises — a
 * cap in tokens is a cap nobody can predict from their own behaviour.
 *
 * **An indexed equality on `(tenant_id, period)`**, which is what the column's
 * `YYYYMM` shape exists for: a range scan over `created_at` would do the same
 * arithmetic on the hot path, before every model call.
 */
export const countUsage = async (
  tx: DbTransaction,
  period: string,
  kind: string,
): Promise<number> => {
  const rows = await tx.execute(sql`
    select count(*)::int as used
    from usage_events
    where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and period = ${period}
      and kind = ${kind}
  `);

  const row = [...rows][0] as { used: number } | undefined;

  if (row === undefined) {
    /*
     * `count(*)` always returns a row, so this is unreachable — and it throws
     * rather than defaulting, because the default that suggests itself is
     * nought and nought is the answer that grants unlimited usage. A cost gate
     * whose read failed must not be a cost gate that let everything through,
     * which is the failure the `period` column's own comment warns about.
     */
    throw new Error('Counting usage returned no row (P2-31).');
  }

  return row.used;
};

/** One paid top-up, as the webhook credits it (P5-11a). */
export interface TopUpToRecord {
  /** `YYYYMM`: the month the payment completed in, which is the month it counts towards. */
  readonly period: string;
  readonly messages: number;
  /** One payment is one credit, however many events Stripe sends about it. */
  readonly paymentIntentId: string;
}

/**
 * Credits messages bought on top of the plan (P5-11a), in the caller's
 * transaction — the webhook claim's, so the credit and the claim are one write.
 *
 * **`duplicate` when this payment was already credited**: the unique payment
 * intent makes a second event about the same payment a no-op rather than a
 * second thousand messages. Append-only at the grant (migration 0062), so
 * there is no update path to get wrong.
 */
export const recordTopUp = async (
  tx: DbTransaction,
  topUp: TopUpToRecord,
): Promise<'credited' | 'duplicate'> => {
  const rows = await tx.execute(sql`
    insert into usage_top_ups (tenant_id, period, messages_purchased, stripe_payment_intent_id)
    values (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${topUp.period}, ${topUp.messages}, ${topUp.paymentIntentId}
    )
    on conflict (stripe_payment_intent_id) do nothing
    returning id
  `);

  return [...rows].length === 0 ? 'duplicate' : 'credited';
};

/**
 * Messages a tenant bought on top of its plan for a period (P5-11a): what
 * `planCapCheck` raises the month by (P5-11). Nought when nothing was bought.
 */
export const countPurchased = async (tx: DbTransaction, period: string): Promise<number> => {
  const rows = await tx.execute(sql`
    select coalesce(sum(messages_purchased), 0)::int as purchased
    from usage_top_ups
    where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and period = ${period}
  `);
  const row = [...rows][0] as { purchased?: number } | undefined;

  return row?.purchased ?? 0;
};

/**
 * Claims a quota notice for this winery, this period and this threshold
 * (P5-12): `true` for the caller who should send it, `false` for every other.
 *
 * **The key is the idempotency.** Two messages crossing 80% together both try
 * the insert; one finds the row its own, the other finds the key taken. Claimed
 * before the send rather than after, so a notice is sent at most once — a send
 * that fails after its claim is a lost email, which `sendEmail`'s retries and
 * its alarm already answer for, not a second one in the same month.
 */
export const claimQuotaNotice = async (
  tx: DbTransaction,
  period: string,
  threshold: 80 | 100,
): Promise<boolean> => {
  const rows = await tx.execute(sql`
    insert into notification_events (tenant_id, period, threshold)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${period}, ${threshold})
    on conflict do nothing
    returning threshold
  `);

  return [...rows].length > 0;
};

/** One day, or one origin, and the messages it took (P5-12, §2.3). */
export interface UsageSlice {
  readonly key: string;
  readonly messages: number;
}

export interface UsageBreakdown {
  /** `YYYY-MM-DD` in UTC, oldest first; days with nothing are absent. */
  readonly byDay: readonly UsageSlice[];
  /**
   * The origin each message was asked from, busiest first. A message with no
   * conversation behind it — work with no visitor — is under `null`'s key, `''`.
   */
  readonly byOrigin: readonly UsageSlice[];
}

/**
 * Where a winery's month went (P5-12, §2.3): by day, and by the origin the
 * widget was asked from — a winery may have several domains, and a staging
 * one shares the month (P4-19).
 *
 * The origin is the conversation's: a session is bound to one origin (P2-12)
 * and holds one conversation, so the join adds a column and no rows.
 */
export const readUsageBreakdown = async (
  tx: DbTransaction,
  period: string,
  kind: string,
): Promise<UsageBreakdown> => {
  const days = await tx.execute(sql`
    select to_char(created_at at time zone 'utc', 'YYYY-MM-DD') as key, count(*)::int as messages
    from usage_events
    where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and period = ${period}
      and kind = ${kind}
    group by 1
    order by 1
  `);
  const origins = await tx.execute(sql`
    select coalesce(c.origin, '') as key, count(*)::int as messages
    from usage_events u
    left join conversations c
      on c.tenant_id = u.tenant_id and c.session_id = u.session_id
    where u.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and u.period = ${period}
      and u.kind = ${kind}
    group by 1
    order by 2 desc, 1
  `);

  const slices = (rows: Iterable<Record<string, unknown>>): UsageSlice[] =>
    [...rows].map((row) => ({ key: String(row.key), messages: Number(row.messages) }));

  return { byDay: slices(days), byOrigin: slices(origins) };
};

/** A paid charge, as the webhook records it (P5-03a). */
export interface ChargeToRecord {
  readonly stripeObjectId: string;
  readonly source: 'invoice' | 'top_up';
  readonly amountCents: number;
  readonly currency: string;
  readonly paidAt: Date;
}

/**
 * Records a paid charge for the e-invoicing bridge (P5-03a), in the caller's
 * transaction — the webhook claim's, so the charge and "this event was
 * handled" are one write. `duplicate` when Stripe has already told us about
 * this payment under its other name.
 */
export const recordPaidCharge = async (
  tx: DbTransaction,
  charge: ChargeToRecord,
): Promise<'recorded' | 'duplicate'> => {
  const rows = await tx.execute(sql`
    insert into e_invoices (tenant_id, stripe_object_id, source, amount_cents, currency, paid_at)
    values (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${charge.stripeObjectId}, ${charge.source}, ${charge.amountCents}, ${charge.currency},
      ${charge.paidAt.toISOString()}::timestamptz
    )
    on conflict (stripe_object_id) do nothing
    returning id
  `);

  return [...rows].length === 0 ? 'duplicate' : 'recorded';
};

/** What one tenant's day came to, as `usage_daily` holds it (P5-13). */
export interface DayRollup {
  readonly messages: number;
  readonly conversations: number;
  readonly addToCarts: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicros: number;
}

/**
 * Recomputes one UTC day for the scope's tenant and writes it (P5-13).
 *
 * **A recompute, never an increment**: the day is read whole from the ledger
 * and the events, and the row is replaced — so a retried run, or one re-run by
 * hand after a late write, reports the same day the same way rather than
 * doubling it. **A day with nothing is a row of noughts**, not a gap: a chart
 * that reads a missing day as "no data" draws a line through it.
 *
 * Messages are billed chat turns; tokens and cost are every billed action,
 * embedding included, because the cost is what the margin dashboard reads.
 */
export const rollupUsageDay = async (tx: DbTransaction, day: string): Promise<DayRollup> => {
  const rows = await tx.execute(sql`
    WITH bounds AS (
      SELECT ${day}::date::timestamp AT TIME ZONE 'UTC' AS start_at,
             (${day}::date + 1)::timestamp AT TIME ZONE 'UTC' AS end_at
    ),
    billed AS (
      SELECT
        count(*) FILTER (WHERE u.kind = 'chat_message')::int AS messages,
        coalesce(sum(u.input_tokens), 0)::bigint AS tokens_in,
        coalesce(sum(u.output_tokens), 0)::bigint AS tokens_out,
        coalesce(sum(u.cost_micros), 0)::bigint AS cost_micros
      FROM usage_events u, bounds b
      WHERE u.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND u.created_at >= b.start_at AND u.created_at < b.end_at
    ),
    opened AS (
      SELECT count(*)::int AS conversations
      FROM conversations c, bounds b
      WHERE c.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND c.started_at >= b.start_at AND c.started_at < b.end_at
    ),
    carted AS (
      SELECT count(*)::int AS add_to_carts
      FROM widget_events e, bounds b
      WHERE e.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND e.type = 'ADD_TO_CART'
        AND e.created_at >= b.start_at AND e.created_at < b.end_at
    )
    INSERT INTO usage_daily
      (tenant_id, day, messages, conversations, add_to_carts, tokens_in, tokens_out, cost_micros)
    SELECT nullif(current_setting('app.tenant_id', true), '')::uuid, ${day}::date,
           billed.messages, opened.conversations, carted.add_to_carts,
           billed.tokens_in, billed.tokens_out, billed.cost_micros
    FROM billed, opened, carted
    ON CONFLICT (tenant_id, day) DO UPDATE SET
      messages = excluded.messages,
      conversations = excluded.conversations,
      add_to_carts = excluded.add_to_carts,
      tokens_in = excluded.tokens_in,
      tokens_out = excluded.tokens_out,
      cost_micros = excluded.cost_micros
    RETURNING messages, conversations, add_to_carts, tokens_in, tokens_out, cost_micros
  `);
  const row = [...rows][0];

  /* The INSERT always yields its row; nothing returned is a statement that did not run. */
  if (row === undefined) throw new Error('Rolling up a day returned no row (P5-13).');

  return {
    messages: Number(row.messages),
    conversations: Number(row.conversations),
    addToCarts: Number(row.add_to_carts),
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    costMicros: Number(row.cost_micros),
  };
};
