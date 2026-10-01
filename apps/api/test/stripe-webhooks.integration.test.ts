import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { insertSecurityEvent } from '@catalogorosso/db';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { createBillingEffect } from '../src/billing-events.js';
import type { BillingNotice } from '../src/billing-notices.js';
import { logger } from '../src/middleware/logger.js';
import { WEBHOOK_PREFIX } from '../src/routes.js';
import { webhookRejectionRecorder } from '../src/security-events.js';
import { createStripeEventsPort } from '../src/stripe-events.js';
import { fakeAuth } from './support/auth.js';

/**
 * The Stripe webhook, end to end (P5-06).
 *
 * **Every transition through the endpoint**: a fixture shaped as Stripe sends
 * it at the pinned API version, signed with the endpoint secret, posted to
 * `/v1/webhooks/stripe`, claimed once under the winery it names (P5-04), run
 * through the state machine (P5-05), and read back from Postgres as `app_rw`
 * wrote it. Then the adversarial half: unsigned, mis-signed, replayed, out of
 * order, and for a winery that does not exist.
 *
 * The fixtures in `fixtures/stripe/` are written from Stripe's API reference at
 * `2026-08-26.dahlia`, not captured: there is no Stripe account for any stage
 * yet. Placeholders are filled per test, so every test has its own winery.
 * Replacing them with captures from `stripe trigger` is an open item.
 *
 * The secret is built at runtime (P0-56).
 */

const SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const FIXTURES = join(import.meta.dirname, 'fixtures', 'stripe');

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

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

const told: [string, BillingNotice][] = [];

/** The endpoint as production composes it, with a recording notifier. */
const app = createApp({
  auth: fakeAuth(),
  readMemberships: () => Promise.resolve([]),
  stripeWebhookSecret: SECRET,
  stripeEvents: createStripeEventsPort({
    apply: createBillingEffect({ livemode: false }),
    notify: (tenantId, notice) => {
      told.push([tenantId, notice]);
      return Promise.resolve();
    },
  }),
  onSignatureRejected: webhookRejectionRecorder(insertSecurityEvent),
});

interface Winery {
  readonly tenantId: string;
  readonly customer: string;
  readonly subscription: string;
}

let clock = 1_790_000_000;

/** A fixture, filled in: Stripe's own event, for this winery, one second after the last. */
const fixture = (
  name: string,
  winery: Winery,
  fill: Record<string, string | number | boolean> = {},
): { body: string; eventId: string } => {
  clock += 1;

  const eventId = `evt_${randomUUID().replaceAll('-', '')}`;
  const values: Record<string, string | number | boolean> = {
    __EVENT__: eventId,
    __TENANT__: winery.tenantId,
    __CUSTOMER__: winery.customer,
    __SUBSCRIPTION__: winery.subscription,
    __CREATED__: clock,
    __PAYMENT_STATUS__: 'paid',
    __STATUS__: 'active',
    __CANCEL_AT_PERIOD_END__: false,
    __LOOKUP_KEY__: 'ecommerce_monthly_eur',
    __PRODUCT__: 'plan_ecommerce',
    __UNIT_AMOUNT__: 7900,
    ...fill,
  };

  let body = readFileSync(join(FIXTURES, `${name}.json`), 'utf8');

  for (const [placeholder, value] of Object.entries(values)) {
    /* A number or a boolean replaces the quotes around its placeholder too. */
    body = body.replaceAll(
      `"${placeholder}"`,
      typeof value === 'string' ? JSON.stringify(value) : String(value),
    );
  }

  return { body, eventId };
};

/** Signs the way Stripe documents it: the whole secret, over `t.body`, hex. */
const signature = (body: string, secret = SECRET) => {
  const t = String(Math.floor(Date.now() / 1000));

  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};

