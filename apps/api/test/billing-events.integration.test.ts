import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBillingEffect } from '../src/billing-events.js';
import { createBillingNotifier, type BillingNotice } from '../src/billing-notices.js';
import { logger } from '../src/middleware/logger.js';
import { createStripeEventsPort, type StripeDelivery } from '../src/stripe-events.js';

/**
 * The state machine applied to a real winery (P5-05): the production port with
 * the production effect, against Postgres as `app_rw`. What the machine
 * decides is `state.test.ts`'s; this is what reaches the row, the ledger and
 * the audit log, with the payloads shaped as Stripe sends them.
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

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

const port = createStripeEventsPort({ apply: createBillingEffect({ livemode: false }) });

const trialing = async () => {
  const tenantId = randomUUID();

  await admin().execute(sql`
    INSERT INTO tenants (id, name, slug, status, trial_ends_at)
    VALUES (${tenantId}, 'Cantina', ${`be-${tenantId}`}, 'TRIALING', now() + interval '14 days')
  `);

  return tenantId;
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

const audited = async (tenantId: string) => {
  const rows = await admin().execute(sql`
    SELECT action, actor_user_id, metadata FROM audit_log
    WHERE tenant_id = ${tenantId} AND action = 'billing.status_changed'
    ORDER BY created_at
  `);

  return [...rows] as { action: string; actor_user_id: string | null; metadata: unknown }[];
};

let second = 0;

/** A Stripe event, created one second after the last, as Stripe would number them. */
const event = (
  type: string,
  object: Record<string, unknown>,
  { livemode = false, created }: { livemode?: boolean; created?: number } = {},
): StripeDelivery => {
  second += 1;
  const id = `evt_${randomUUID()}`;

  return {
    eventId: id,
    type,
    payload: { id, type, livemode, created: created ?? 1_790_000_000 + second, data: { object } },
  };
};

const paidCheckout = (
  tenantId: string,
  customer: string,
  subscription: string,
  plan = 'ECOMMERCE',
) =>
  event('checkout.session.completed', {
    mode: 'subscription',
    customer,
    subscription,
    payment_status: 'paid',
    client_reference_id: tenantId,
    metadata: { tenant_id: tenantId, plan },
  });

const invoiceFor = (
  type: 'invoice.payment_failed' | 'invoice.paid',
  tenantId: string,
  customer: string,
  subscription: string,
  created?: number,
) =>
  event(
    type,
    {
      customer,
      parent: { subscription_details: { subscription, metadata: { tenant_id: tenantId } } },
    },
    created === undefined ? {} : { created },
  );

const subscriptionEvent = (
  type: string,
  tenantId: string,
  customer: string,
  subscription: string,
  status = 'active',
  lookupKey = 'ecommerce_monthly_eur',
) =>
  event(type, {
    id: subscription,
    customer,
    status,
    metadata: { tenant_id: tenantId },
    items: { data: [{ price: { lookup_key: lookupKey } }] },
  });

/** A winery that has bought E-commerce and been activated. */
const paying = async () => {
  const tenantId = await trialing();
  const customer = `cus_${randomUUID()}`;
  const subscription = `sub_${randomUUID()}`;

  await port.record(paidCheckout(tenantId, customer, subscription));

  return { tenantId, customer, subscription };
};

describe('a paid Checkout', () => {
  it('activates the winery on the plan it bought, binds its customer, and is audited with no actor', async () => {
    const tenantId = await trialing();
    const customer = `cus_${randomUUID()}`;
    const subscription = `sub_${randomUUID()}`;

    expect(await port.record(paidCheckout(tenantId, customer, subscription))).toEqual({
      duplicate: false,
      applied: true,
    });
    expect(await row(tenantId)).toEqual({
      status: 'ACTIVE',
      plan: 'ECOMMERCE',
      customer,
      subscription,
    });
    expect(await audited(tenantId)).toEqual([
      {
        action: 'billing.status_changed',
        actor_user_id: null,
        metadata: { from: 'TRIALING', to: 'ACTIVE', event: 'checkout.session.completed' },
      },
    ]);
  });
});

