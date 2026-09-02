import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
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