const deliver = async (event: { body: string }, headers?: Record<string, string>) => {
  const response = await app.request(`${WEBHOOK_PREFIX}/stripe`, {
    method: 'POST',
    headers: headers ?? {
      'content-type': 'application/json',
      'stripe-signature': signature(event.body),
    },
    body: event.body,
  });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/** A winery on its card-free trial, with the Stripe ids it will be given. */
const trialing = async (): Promise<Winery> => {
  const tenantId = randomUUID();

  await admin().execute(sql`
    INSERT INTO tenants (id, name, slug, status, trial_ends_at)
    VALUES (${tenantId}, 'Cantina', ${`fx-${tenantId}`}, 'TRIALING', now() + interval '14 days')
  `);

  return {
    tenantId,
    customer: `cus_${randomUUID().replaceAll('-', '').slice(0, 14)}`,
    subscription: `sub_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
  };
};

const row = async (tenantId: string) => {
  const rows = await admin().execute(sql`
    SELECT status, plan, stripe_customer_id AS customer, stripe_subscription_id AS subscription
    FROM tenants WHERE id = ${tenantId}
  `);

  return [...rows][0] as {
    status: string;
    plan: string | null;
    customer: string | null;
    subscription: string | null;
  };
};

const claimed = async (eventId: string) => {
  const rows = await admin().execute(
    sql`SELECT 1 FROM processed_webhooks WHERE provider = 'stripe' AND event_id = ${eventId}`,
  );

  return [...rows].length;
};

/** A winery that has bought E-commerce through Checkout. */
const paying = async (): Promise<Winery> => {
  const winery = await trialing();

  await deliver(fixture('checkout.session.completed', winery));

  return winery;
};

describe('a winery’s life, as Stripe tells it', () => {
  it('activates, blocks, recovers, changes plan, schedules a cancellation and ends', async () => {
    const winery = await trialing();
    const { tenantId, customer, subscription } = winery;

    /* Activation: the paid Checkout binds the customer and serves the widget. */
    expect(await deliver(fixture('checkout.session.completed', winery))).toEqual({
      status: 200,
      body: { received: true, type: 'checkout.session.completed', duplicate: false, applied: true },
    });
    expect(await row(tenantId)).toEqual({
      status: 'ACTIVE',
      plan: 'ECOMMERCE',
      customer,
      subscription,
    });

    /* A payment fails: dark at once, and the owners are told — once. */
    told.length = 0;
    await deliver(fixture('invoice.payment_failed', winery));
    expect((await row(tenantId)).status).toBe('PAST_DUE');
    expect(told).toEqual([[tenantId, { kind: 'payment_failed' }]]);

    /* Stripe's retry succeeds: back on, with no human. */
    await deliver(fixture('invoice.paid', winery));
    expect((await row(tenantId)).status).toBe('ACTIVE');

    /* A plan change lands through the subscription's price. */
    await deliver(
      fixture('customer.subscription.updated', winery, {
        __LOOKUP_KEY__: 'cantina_monthly_eur',
        __PRODUCT__: 'plan_cantina',
        __UNIT_AMOUNT__: 2900,
      }),
    );
    expect(await row(tenantId)).toMatchObject({ status: 'ACTIVE', plan: 'CANTINA' });

    /* A cancellation at period end is still paid for until then. */
    await deliver(
      fixture('customer.subscription.updated', winery, { __CANCEL_AT_PERIOD_END__: true }),
    );
    expect((await row(tenantId)).status).toBe('ACTIVE');

    /* The period ends: dark, and free to buy again as the same customer. */
    await deliver(fixture('customer.subscription.deleted', winery));
    expect(await row(tenantId)).toEqual({
      status: 'DISABLED',
      plan: null,
      customer,
      subscription: null,
    });
  });

  it('ends at once when the subscription is deleted immediately', async () => {
    const winery = await paying();

    await deliver(fixture('customer.subscription.deleted', winery));

    expect((await row(winery.tenantId)).status).toBe('DISABLED');
  });

  it('binds a Checkout that settles later, and serves it when the payment lands', async () => {
    const winery = await trialing();

    await deliver(fixture('checkout.session.completed', winery, { __PAYMENT_STATUS__: 'unpaid' }));
    expect(await row(winery.tenantId)).toMatchObject({
      status: 'TRIALING',
      customer: winery.customer,
      subscription: winery.subscription,
    });

    await deliver(fixture('invoice.paid', winery));
    expect((await row(winery.tenantId)).status).toBe('ACTIVE');
  });

  it('moves a subscription Stripe reports past due, and one it reports active again', async () => {
    const winery = await paying();

    await deliver(fixture('customer.subscription.updated', winery, { __STATUS__: 'past_due' }));
    expect((await row(winery.tenantId)).status).toBe('PAST_DUE');

    await deliver(fixture('customer.subscription.updated', winery, { __STATUS__: 'active' }));
    expect((await row(winery.tenantId)).status).toBe('ACTIVE');
  });
});

describe('what an attacker, or an unlucky network, sends', () => {
  const securityEvents = async () => {
    const rows = await admin().execute(sql`
      SELECT count(*)::int AS n FROM security_events
      WHERE type = 'INVALID_WEBHOOK_SIGNATURE' AND metadata->>'provider' = 'stripe'
    `);

    return ([...rows][0] as { n: number }).n;
  };

  it.each([
    ['unsigned', () => ({ 'content-type': 'application/json' })],
    [
      'signed with another secret',
      (body: string) => ({
        'content-type': 'application/json',
        'stripe-signature': signature(body, `whsec_${randomBytes(24).toString('base64')}`),
      }),
    ],
  ])(
    'is refused when %s, changes nothing, and is recorded as a security event',
    async (_what, headers) => {
      const winery = await trialing();
      const before = await securityEvents();
      const event = fixture('checkout.session.completed', winery);

      expect((await deliver(event, headers(event.body))).status).toBe(401);
      expect((await row(winery.tenantId)).status).toBe('TRIALING');
      expect(await claimed(event.eventId)).toBe(0);
      await vi.waitFor(async () => {
        expect(await securityEvents()).toBe(before + 1);
      });
    },
  );

  it('is refused when the body was changed after signing — the plan upgraded in flight', async () => {
    const winery = await trialing();
    const event = fixture('checkout.session.completed', winery);
    const forged = event.body.replace('"plan": "ECOMMERCE"', '"plan": "CANTINA"');

    const response = await app.request(`${WEBHOOK_PREFIX}/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature(event.body) },
      body: forged,
    });

    expect(response.status).toBe(401);
    expect((await row(winery.tenantId)).status).toBe('TRIALING');
  });

  it('is a no-op when replayed, and still answered 200 so Stripe stops sending it', async () => {
    const winery = await trialing();
    const event = fixture('checkout.session.completed', winery);

    await deliver(event);

    expect(await deliver(event)).toEqual({
      status: 200,
      body: { received: true, type: 'checkout.session.completed', duplicate: true, applied: false },
    });
    expect(await row(winery.tenantId)).toMatchObject({ status: 'ACTIVE' });
  });

  it('does not regress a paying winery when an older failure arrives after a newer success', async () => {
    const winery = await paying();
    const failure = fixture('invoice.payment_failed', winery);
    const success = fixture('invoice.paid', winery);

    /* Created in that order, delivered in the other. */
    await deliver(success);
    await deliver(failure);

    expect((await row(winery.tenantId)).status).toBe('ACTIVE');
  });

  it('is acknowledged, changes nothing, and is claimed when it names a winery that does not exist', async () => {
    const ghost: Winery = {
      tenantId: randomUUID(),
      customer: 'cus_ghost',
      subscription: 'sub_ghost',
    };
    const event = fixture('checkout.session.completed', ghost);

    expect(await deliver(event)).toEqual({
      status: 200,
      body: {
        received: true,
        type: 'checkout.session.completed',
        duplicate: false,
        applied: false,
      },
    });
    expect(await claimed(event.eventId)).toBe(1);
  });

  it('is acknowledged and never claimed when it names no winery at all', async () => {
    const winery = await trialing();
    const event = fixture('customer.created', winery);

    expect(await deliver(event)).toEqual({
      status: 200,
      body: { received: true, type: 'customer.created', duplicate: false, applied: false },
    });
    expect(await claimed(event.eventId)).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      { kind: 'stripe_event_unattributed', type: 'customer.created' },
      expect.any(String),
    );
  });

  it('cannot bind a customer another winery already pays with', async () => {
    const payer = await paying();
    const other = await trialing();
    const event = fixture('checkout.session.completed', { ...other, customer: payer.customer });

    expect((await deliver(event)).body).toMatchObject({ applied: false });
    expect(await row(other.tenantId)).toMatchObject({ status: 'TRIALING', customer: null });
  });
});
