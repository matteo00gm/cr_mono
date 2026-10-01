import { ConflictError, NotFoundError } from '@catalogorosso/core';
import type { BillingState } from '@catalogorosso/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { createApp } from '../src/app.js';
import {
  BILLING_UNAVAILABLE,
  createBillingPort,
  createPlanRestorer,
  NO_SUBSCRIPTION,
  SAME_PLAN,
  type BillingPort,
} from '../src/billing.js';
import { logger } from '../src/middleware/logger.js';
import type { StripeClient } from '../src/stripe.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * Changing plan (P5-09): up now and prorated, down at period end, and our
 * record moved by nobody but the webhook.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const PERIOD_END = 1_792_592_000;

const onCantina: BillingState = {
  status: 'ACTIVE',
  plan: 'CANTINA',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  locale: 'it',
};

interface Call {
  readonly verb: 'get' | 'post';
  readonly path: string;
  readonly params: unknown;
}

interface Script {
  /** The lookup key of the price the subscription is on today. */
  readonly lookupKey?: string;
  /** The schedule a pending downgrade left on it, if any. */
  readonly pendingSchedule?: string | null;
  /** The active prices under their lookup keys. */
  readonly prices?: Readonly<Record<string, string>>;
}

/** A Stripe with a subscription on one price, and a schedule if one is pending. */
const scripted = ({
  lookupKey = 'cantina_monthly_eur',
  pendingSchedule = null,
  prices = { cantina_monthly_eur: 'price_c', ecommerce_monthly_eur: 'price_e' },
}: Script = {}) => {
  const calls: Call[] = [];

  const stripe: StripeClient = {
    get: <T>(path: string, params: unknown, schema: z.ZodType<T>) => {
      calls.push({ verb: 'get', path, params });

      if (path === '/v1/prices') {
        const [key] = (params as { lookup_keys: string[] }).lookup_keys;
        const id = key === undefined ? undefined : prices[key];

        return Promise.resolve(
          schema.parse({ data: id === undefined ? [] : [{ id, lookup_key: key }] }),
        );
      }

      return Promise.resolve(
        schema.parse({
          id: 'sub_1',
          schedule: pendingSchedule,
          items: {
            data: [
              {
                id: 'si_1',
                current_period_end: PERIOD_END,
                price: { id: prices[lookupKey] ?? 'price_other', lookup_key: lookupKey },
              },
            ],
          },
        }),
      );
    },
    post: <T>(path: string, params: unknown, schema: z.ZodType<T>) => {
      calls.push({ verb: 'post', path, params });

      return Promise.resolve(
        schema.parse(
          path === '/v1/subscription_schedules'
            ? { id: 'sub_sched_1', phases: [{ start_date: 1_790_000_000, end_date: PERIOD_END }] }
            : { id: 'x' },
        ),
      );
    },
  };

  return { stripe, calls };
};

/** A winery that fits Cantina: under its 300 wines and its one domain. */
const SMALL = { wines: 120, domains: 1 };

const portWith = (
  state: BillingState | undefined,
  stripe = scripted(),
  footprint: { wines: number; domains: number } = SMALL,
) => ({
  ...stripe,
  port: createBillingPort({
    stripe: stripe.stripe,
    dashboardOrigin: 'https://app.catalogorosso.com',
    readState: () => Promise.resolve(state),
    readFootprint: () => Promise.resolve(footprint),
  }),
});

const writes = (calls: readonly Call[]) =>
  calls.filter((call) => call.verb === 'post').map(({ path, params }) => ({ path, params }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an upgrade', () => {
  it('moves the subscription’s item to the higher price now, prorated', async () => {
    const { port, calls } = portWith(onCantina);

    expect(await port.changePlan(TENANT, 'ECOMMERCE')).toEqual({
      plan: 'ECOMMERCE',
      effective: 'now',
      effectiveAt: null,
    });
    expect(writes(calls)).toEqual([
      {
        path: '/v1/subscriptions/sub_1',
        params: {
          items: [{ id: 'si_1', price: 'price_e' }],
          proration_behavior: 'create_prorations',
        },
      },
    ]);
  });

  it('releases a pending downgrade first, which the upgrade replaces', async () => {
    const { port, calls } = portWith(onCantina, scripted({ pendingSchedule: 'sub_sched_old' }));

    await port.changePlan(TENANT, 'ECOMMERCE');

    expect(writes(calls).map((call) => call.path)).toEqual([
      '/v1/subscription_schedules/sub_sched_old/release',
      '/v1/subscriptions/sub_1',
    ]);
  });
});