describe('a failed payment, and the recovery', () => {
  it('blocks at once and restores when Stripe’s retry succeeds, with no human', async () => {
    const { tenantId, customer, subscription } = await paying();

    await port.record(invoiceFor('invoice.payment_failed', tenantId, customer, subscription));
    expect((await row(tenantId)).status).toBe('PAST_DUE');

    await port.record(invoiceFor('invoice.paid', tenantId, customer, subscription));
    expect((await row(tenantId)).status).toBe('ACTIVE');
  });

  it('keeps a winery blocked when an older success arrives after a newer failure', async () => {
    const { tenantId, customer, subscription } = await paying();
    const early = 1_790_000_000 + second + 1;

    await port.record(
      invoiceFor('invoice.payment_failed', tenantId, customer, subscription, early + 5),
    );
    await port.record(invoiceFor('invoice.paid', tenantId, customer, subscription, early));

    expect((await row(tenantId)).status).toBe('PAST_DUE');
  });
});

describe('an ended subscription', () => {
  it('switches the widget off and frees the winery to buy again, as the same customer', async () => {
    const { tenantId, customer, subscription } = await paying();

    await port.record(
      subscriptionEvent('customer.subscription.deleted', tenantId, customer, subscription),
    );

    expect(await row(tenantId)).toEqual({
      status: 'DISABLED',
      plan: null,
      customer,
      subscription: null,
    });
  });
});

describe('an event that changes nothing, and is still handled', () => {
  const claimed = async (delivery: StripeDelivery) => {
    const rows = await admin().execute(
      sql`SELECT 1 FROM processed_webhooks WHERE provider = 'stripe' AND event_id = ${delivery.eventId}`,
    );

    return [...rows].length;
  };

  it('from the other mode: a live event on a test stage', async () => {
    const tenantId = await trialing();
    const live = {
      ...paidCheckout(tenantId, `cus_${randomUUID()}`, `sub_${randomUUID()}`),
    };
    const delivery = { ...live, payload: { ...(live.payload as object), livemode: true } };

    expect(await port.record(delivery)).toEqual({ duplicate: false, applied: false });
    expect((await row(tenantId)).status).toBe('TRIALING');
    expect(await claimed(delivery)).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      { kind: 'stripe_event_wrong_mode', type: 'checkout.session.completed' },
      expect.any(String),
    );
  });

  it('for another customer than the one on file', async () => {
    const { tenantId, subscription } = await paying();
    const delivery = invoiceFor('invoice.payment_failed', tenantId, 'cus_stranger', subscription);

    expect(await port.record(delivery)).toEqual({ duplicate: false, applied: false });
    expect((await row(tenantId)).status).toBe('ACTIVE');
    expect(await claimed(delivery)).toBe(1);
  });

  it('for a customer already bound to another winery — refused, and claimed rather than retried for ever', async () => {
    const { customer } = await paying();
    const other = await trialing();
    const delivery = paidCheckout(other, customer, `sub_${randomUUID()}`);

    expect(await port.record(delivery)).toEqual({ duplicate: false, applied: false });
    expect(await row(other)).toMatchObject({ status: 'TRIALING', customer: null });
    expect(await claimed(delivery)).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { kind: 'stripe_event_ignored', type: 'customer_taken' },
      expect.any(String),
    );
  });

  it('for a second paid Checkout, which does not replace the first subscription', async () => {
    const { tenantId, customer, subscription } = await paying();

    await port.record(paidCheckout(tenantId, customer, `sub_${randomUUID()}`));

    expect((await row(tenantId)).subscription).toBe(subscription);
    expect(logger.warn).toHaveBeenCalledWith(
      { kind: 'stripe_event_ignored', type: 'second_subscription' },
      expect.any(String),
    );
  });

  it('of a type the machine acts on, in a shape it cannot read, and says so', async () => {
    const tenantId = await trialing();

    await port.record(
      event('invoice.paid', { customer: { id: 'cus_x' }, metadata: { tenant_id: tenantId } }),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      { kind: 'stripe_event_unreadable', type: 'invoice.paid' },
      expect.any(String),
    );
  });
});

