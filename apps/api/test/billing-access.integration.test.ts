import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { readMembershipsForUser } from '@catalogorosso/db';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { createApp } from '../src/app.js';
import { ALREADY_SUBSCRIBED, createBillingPort } from '../src/billing.js';
import { createProductsPort } from '../src/products.js';
import type { StripeClient } from '../src/stripe.js';
import { signedIn } from './support/auth.js';

/**
 * The dashboard stays open when the widget does not (P5-05a, §5.2b).
 *
 * **Not grace — mechanics.** A winery whose payment failed must be able to
 * reach the screen where it pays, and one that is not paying must still be
 * able to manage its catalogue: locking a tenant out of billing means it
 * cannot pay us. The widget's gate reads the status; the dashboard's reads
 * only a membership. This holds that with the real membership reader, under
 * RLS, for every state in which the widget is dark.
 */

let harness: TestDatabase | undefined;

const admin = () => {
  if (harness === undefined) throw new Error('no database');
  return harness.adminDb;
};

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

/** An owner of a winery in the state given, with a second factor, as a real user. */
const ownerOf = async (state: { status: string; trialEndsAt?: 'past'; subscribed?: true }) => {
  const tenantId = randomUUID();
  const userId = `user_${randomUUID().slice(0, 8)}`;

  await admin().execute(sql`
    INSERT INTO tenants (id, name, slug, status, trial_ends_at, stripe_customer_id, stripe_subscription_id)
    VALUES (
      ${tenantId}, 'Cantina', ${`dark-${tenantId}`}, ${state.status}::tenant_status,
      ${state.trialEndsAt === 'past' ? sql`now() - interval '1 day'` : null},
      ${state.subscribed === true ? `cus_${tenantId}` : null},
      ${state.subscribed === true ? `sub_${tenantId}` : null}
    )
  `);
  await admin().execute(sql`
    INSERT INTO auth_users (id, name, email, two_factor_enabled)
    VALUES (${userId}, 'Owner', ${`${userId}@example.test`}, true)
  `);
  await admin().execute(sql`
    INSERT INTO memberships (tenant_id, user_id, role) VALUES (${tenantId}, ${userId}, 'OWNER')
  `);

  return userId;
};

const stripe: StripeClient = {
  get: <T>(_path: string, _params: unknown, schema: z.ZodType<T>) =>
    Promise.resolve(schema.parse({ data: [{ id: 'price_c', lookup_key: 'cantina_monthly_eur' }] })),
  post: <T>(_path: string, _params: unknown, schema: z.ZodType<T>) =>
    Promise.resolve(schema.parse({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' })),
};

const appAs = (userId: string) =>
  createApp({
    auth: signedIn(userId),
    readMemberships: readMembershipsForUser,
    products: createProductsPort(),
    billing: createBillingPort({ stripe, dashboardOrigin: 'https://app.catalogorosso.com' }),
  });

describe.each([
  ['past due, on the first failure', { status: 'PAST_DUE', subscribed: true as const }],
  ['disabled, its subscription ended', { status: 'DISABLED' }],
  ['trialling past its end', { status: 'TRIALING', trialEndsAt: 'past' as const }],
  ['waiting for its first domain', { status: 'PENDING_VERIFICATION' }],
])('the owner of a winery %s', (_what, state) => {
  it('still reaches the dashboard and the catalogue', async () => {
    const app = appAs(await ownerOf(state));

    expect((await app.request('/v1/dashboard/context')).status).toBe(200);
    expect((await app.request('/v1/dashboard/products')).status).toBe(200);
  });

  it('still reaches billing, and is answered by it rather than turned away', async () => {
    const response = await appAs(await ownerOf(state)).request('/v1/dashboard/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'CANTINA' }),
    });

    /*
     * A winery with a subscription on file is told to fix the one it has —
     * the Billing Portal, P5-08 — and one without is sent to Checkout. Either
     * way the answer is billing's, never a refusal to let it in.
     */
    if ('subscribed' in state) {
      expect(response.status).toBe(409);
      expect(JSON.stringify(await response.json())).toContain(ALREADY_SUBSCRIBED);
    } else {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    }
  });
});