describe('a downgrade', () => {
  const onEcommerce: BillingState = { ...onCantina, plan: 'ECOMMERCE' };

  it('is scheduled for the end of the period already paid for, and refunds nothing', async () => {
    const { port, calls } = portWith(onEcommerce, scripted({ lookupKey: 'ecommerce_monthly_eur' }));

    expect(await port.changePlan(TENANT, 'CANTINA')).toEqual({
      plan: 'CANTINA',
      effective: 'period_end',
      effectiveAt: new Date(PERIOD_END * 1000).toISOString(),
    });
    expect(writes(calls)).toEqual([
      { path: '/v1/subscription_schedules', params: { from_subscription: 'sub_1' } },
      {
        path: '/v1/subscription_schedules/sub_sched_1',
        params: {
          end_behavior: 'release',
          phases: [
            {
              items: [{ price: 'price_e', quantity: 1 }],
              start_date: 1_790_000_000,
              end_date: PERIOD_END,
            },
            { items: [{ price: 'price_c', quantity: 1 }], proration_behavior: 'none' },
          ],
        },
      },
    ]);
  });

  it('asked for again is built afresh, the pending one released', async () => {
    const { port, calls } = portWith(
      onEcommerce,
      scripted({ lookupKey: 'ecommerce_monthly_eur', pendingSchedule: 'sub_sched_old' }),
    );

    await port.changePlan(TENANT, 'CANTINA');

    expect(writes(calls).map((call) => call.path)).toEqual([
      '/v1/subscription_schedules/sub_sched_old/release',
      '/v1/subscription_schedules',
      '/v1/subscription_schedules/sub_sched_1',
    ]);
  });
});

describe('what is refused', () => {
  it('a winery with no subscription, and Stripe is not asked', async () => {
    const { port, calls } = portWith({ ...onCantina, stripeSubscriptionId: null });

    await expect(port.changePlan(TENANT, 'ECOMMERCE')).rejects.toThrow(
      new ConflictError(NO_SUBSCRIPTION),
    );
    expect(calls).toEqual([]);
  });

  it('the plan the winery is on — as Stripe bills it, not as our record lags', async () => {
    /* Our record still says Cantina; Stripe already bills E-commerce, a webhook away. */
    const { port, calls } = portWith(onCantina, scripted({ lookupKey: 'ecommerce_monthly_eur' }));

    await expect(port.changePlan(TENANT, 'ECOMMERCE')).rejects.toThrow(
      new ConflictError(SAME_PLAN),
    );
    expect(writes(calls)).toEqual([]);
  });

  it('when the account has no price under the plan’s key', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { port, calls } = portWith(
      onCantina,
      scripted({ prices: { cantina_monthly_eur: 'price_c' } }),
    );

    await expect(port.changePlan(TENANT, 'ECOMMERCE')).rejects.toThrow(
      new ConflictError(BILLING_UNAVAILABLE),
    );
    expect(writes(calls)).toEqual([]);
  });

  it('where this service has no Stripe key', async () => {
    const port = createBillingPort({
      dashboardOrigin: 'https://app.catalogorosso.com',
      readState: () => Promise.resolve(onCantina),
    });

    await expect(port.changePlan(TENANT, 'ECOMMERCE')).rejects.toThrow(
      new ConflictError(BILLING_UNAVAILABLE),
    );
  });

  it('when the winery is gone', async () => {
    const { port } = portWith(undefined);

    await expect(port.changePlan(TENANT, 'ECOMMERCE')).rejects.toThrow(NotFoundError);
  });
});

describe('a plan the record does not know', () => {
  it('goes by Stripe’s price, and treats a price that is not ours as the bottom of the ladder', async () => {
    const { port, calls } = portWith(
      { ...onCantina, plan: null },
      scripted({ lookupKey: 'legacy_price' }),
    );

    expect(await port.changePlan(TENANT, 'CANTINA')).toMatchObject({ effective: 'now' });
    expect(writes(calls).map((call) => call.path)).toEqual(['/v1/subscriptions/sub_1']);
  });
});