describe('the owners, told (P5-05a)', () => {
  const told: [string, BillingNotice][] = [];
  const telling = createStripeEventsPort({
    apply: createBillingEffect({ livemode: false }),
    notify: (tenantId, notice) => {
      told.push([tenantId, notice]);
      return Promise.resolve();
    },
  });

  it('once when the widget goes dark, not again for a second failure, and not on recovery', async () => {
    told.length = 0;
    const tenantId = await trialing();
    const customer = `cus_${randomUUID()}`;
    const subscription = `sub_${randomUUID()}`;

    await telling.record(paidCheckout(tenantId, customer, subscription));
    expect(told).toEqual([]);

    await telling.record(invoiceFor('invoice.payment_failed', tenantId, customer, subscription));
    await telling.record(invoiceFor('invoice.payment_failed', tenantId, customer, subscription));
    await telling.record(invoiceFor('invoice.paid', tenantId, customer, subscription));

    expect(told).toEqual([[tenantId, { kind: 'payment_failed' }]]);
  });

  it('never for a redelivered failure, which is a duplicate', async () => {
    told.length = 0;
    const { tenantId, customer, subscription } = await paying();
    const failure = invoiceFor('invoice.payment_failed', tenantId, customer, subscription);

    await telling.record(failure);
    await telling.record(failure);

    expect(told).toEqual([[tenantId, { kind: 'payment_failed' }]]);
  });
});

describe('who is told (P5-05a)', () => {
  it('every owner of the winery, in its language — and no editor, and nobody from another winery', async () => {
    const tenantId = await trialing();
    const other = await trialing();
    const person = async (tenant: string, role: 'OWNER' | 'EDITOR', email: string) => {
      const userId = `user_${randomUUID().slice(0, 8)}`;

      await admin().execute(sql`
        INSERT INTO auth_users (id, name, email) VALUES (${userId}, ${email}, ${email})
      `);
      await admin().execute(sql`
        INSERT INTO memberships (tenant_id, user_id, role) VALUES (${tenant}, ${userId}, ${role})
      `);
    };

    await admin().execute(
      sql`UPDATE tenants SET locale = 'en', name = 'Cantina Rossi' WHERE id = ${tenantId}`,
    );
    await person(tenantId, 'OWNER', `anna-${tenantId}@rossi.example`);
    await person(tenantId, 'OWNER', `marco-${tenantId}@rossi.example`);
    await person(tenantId, 'EDITOR', `luca-${tenantId}@rossi.example`);
    await person(other, 'OWNER', `someone-${other}@verdi.example`);

    const sent: { to: string; template: string; locale: unknown; props: unknown }[] = [];
    const notify = createBillingNotifier({
      dashboardOrigin: 'https://app.catalogorosso.com',
      sendEmailFor: () =>
        ((message: { to: string; template: string; locale: unknown; props: unknown }) => {
          sent.push(message);
          return Promise.resolve({ outcome: 'sent' });
        }) as never,
    });

    await notify(tenantId, { kind: 'payment_failed' });

    expect(sent.map((message) => message.to).sort()).toEqual([
      `anna-${tenantId}@rossi.example`,
      `marco-${tenantId}@rossi.example`,
    ]);
    expect(sent[0]).toMatchObject({
      template: 'payment-failed',
      locale: 'en',
      props: {
        tenantName: 'Cantina Rossi',
        billingUrl: 'https://app.catalogorosso.com/fatturazione',
      },
    });
  });
});

