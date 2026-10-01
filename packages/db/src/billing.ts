import { sql } from 'drizzle-orm';

import { countDomains } from './domains-write.js';
import type { TenantPlan, TenantStatus } from './widget-resolution.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * A winery's side of its Stripe subscription (P5-02).
 *
 * **Statements only, on the caller's transaction** — `domains-write.ts`'s
 * terms. Every one reads under the tenant policy, so a caller outside
 * `withTenant` finds nothing rather than another winery's customer.
 */

export interface BillingState {
  readonly status: TenantStatus;
  readonly plan: TenantPlan | null;
  /** Kept across subscriptions, so a returning winery is one customer in Stripe. */
  readonly stripeCustomerId: string | null;
  /**
   * The live subscription, or `null` once there is none.
   *
   * Present means "already subscribed": Checkout refuses a second one, and a
   * change of plan goes through the subscription instead (P5-09). The webhook
   * that ends a subscription clears it (P5-05).
   */
  readonly stripeSubscriptionId: string | null;
  readonly locale: string;
}

/** `undefined` when there is no tenant row to read — outside a scope, say. */
export const readBillingState = async (tx: DbTransaction): Promise<BillingState | undefined> => {
  const rows = await tx.execute(sql`
    SELECT status, plan, stripe_customer_id, stripe_subscription_id, locale
    FROM tenants
    LIMIT 1
  `);

  const row = [...rows][0] as
    | {
        status: TenantStatus;
        plan: TenantPlan | null;
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        locale: string;
      }
    | undefined;

  return row === undefined
    ? undefined
    : {
        status: row.status,
        plan: row.plan,
        stripeCustomerId: row.stripe_customer_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        locale: row.locale,
      };
};

/* ------------------------------------------------------------ the machine */

/** What the state machine reads (P5-05): the state, and the ordering clock. */
export interface BillingSnapshotRow {
  readonly status: TenantStatus;
  readonly plan: TenantPlan | null;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly lastEventAt: Date | null;
}

/**
 * The winery's billing state, **locked for the rest of the transaction**.
 *
 * `FOR UPDATE`, because two different Stripe events for one winery can arrive
 * together — `invoice.paid` and `customer.subscription.updated` are sent within
 * the same second — and each would otherwise read the same state and write its
 * own answer over the other's. The idempotency claim does not help there: the
 * events have different ids. The lock makes them take turns, and the second
 * reads what the first wrote, ordering clock included.
 */
export const readBillingSnapshot = async (
  tx: DbTransaction,
): Promise<BillingSnapshotRow | undefined> => {
  const rows = await tx.execute(sql`
    SELECT status, plan, stripe_customer_id, stripe_subscription_id, billing_event_at
    FROM tenants
    LIMIT 1
    FOR UPDATE
  `);

  const row = [...rows][0] as
    | {
        status: TenantStatus;
        plan: TenantPlan | null;
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        billing_event_at: string | Date | null;
      }
    | undefined;

  return row === undefined
    ? undefined
    : {
        status: row.status,
        plan: row.plan,
        customerId: row.stripe_customer_id,
        subscriptionId: row.stripe_subscription_id,
        lastEventAt: row.billing_event_at === null ? null : new Date(row.billing_event_at),
      };
};

/** Everything the machine decided, written in one statement. */
export interface BillingChangeRow {
  readonly status: TenantStatus;
  readonly plan: TenantPlan | null;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly lastEventAt: Date;
}

/** Why a change was not written. */
export type BillingWriteRefusal = 'customer_taken';

/**
 * Writes the machine's answer, or reports the one conflict it cannot see coming.
 *
 * **A customer or subscription id already bound to another winery** is refused
 * by the unique constraints on `tenants` — the one-to-one binding §5.2b asks
 * for, enforced by an index rather than a check — and this winery's scope
 * cannot see the other row to ask first. The write runs in a savepoint, so the
 * violation rolls back only itself: the caller's transaction, and the event's
 * claim with it, survive to record that the event was handled. Without the
 * savepoint the whole claim would roll back and Stripe would retry, forever, a
 * change that can never succeed.
 */
export const writeBillingChange = async (
  tx: DbTransaction,
  change: BillingChangeRow,
): Promise<'written' | BillingWriteRefusal> => {
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint.execute(sql`
        UPDATE tenants
        SET status = ${change.status}::tenant_status,
            plan = ${change.plan}::tenant_plan,
            stripe_customer_id = ${change.customerId},
            stripe_subscription_id = ${change.subscriptionId},
            billing_event_at = ${change.lastEventAt.toISOString()}::timestamptz
      `);
    });
  } catch (error) {
    /*
     * Drizzle wraps the driver's error ("Failed query") and puts Postgres's own
     * in `cause`, so the code is looked for on both: reading only the wrapper
     * turned every refusal into a thrown error, and every retry into another.
     */
    const failure = error as { code?: unknown; cause?: { code?: unknown } } | null;

    if (failure?.code === '23505' || failure?.cause?.code === '23505') return 'customer_taken';

    throw error;
  }

  return 'written';
};

/**
 * Starts the card-free trial, if this winery has not had one (P5-05).
 *
 * Called on the transaction that verifies a domain: `PENDING_VERIFICATION`
 * becomes `TRIALING` with the trial's days on the clock (`TRIAL.days`, P5-01's
 * `plans.ts`, passed in rather than restated here). **Only from
 * `PENDING_VERIFICATION`**, in the statement rather than beside it, so a second
 * domain verified later — or one verified by a winery that has already paid —
 * changes nothing, and neither do two verifications arriving together.
 * Answers when the trial ends, or `undefined` when it did not start one.
 */
export const startTrial = async (tx: DbTransaction, days: number): Promise<Date | undefined> => {
  const rows = await tx.execute(sql`
    UPDATE tenants
    SET status = 'TRIALING',
        trial_ends_at = now() + make_interval(days => ${days}::int)
    WHERE status = 'PENDING_VERIFICATION'
    RETURNING trial_ends_at
  `);

  const row = [...rows][0] as { trial_ends_at: string | Date } | undefined;

  return row === undefined ? undefined : new Date(row.trial_ends_at);
};

/**
 * What a winery holds that a plan caps (P5-10): its active wines, and its
 * production domains counted the way the domain cap counts them.
 *
 * On the caller's transaction, under the tenant policy. The effect that
 * re-checks a downgrade as it applies reads this inside the event's claim,
 * so the answer and the decision are one snapshot.
 */
export const readPlanFootprint = async (
  tx: DbTransaction,
): Promise<{ readonly wines: number; readonly domains: number }> => {
  const rows = await tx.execute(sql`
    SELECT count(*)::int AS wines FROM products WHERE status = 'ACTIVE'
  `);
  const wines = ([...rows][0] as { wines?: number } | undefined)?.wines ?? 0;

  return { wines, domains: await countDomains(tx) };
};
