import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { ALREADY_SUBSCRIBED, createBillingPort } from '../src/billing.js';
import type { StripeClient } from '../src/stripe.js';

/**
 * Buying a plan against real Postgres (P5-02).
 *
 * The port with its default reader — `withTenant` as `app_rw` — so what reaches
 * Stripe is the session's own winery's customer, read under RLS, and never a
 * neighbour's. Stripe is the in-memory stand-in: no provider calls (P1-47).
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

const winery = async (billing: { customer?: string; subscription?: string } = {}) => {
  const tenantId = randomUUID();

  await admin().execute(sql`
    INSERT INTO tenants (id, name, slug, status, stripe_customer_id, stripe_subscription_id)
    VALUES (
      ${tenantId}, 'Cantina', ${`b-${tenantId}`}, 'TRIALING',
      ${billing.customer ?? null}, ${billing.subscription ?? null}
    )
  `);

  return tenantId;
};

const sessions: unknown[] = [];

const stripe: StripeClient = {
  get: <T>(_path: string, _params: unknown, schema: z.ZodType<T>) =>
    Promise.resolve(schema.parse({ data: [{ id: 'price_c', lookup_key: 'cantina_monthly_eur' }] })),
  post: <T>(_path: string, params: unknown, schema: z.ZodType<T>) => {
    sessions.push(params);

    return Promise.resolve(
      schema.parse({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }),
    );
  },
};

const billing = createBillingPort({ stripe, dashboardOrigin: 'https://app.catalogorosso.com' });

describe('buying a plan, under RLS', () => {
  it('opens Checkout for the session’s own customer and nobody else’s', async () => {
    await winery({ customer: 'cus_neighbour' });
    const mine = await winery({ customer: 'cus_mine' });

    await billing.checkout(mine, 'CANTINA');

    expect(sessions.at(-1)).toMatchObject({ customer: 'cus_mine', client_reference_id: mine });
  });

  it('refuses a winery whose subscription is on file', async () => {
    const subscribed = await winery({ customer: 'cus_s', subscription: 'sub_live' });

    await expect(billing.checkout(subscribed, 'CANTINA')).rejects.toThrow(ALREADY_SUBSCRIBED);
  });
});
