import { ConflictError, NotFoundError } from '@catalogorosso/core';
import type { BillingState } from '@catalogorosso/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { createApp } from '../src/app.js';
import {
  BILLING_UNAVAILABLE,
  createBillingPort,
  NO_PLAN_FOR_TOP_UP,
  PAYMENT_OVERDUE,
  type BillingPort,
} from '../src/billing.js';
import { logger } from '../src/middleware/logger.js';
import type { StripeClient } from '../src/stripe.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * Buying 1,000 messages on top of the plan (P5-11a): the port against an
 * in-memory Stripe, and the route in front of it. What the webhook credits is
 * `billing-events.integration.test.ts`'s.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

const paying: BillingState = {
  status: 'ACTIVE',
  plan: 'CANTINA',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  locale: 'en',
};

interface Call {
  readonly verb: 'get' | 'post';
  readonly path: string;
  readonly params: unknown;
}

const fakeStripe = (prices: Record<string, string> = { messages_1000_eur: 'price_t' }) => {
  const calls: Call[] = [];

  const stripe: StripeClient = {
    get: <T>(path: string, params: unknown, schema: z.ZodType<T>) => {
      calls.push({ verb: 'get', path, params });

      const [key] = (params as { lookup_keys: string[] }).lookup_keys;
      const id = key === undefined ? undefined : prices[key];

      return Promise.resolve(
        schema.parse({ data: id === undefined ? [] : [{ id, lookup_key: key }] }),
      );
    },
    post: <T>(path: string, params: unknown, schema: z.ZodType<T>) => {
      calls.push({ verb: 'post', path, params });

      return Promise.resolve(
        schema.parse({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
      );
    },
  };

  return { stripe, calls };
};

const portWith = (state: BillingState | undefined = paying, stripe = fakeStripe()) => ({
  ...stripe,
  port: createBillingPort({
    stripe: stripe.stripe,
    dashboardOrigin: 'https://app.catalogorosso.com',
    readState: () => Promise.resolve(state),
  }),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a top-up', () => {
  it('is a one-time Checkout for the winery’s own customer, at the top-up’s price', async () => {
    const { port, calls } = portWith();

    expect(await port.topUp(TENANT)).toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
    expect(calls).toEqual([
      {
        verb: 'get',
        path: '/v1/prices',
        params: { lookup_keys: ['messages_1000_eur'], active: true, limit: 1 },
      },
      {
        verb: 'post',
        path: '/v1/checkout/sessions',
        params: {
          mode: 'payment',
          line_items: [{ price: 'price_t', quantity: 1 }],
          client_reference_id: TENANT,
          customer: 'cus_1',
          metadata: { tenant_id: TENANT, top_up: 'MESSAGES_1000' },
          payment_intent_data: { metadata: { tenant_id: TENANT, top_up: 'MESSAGES_1000' } },
          locale: 'en',
          success_url: 'https://app.catalogorosso.com/fatturazione?top_up=success',
          cancel_url: 'https://app.catalogorosso.com/fatturazione?top_up=cancelled',
        },
      },
    ]);
  });

  it.each<[string, BillingState]>([
    [
      'a trial',
      {
        ...paying,
        status: 'TRIALING',
        plan: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      },
    ],
    [
      'a winery whose subscription ended',
      { ...paying, status: 'CANCELED', stripeSubscriptionId: null },
    ],
    ['a winery switched off', { ...paying, status: 'DISABLED' }],
  ])('is refused for %s, which has no plan to add to', async (_what, state) => {
    const { port, calls } = portWith(state);

    await expect(port.topUp(TENANT)).rejects.toThrow(new ConflictError(NO_PLAN_FOR_TOP_UP));
    expect(calls).toEqual([]);
  });

  it('is refused for a winery whose payment failed, and says what would help', async () => {
    const { port, calls } = portWith({ ...paying, status: 'PAST_DUE' });

    await expect(port.topUp(TENANT)).rejects.toThrow(new ConflictError(PAYMENT_OVERDUE));
    expect(calls).toEqual([]);
  });

  it('is refused plainly where there is no Stripe', async () => {
    const port = createBillingPort({
      stripe: undefined,
      dashboardOrigin: 'https://app.catalogorosso.com',
      readState: () => Promise.resolve(paying),
    });

    await expect(port.topUp(TENANT)).rejects.toThrow(new ConflictError(BILLING_UNAVAILABLE));
  });

  it('is refused when the price was never created, and tells the operator what to run', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { port, calls } = portWith(paying, fakeStripe({}));

    await expect(port.topUp(TENANT)).rejects.toThrow(new ConflictError(BILLING_UNAVAILABLE));
    expect(calls.filter((call) => call.verb === 'post')).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      { kind: 'stripe_price_missing', type: 'MESSAGES_1000' },
      expect.stringContaining('stripe-setup.mjs'),
    );
  });

  it('is a 404 for a winery that is gone', async () => {
    /* Built here: `portWith(undefined)` would take its default winery instead. */
    const port = createBillingPort({
      stripe: fakeStripe().stripe,
      dashboardOrigin: 'https://app.catalogorosso.com',
      readState: () => Promise.resolve(undefined),
    });

    await expect(port.topUp(TENANT)).rejects.toThrow(NotFoundError);
  });
});

describe('the route', () => {
  const recording = () => {
    const asked: string[] = [];
    const billing: BillingPort = {
      checkout: () => Promise.reject(new Error('not this route')),
      changePlan: () => Promise.reject(new Error('not this route')),
      portal: () => Promise.reject(new Error('not this route')),
      topUp: (tenantId) => {
        asked.push(tenantId);
        return Promise.resolve({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
      },
    };

    return { asked, billing };
  };

  const post = (role: 'OWNER' | 'EDITOR', billing: BillingPort, fresh = true) =>
    createApp({
      auth: signedIn(undefined, { fresh }),
      readMemberships: oneMembership(TENANT, role),
      billing,
    }).request('/v1/dashboard/billing/top-up', { method: 'POST' });

  it('answers the owner with the page, for the session’s own winery', async () => {
    const { asked, billing } = recording();
    const response = await post('OWNER', billing);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    expect(asked).toEqual([TENANT]);
  });

  it('asks for no fresh second factor: paying on Stripe’s page is the confirmation', async () => {
    const { asked, billing } = recording();

    expect((await post('OWNER', billing, false)).status).toBe(200);
    expect(asked).toEqual([TENANT]);
  });

  it('refuses an editor, who cannot spend the winery’s money', async () => {
    const { asked, billing } = recording();

    expect((await post('EDITOR', billing)).status).toBe(403);
    expect(asked).toEqual([]);
  });
});
