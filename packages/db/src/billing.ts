import { sql } from 'drizzle-orm';

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
