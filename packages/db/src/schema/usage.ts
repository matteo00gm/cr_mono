import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `usage_events` and `usage_daily` — metering and its rollup (P0-30).
 *
 * The source of truth for quota enforcement (P5-11) and for per-tenant gross
 * margin. Two tables rather than one because they answer different questions at
 * different rates: the ledger is written on every billable action and read
 * rarely, the rollup is written once a night and read by every dashboard load.
 */

/**
 * The ledger. Append-only — see `0015_usage_append_only.sql`, which revokes the
 * UPDATE and DELETE that P0-21's default privileges hand `app_rw`.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * `YYYYMM` as text, not a date range.
     *
     * The monthly quota check runs before every model call (P2-36), on the hot
     * path, and this shape makes it an indexed equality lookup rather than a
     * range scan over `created_at`. The CHECK is what keeps that true: the
     * lookup is only correct if every writer agrees on the format, and a single
     * row written as `2026-09` would be invisible to the quota query — which
     * fails *open*, silently granting unlimited usage.
     */
    period: text('period').notNull(),

    /**
     * What was metered. `text`, not an enum, because §Data Model names the
     * column without fixing its values, and the set will grow as billable
     * actions are added. The allowed set belongs in the `drizzle-zod` contract
     * (P0-42), which is where §2.2 puts validation; an enum here would make
     * every addition an `ALTER TYPE` guarding nothing the contract does not.
     */
    kind: text('kind').notNull(),

    /**
     * Nullable: not every billable action belongs to a visitor session. A bulk
     * reindex (P1-39) costs embedding tokens and is started from the dashboard,
     * where there is no session to attribute it to.
     */
    sessionId: text('session_id'),

    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),

    /**
     * Integer micros, never a float. Costs are summed across hundreds of
     * thousands of rows and then compared against a plan's allowance; binary
     * floating point makes that sum depend on the order it was taken in.
     * `bigint` because micros of euros overflow `integer` at about €2,147.
     */
    costMicros: bigint('cost_micros', { mode: 'number' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /** The quota lookup, exactly as P2-36 asks it. */
    index('usage_events_tenant_period_idx').on(table.tenantId, table.period),

    check('usage_events_period_format', sql`period ~ '^[0-9]{6}$'`),
    check('usage_events_cost_micros_non_negative', sql`cost_micros is null or cost_micros >= 0`),
  ],
);

/**
 * Messages bought on top of a plan (P5-11a). A ledger, like `usage_events`:
 * append-only at the grant level (`0062_usage_top_ups.sql`), because the row
 * that says what a winery paid for must not be editable by the code path that
 * serves it.
 */
export const usageTopUps = pgTable(
  'usage_top_ups',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * The `YYYYMM` the messages count towards, in the ledger's own format and
     * for the same reason: the quota gate sums this with an indexed equality
     * before every model call (P5-11).
     */
    period: text('period').notNull(),

    messagesPurchased: integer('messages_purchased').notNull(),

    /**
     * What makes a credit happen once (P5-11a). The webhook claim already
     * dedupes an event; this dedupes the *payment*, which Stripe can report in
     * two events — completed, and later an async success for the same session.
     */
    stripePaymentIntentId: text('stripe_payment_intent_id').notNull().unique(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('usage_top_ups_tenant_period_idx').on(table.tenantId, table.period),

    check('usage_top_ups_period_format', sql`period ~ '^[0-9]{6}$'`),
    check('usage_top_ups_messages_positive', sql`messages_purchased > 0`),
  ],
);

/**
 * The quota notices a month has already sent (P5-12): one row per winery, per
 * period, per threshold, and the primary key is the idempotency. A notice is
 * claimed by inserting its row; a second claim finds the key taken and sends
 * nothing — so two messages crossing 80% at once tell the owners once.
 *
 * Append-only at the grant (`0064_notification_events.sql`): deleting a row
 * would send the notice again.
 */
export const notificationEvents = pgTable(
  'notification_events',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /** `YYYYMM`, the ledger's period: a new month sends its notices afresh. */
    period: text('period').notNull(),

    /** 80 or 100: the share of the month's allowance that was reached. */
    threshold: smallint('threshold').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.period, table.threshold] }),

    check('notification_events_period_format', sql`period ~ '^[0-9]{6}$'`),
    check('notification_events_threshold', sql`threshold in (80, 100)`),
  ],
);

/**
 * Every paid charge a FatturaPA may be owed for (P5-03a): one row per Stripe
 * invoice or top-up payment, written by the webhook on its claim's
 * transaction. The e-invoicing bridge drains it, deciding at sending time
 * whether a winery's details call for one — details that may arrive after
 * the payment did.
 *
 * Not append-only: the bridge records what it did (`status`,
 * `provider_document_id`). But `app_rw` holds no DELETE (`0067`): a charge
 * erased is an invoice nobody issues.
 */
export const eInvoices = pgTable(
  'e_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /** `in_…` or a payment intent: unique, so Stripe's second word for one payment is no second row. */
    stripeObjectId: text('stripe_object_id').notNull().unique(),

    source: text('source').notNull(),

    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }).notNull(),

    /** `pending` until the bridge acts: `issued`, or `not_required` for a winery with no SdI details. */
    status: text('status').notNull().default('pending'),
    providerDocumentId: text('provider_document_id'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('e_invoices_tenant_status_idx').on(table.tenantId, table.status),

    check('e_invoices_source', sql`source in ('invoice', 'top_up')`),
    check('e_invoices_amount_positive', sql`amount_cents > 0`),
    check('e_invoices_status', sql`status in ('pending', 'issued', 'not_required')`),
  ],
);

/**
 * The nightly rollup (P5-13).
 *
 * Not append-only: a day's row is upserted as the job re-runs, so `app_rw`
 * keeps the UPDATE that `usage_events` gives up.
 *
 * Counters default to zero rather than being nullable. A missing day and a day
 * with no activity are different facts, and null would conflate them — every
 * dashboard sum would then need a `coalesce` that someone eventually forgets.
 */
export const usageDaily = pgTable(
  'usage_daily',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    day: date('day').notNull(),

    messages: integer('messages').notNull().default(0),
    conversations: integer('conversations').notNull().default(0),
    addToCarts: integer('add_to_carts').notNull().default(0),

    /**
     * `tokens_in` / `tokens_out` here, `input_tokens` / `output_tokens` in the
     * ledger. The same quantity under two names, inherited from §Data Model,
     * which spells them differently in the two tables. Kept rather than
     * quietly harmonised: the rollup job and the dashboards are written against
     * these names, and renaming a column the plan states explicitly belongs in
     * a change that says so.
     */
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),

    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    /**
     * `(tenant_id, day)` is the key, not a surrogate id. The rollup job upserts
     * by it, so making it the primary key is what makes a re-run idempotent
     * rather than a source of duplicate days.
     */
    primaryKey({ columns: [table.tenantId, table.day] }),

    check('usage_daily_cost_micros_non_negative', sql`cost_micros >= 0`),
  ],
);