describe('the route', () => {
  const change = (role: 'OWNER' | 'EDITOR', body: unknown, fresh = true) => {
    const asked: string[] = [];
    const billing: BillingPort = {
      checkout: () => Promise.reject(new Error('not this route')),
      portal: () => Promise.reject(new Error('not this route')),
      changePlan: (tenantId, plan) => {
        asked.push(`${tenantId}:${plan}`);
        return Promise.resolve({ plan, effective: 'now', effectiveAt: null });
      },
      topUp: () => Promise.reject(new Error('not this route')),
    };
    const app = createApp({
      auth: signedIn(undefined, { fresh }),
      readMemberships: oneMembership(TENANT, role),
      billing,
    });

    return {
      asked,
      request: () =>
        app.request('/v1/dashboard/billing/plan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
    };
  };

  it('answers the owner, for the session’s own winery', async () => {
    const { asked, request } = change('OWNER', { plan: 'ECOMMERCE' });
    const response = await request();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      plan: 'ECOMMERCE',
      effective: 'now',
      effectiveAt: null,
    });
    expect(asked).toEqual([`${TENANT}:ECOMMERCE`]);
  });

  it('refuses an editor', async () => {
    const { asked, request } = change('EDITOR', { plan: 'ECOMMERCE' });

    expect((await request()).status).toBe(403);
    expect(asked).toEqual([]);
  });

  it('asks for a fresh second factor (P4-11)', async () => {
    const { asked, request } = change('OWNER', { plan: 'ECOMMERCE' }, false);
    const response = await request();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'step_up_required' } });
    expect(asked).toEqual([]);
  });

  it('refuses a body naming anything but a plan', async () => {
    const { asked, request } = change('OWNER', { plan: 'ECOMMERCE', tenantId: TENANT });

    expect((await request()).status).toBe(422);
    expect(asked).toEqual([]);
  });
});

describe('a downgrade the winery does not fit (P5-10)', () => {
  const onEcommerce: BillingState = { ...onCantina, plan: 'ECOMMERCE' };
  const onEcommerceStripe = () =>
    scripted({ lookupKey: 'ecommerce_monthly_eur', pendingSchedule: 'sub_sched_pending' });

  it('is refused before anything is written, naming what to reduce and by how much', async () => {
    const { port, calls } = portWith(onEcommerce, onEcommerceStripe(), { wines: 412, domains: 2 });

    await expect(port.changePlan(TENANT, 'CANTINA')).rejects.toThrow(
      new ConflictError(
        'Cantina allows 300 wines and 1 domain. To move to Cantina, archive 112 wines (412 of 300) ' +
          'and remove 1 domain (2 of 1) first.',
      ),
    );
    /* The downgrade already pending is left exactly as it was. */
    expect(writes(calls)).toEqual([]);
  });

  it('is refused for the catalogue alone', async () => {
    const { port } = portWith(onEcommerce, onEcommerceStripe(), { wines: 301, domains: 1 });

    await expect(port.changePlan(TENANT, 'CANTINA')).rejects.toThrow(
      'Cantina allows 300 wines and 1 domain. To move to Cantina, archive 1 wine (301 of 300) first.',
    );
  });

  it('is allowed at the caps exactly', async () => {
    const { port } = portWith(onEcommerce, onEcommerceStripe(), { wines: 300, domains: 1 });

    expect(await port.changePlan(TENANT, 'CANTINA')).toMatchObject({ effective: 'period_end' });
  });

  it('is not asked of an upgrade, which fits by definition', async () => {
    const { port } = portWith(onCantina, scripted(), { wines: 9_999, domains: 9 });

    expect(await port.changePlan(TENANT, 'ECOMMERCE')).toMatchObject({ effective: 'now' });
  });
});

describe('putting a refused downgrade back (P5-10)', () => {
  const restorerWith = (state: BillingState | undefined, stripe = scripted()) => ({
    ...stripe,
    restore: createPlanRestorer({ stripe: stripe.stripe, readState: () => Promise.resolve(state) }),
  });

  it('moves the item back to the kept plan’s price, charging nothing for the move', async () => {
    const { restore, calls } = restorerWith(onCantina);

    await restore(TENANT, 'ECOMMERCE');

    expect(writes(calls)).toEqual([
      {
        path: '/v1/subscriptions/sub_1',
        params: { items: [{ id: 'si_1', price: 'price_e' }], proration_behavior: 'none' },
      },
    ]);
  });

  it('releases the schedule still attached first, so it cannot move the price again', async () => {
    const { restore, calls } = restorerWith(
      onCantina,
      scripted({ pendingSchedule: 'sub_sched_9' }),
    );

    await restore(TENANT, 'ECOMMERCE');

    expect(writes(calls).map(({ path }) => path)).toEqual([
      '/v1/subscription_schedules/sub_sched_9/release',
      '/v1/subscriptions/sub_1',
    ]);
  });

  it('does nothing for a winery whose subscription has since ended', async () => {
    const { restore, calls } = restorerWith({ ...onCantina, stripeSubscriptionId: null });

    await restore(TENANT, 'ECOMMERCE');

    expect(calls).toEqual([]);
  });

  it('does nothing for a winery that is gone', async () => {
    const { restore, calls } = restorerWith(undefined);

    await restore(TENANT, 'ECOMMERCE');

    expect(calls).toEqual([]);
  });

  it('refuses where there is no Stripe', async () => {
    const restore = createPlanRestorer({
      stripe: undefined,
      readState: () => Promise.resolve(onCantina),
    });

    await expect(restore(TENANT, 'ECOMMERCE')).rejects.toThrow(BILLING_UNAVAILABLE);
  });
});
