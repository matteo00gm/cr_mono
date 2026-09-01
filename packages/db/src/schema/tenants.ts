import { customType, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `tenants` — the root table (P0-22).
 *
 * Every other table references it, and `tenant_id` is what every RLS policy
 * compares against. This table is itself *not* tenant-scoped: it is the tenant.
 * Access to it is guarded by the membership check in P0-47, and it goes on the
 * P0-41 allowlist of tables legitimately without a `tenant_id` column.
 */

/**
 * Case-insensitive text, from the `citext` extension enabled in bootstrap/0000.
 *
 * Drizzle has no built-in for it. Declared once here rather than reaching for
 * `text` plus `lower()` indexes, because the uniqueness of a slug has to hold
 * against case as a property of the column — an application that lowercases on
 * write is one code path away from `Winery` and `winery` being two tenants.
 */
const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

/**
 * The six states from §Data Model, in lifecycle order.
 *
 * P5's Stripe webhook state machine switches on exactly these, so the set is a
 * contract rather than a convenience: adding a value is `ALTER TYPE ... ADD
 * VALUE`, but renaming or removing one is a data migration across every row.
 */
export const tenantStatus = pgEnum('tenant_status', [
  'PENDING_VERIFICATION',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'DISABLED',
  'CANCELED',
]);

/**
 * The launch plans from P5-01. Nullable on `tenants`, because a tenant exists
 * from signup and chooses a plan later; null means "no subscription yet" rather
 * than a made-up default that reads as a real entitlement.
 */
export const tenantPlan = pgEnum('tenant_plan', ['CANTINA', 'ECOMMERCE']);

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),

  name: text('name').notNull(),

  /** Case-insensitive and globally unique: it appears in URLs and in support. */
  slug: citext('slug').notNull().unique(),

  /**
   * Defaults to PENDING_VERIFICATION so a half-created tenant is never
   * accidentally serviceable. Everything that serves the widget reads this
   * column; a default of ACTIVE would mean an abandoned signup is a live
   * account.
   */
  status: tenantStatus('status').notNull().default('PENDING_VERIFICATION'),

  plan: tenantPlan('plan'),

  /**
   * Unique across tenants: one Stripe customer maps to one tenant. Without the
   * constraint a webhook carrying a customer id has no single row to apply to,
   * and the handler has to guess.
   */
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),

  locale: text('locale').notNull().default('it'),
  currency: text('currency').notNull().default('EUR'),

  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),

  /**
   * Maintained by the `set_updated_at` trigger (migration 0001), not by Drizzle.
   *
   * Drizzle's `$onUpdate` would stamp this only on updates that go through
   * Drizzle. A backfill in a migration, a fix applied with psql, or any raw
   * statement leaves the column stale — and a timestamp that is right most of
   * the time is worse than none, because it gets trusted.
   */
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