describe('a downgrade re-checked as it applies (P5-10)', () => {
  const told: [string, BillingNotice][] = [];
  const telling = createStripeEventsPort({
    apply: createBillingEffect({ livemode: false }),
    notify: (tenantId, notice) => {
      told.push([tenantId, notice]);
      return Promise.resolve();
    },
  });

  beforeEach(() => {
    told.length = 0;
  });

  /** `count` wines in `status`, as the catalogue holds them. */
  const wines = async (tenantId: string, count: number, status = 'ACTIVE') => {
    await admin().execute(sql`
      INSERT INTO products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status, status)
      SELECT ${tenantId}::uuid, ${status} || '-' || g, 'Barolo', 'red', 4500, 'EUR', 'IN_STOCK',
             ${status}::product_status
      FROM generate_series(1, ${count}) g
    `);
  };

  const periodEnd = (tenantId: string, customer: string, subscription: string) =>
    subscriptionEvent(
      'customer.subscription.updated',
      tenantId,
      customer,
      subscription,
      'active',
      'cantina_monthly_eur',
    );

  it('moves a winery that fits to the lower plan, and leaves nothing to do', async () => {
    const { tenantId, customer, subscription } = await paying();

    await wines(tenantId, 300);
    await telling.record(periodEnd(tenantId, customer, subscription));

    expect((await row(tenantId)).plan).toBe('CANTINA');
    expect(told).toEqual([]);
  });

  it('keeps a winery that grew past the lower plan where it is, and says what to reduce', async () => {
    const { tenantId, customer, subscription } = await paying();

    await wines(tenantId, 412);

    expect(await telling.record(periodEnd(tenantId, customer, subscription))).toEqual({
      duplicate: false,
      applied: true,
    });
    expect(await row(tenantId)).toEqual({
      status: 'ACTIVE',
      plan: 'ECOMMERCE',
      customer,
      subscription,
    });
    expect(told).toEqual([
      [
        tenantId,
        {
          kind: 'downgrade_deferred',
          kept: 'ECOMMERCE',
          wanted: 'CANTINA',
          reason:
            'Cantina allows 300 wines and 1 domain. To move to Cantina, archive 112 wines (412 of 300) first.',
        },
      ],
    ]);
  });

  it('counts only active wines, and only the winery’s own', async () => {
    const { tenantId, customer, subscription } = await paying();
    const neighbour = await paying();

    await wines(tenantId, 300);
    await wines(tenantId, 50, 'ARCHIVED');
    await wines(neighbour.tenantId, 50);
    await telling.record(periodEnd(tenantId, customer, subscription));

    expect((await row(tenantId)).plan).toBe('CANTINA');
  });

  it('counts production domains as the domain cap counts them', async () => {
    const { tenantId, customer, subscription } = await paying();
    const domain = (registrable: string, kind: 'production' | 'staging') =>
      admin().execute(sql`
        INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status, verified_at, kind)
        VALUES (${tenantId}, ${`https://${registrable}`}, ${registrable}, 'VERIFIED', now(),
                ${kind}::domain_kind)
      `);

    await domain(`a-${tenantId}.example`, 'production');
    await domain(`b-${tenantId}.example`, 'production');
    await domain(`c-${tenantId}.example`, 'staging');
    await telling.record(periodEnd(tenantId, customer, subscription));

    expect((await row(tenantId)).plan).toBe('ECOMMERCE');
    expect(told[0]?.[1]).toMatchObject({
      kind: 'downgrade_deferred',
      reason:
        'Cantina allows 300 wines and 1 domain. To move to Cantina, remove 1 domain (2 of 1) first.',
    });
  });

  it('never re-checks a move up', async () => {
    const tenantId = await trialing();
    const customer = `cus_${randomUUID()}`;
    const subscription = `sub_${randomUUID()}`;

    await port.record(paidCheckout(tenantId, customer, subscription, 'CANTINA'));
    await wines(tenantId, 412);
    await telling.record(
      subscriptionEvent('customer.subscription.updated', tenantId, customer, subscription),
    );

    expect((await row(tenantId)).plan).toBe('ECOMMERCE');
    expect(told).toEqual([]);
  });
});
