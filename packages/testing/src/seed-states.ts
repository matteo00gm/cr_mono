import { randomBytes, randomUUID } from 'node:crypto';

import { startTrial, withTenant, type Database } from '@catalogorosso/db';
import { sql } from 'drizzle-orm';

import { makeProduct } from './factories.js';

/**
 * One winery in every billing state, against a running stack (P5-14).
 *
 * **Through the webhook path wherever there is one.** The paid states are
 * reached by the caller's `transition` — in practice the dev billing port,
 * which records a Stripe-shaped event through the same port a signed delivery
 * reaches — so each fixture proves the state machine got it there, rather than
 * asserting a status somebody wrote. Two states have no webhook behind them,
 * and each says so: a trial starts on a verified domain (`startTrial`, as the
 * verify route does), and a trial *ends* by its date passing, which is a date
 * written into the row — the one fixture that has to fake time, because the
 * trial is ours rather than Stripe's (P5-05a).
 *
 * As `app_rw`, under each winery's own scope, like the seed it sits beside
 * (P0-43): seeding as a superuser would prove nothing about the policies.
 */

export type ExpectedWidget = 'active' | 'quota_exceeded' | 'disabled' | 'not_rendered';

export type StateSlug =
  | 'trialing-fresh'
  | 'trialing-capped'
  | 'trialing-expired'
  | 'active-healthy'
  | 'active-capped'
  | 'past-due'
  | 'subscription-ended'
  | 'pending-verification';

export type BillingTransition = 'activate' | 'fail_payment' | 'recover' | 'end_subscription';

interface StateRecipe {
  readonly slug: StateSlug;
  /** What a visitor's widget should do (P3-22 reads this). */
  readonly widget: ExpectedWidget;
  /** The status the row should end in. */
  readonly status: string;
  readonly verified: boolean;
  readonly trial: boolean;
  readonly transitions: readonly BillingTransition[];
  /** Billed chat turns this month, to put a winery at its cap. */
  readonly messages?: number;
  readonly trialEnded?: boolean;
}

/** The plan's table, in its order. Cantina's cap is 1,500; a trial's is 150. */
export const STATE_RECIPES: readonly StateRecipe[] = [
  {
    slug: 'trialing-fresh',
    widget: 'active',
    status: 'TRIALING',
    verified: true,
    trial: true,
    transitions: [],
  },
  {
    slug: 'trialing-capped',
    widget: 'quota_exceeded',
    status: 'TRIALING',
    verified: true,
    trial: true,
    transitions: [],
    messages: 150,
  },
  {
    slug: 'trialing-expired',
    widget: 'disabled',
    status: 'TRIALING',
    verified: true,
    trial: true,
    transitions: [],
    trialEnded: true,
  },
  {
    slug: 'active-healthy',
    widget: 'active',
    status: 'ACTIVE',
    verified: true,
    trial: true,
    transitions: ['activate'],
  },
  {
    slug: 'active-capped',
    widget: 'quota_exceeded',
    status: 'ACTIVE',
    verified: true,
    trial: true,
    transitions: ['activate'],
    messages: 1_500,
  },
  {
    slug: 'past-due',
    widget: 'disabled',
    status: 'PAST_DUE',
    verified: true,
    trial: true,
    transitions: ['activate', 'fail_payment'],
  },
  {
    slug: 'subscription-ended',
    widget: 'disabled',
    status: 'DISABLED',
    verified: true,
    trial: true,
    transitions: ['activate', 'end_subscription'],
  },
  {
    slug: 'pending-verification',
    widget: 'not_rendered',
    status: 'PENDING_VERIFICATION',
    verified: false,
    trial: false,
    transitions: [],
  },
];

export interface SeededState {
  readonly slug: StateSlug;
  readonly tenantId: string;
  readonly publicKey: string;
  readonly origin: string;
  readonly widget: ExpectedWidget;
  readonly status: string;
}

export interface SeedStatesOptions {
  /** Moves a winery along one billing transition, by the webhook path. */
  readonly transition: (tenantId: string, transition: BillingTransition) => Promise<unknown>;
  /** The storefront origin for the n-th fixture. Defaults to `http://localhost:4201` on. */
  readonly originFor?: ((index: number) => string) | undefined;
  readonly db?: Database | undefined;
}

const currentPeriod = (): string => {
  const now = new Date();

  return `${String(now.getUTCFullYear())}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const seedStates = async ({
  transition,
  originFor = (index) => `http://localhost:${String(4201 + index)}`,
  db,
}: SeedStatesOptions): Promise<readonly SeededState[]> => {
  const seeded: SeededState[] = [];

  for (const [index, recipe] of STATE_RECIPES.entries()) {
    const tenantId = randomUUID();
    const origin = originFor(index);
    /* Built at runtime and never written down (P0-56). */
    const publicKey = `pk_test_${randomBytes(18).toString('base64url')}`;

    await withTenant(
      tenantId,
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO tenants (id, name, slug, locale, currency)
          VALUES (${tenantId}::uuid, ${`Stato ${recipe.slug}`}, ${`${recipe.slug}-${tenantId.slice(0, 8)}`},
                  'it', 'EUR')
        `);
        await tx.execute(sql`
          INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status, verified_at)
          VALUES (${tenantId}::uuid, ${origin}, 'localhost',
                  ${recipe.verified ? 'VERIFIED' : 'PENDING'},
                  ${recipe.verified ? new Date().toISOString() : null}::timestamptz)
        `);
        await tx.execute(sql`
          INSERT INTO widget_keys (tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4)
          VALUES (${tenantId}::uuid, ${publicKey}, md5(random()::text), 'sk_test_', 'seed')
        `);

        for (let wine = 0; wine < 3; wine += 1) {
          const product = makeProduct(wine);

          await tx.execute(sql`
            INSERT INTO products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
            VALUES (${tenantId}::uuid, ${product.sku}, ${product.name}, ${product.wineType},
                    ${product.priceCents}, ${product.currency}, ${product.stockStatus})
          `);
        }

        /* The trial starts as the verify route starts it (P5-05). */
        if (recipe.trial) await startTrial(tx, 14);

        /* The one fixture that fakes time: our trial ends by its date (P5-05a). */
        if (recipe.trialEnded === true) {
          await tx.execute(sql`UPDATE tenants SET trial_ends_at = now() - interval '1 day'`);
        }

        if (recipe.messages !== undefined) {
          await tx.execute(sql`
            INSERT INTO usage_events (tenant_id, period, kind)
            SELECT ${tenantId}::uuid, ${currentPeriod()}, 'chat_message'
            FROM generate_series(1, ${recipe.messages})
          `);
        }
      },
      db,
    );

    for (const step of recipe.transitions) await transition(tenantId, step);

    seeded.push({
      slug: recipe.slug,
      tenantId,
      publicKey,
      origin,
      widget: recipe.widget,
      status: recipe.status,
    });
  }

  return seeded;
};
