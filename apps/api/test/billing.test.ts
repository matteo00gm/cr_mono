import { ConflictError, NotFoundError } from '@catalogorosso/core';
import type { BillingState } from '@catalogorosso/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { createApp } from '../src/app.js';
import {
  ALREADY_SUBSCRIBED,
  BILLING_UNAVAILABLE,
  createBillingPort,
  type BillingPort,
} from '../src/billing.js';
import { logger } from '../src/middleware/logger.js';
import type { StripeClient } from '../src/stripe.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * Buying a plan (P5-02): the port against an in-memory Stripe, and the route
 * in front of it.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

const fresh: BillingState = {
  status: 'TRIALING',
  plan: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  locale: 'it',
};

interface Call {
  readonly verb: 'get' | 'post';
  readonly path: string;
  readonly params: unknown;
}

/** Answers as Stripe would, with `prices` under their lookup keys. */
const fakeStripe = (
  prices: Record<string, string> = {
    cantina_monthly_eur: 'price_c',
    ecommerce_monthly_eur: 'price_e',
  },
) => {
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

const portWith = (state: BillingState | undefined = fresh, stripe = fakeStripe()) => ({
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

describe('buying a plan', () => {
  it('answers with a Checkout page for the plan’s current price', async () => {
    const { port, calls } = portWith();

    expect(await port.checkout(TENANT, 'ECOMMERCE')).toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
    expect(calls[0]).toEqual({
      verb: 'get',
      path: '/v1/prices',
      params: { lookup_keys: ['ecommerce_monthly_eur'], active: true, limit: 1 },
    });
    expect(calls[1]?.path).toBe('/v1/checkout/sessions');
    expect(calls[1]?.params).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: 'price_e', quantity: 1 }],
      client_reference_id: TENANT,
      metadata: { tenant_id: TENANT, plan: 'ECOMMERCE' },
      subscription_data: { metadata: { tenant_id: TENANT, plan: 'ECOMMERCE' } },
      success_url: 'https://app.catalogorosso.com/fatturazione?checkout=success',
    });
  });

  it('reuses the customer a returning winery already is', async () => {
    const { port, calls } = portWith({ ...fresh, stripeCustomerId: 'cus_returning' });

    await port.checkout(TENANT, 'CANTINA');

    expect(calls[1]?.params).toMatchObject({ customer: 'cus_returning' });
  });

  it('refuses a second subscription, and asks Stripe nothing', async () => {
    const { port, calls } = portWith({
      ...fresh,
      stripeSubscriptionId: 'sub_live',
      stripeCustomerId: 'cus_1',
    });

    await expect(port.checkout(TENANT, 'ECOMMERCE')).rejects.toThrow(
      new ConflictError(ALREADY_SUBSCRIBED),
    );
    expect(calls).toEqual([]);
  });

  it('refuses plainly where this service has no Stripe key', async () => {
    const port = createBillingPort({
      dashboardOrigin: 'https://app.catalogorosso.com',
      readState: () => Promise.resolve(fresh),
    });

    await expect(port.checkout(TENANT, 'CANTINA')).rejects.toThrow(
      new ConflictError(BILLING_UNAVAILABLE),
    );
  });

  it('refuses when the account has no price under the plan’s key, and tells the operator what to run', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { port, calls } = portWith(fresh, fakeStripe({}));

    await expect(port.checkout(TENANT, 'CANTINA')).rejects.toThrow(
      new ConflictError(BILLING_UNAVAILABLE),
    );
    expect(calls.map((call) => call.verb)).toEqual(['get']);
    expect(error).toHaveBeenCalledWith(
      { kind: 'stripe_price_missing', type: 'CANTINA' },
      expect.stringContaining('stripe-setup.mjs'),
    );
  });

  it('does not take a price filed under another key for the plan’s', async () => {
    const { port } = portWith(fresh, {
      ...fakeStripe(),
      stripe: {
        ...fakeStripe().stripe,
        get: <T>(_path: string, _params: unknown, schema: z.ZodType<T>) =>
          Promise.resolve(
            schema.parse({ data: [{ id: 'price_other', lookup_key: 'something_else' }] }),
          ),
      },
    });

    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await expect(port.checkout(TENANT, 'CANTINA')).rejects.toThrow(BILLING_UNAVAILABLE);
  });

  it('answers not found when the winery is gone', async () => {
    const port = createBillingPort({
      stripe: fakeStripe().stripe,
      dashboardOrigin: 'https://app.catalogorosso.com',
      readState: () => Promise.resolve(undefined),
    });

    await expect(port.checkout(TENANT, 'CANTINA')).rejects.toThrow(NotFoundError);
  });
});

describe('the route', () => {
  const recording = () => {
    const asked: string[] = [];
    const billing: BillingPort = {
      checkout: (tenantId, plan) => {
        asked.push(`${tenantId}:${plan}`);

        return Promise.resolve({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
      },
    };

    return { asked, billing };
  };

  const post = (role: 'OWNER' | 'EDITOR', billing: BillingPort, body: unknown) =>
    createApp({ auth: signedIn(), readMemberships: oneMembership(TENANT, role), billing }).request(
      '/v1/dashboard/billing/checkout',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

  it('answers the owner with the page, for the session’s own winery', async () => {
    const { asked, billing } = recording();
    const response = await post('OWNER', billing, { plan: 'CANTINA' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    expect(asked).toEqual([`${TENANT}:CANTINA`]);
  });

  it('refuses an editor, who cannot spend the winery’s money', async () => {
    const { asked, billing } = recording();

    expect((await post('EDITOR', billing, { plan: 'CANTINA' })).status).toBe(403);
    expect(asked).toEqual([]);
  });

  it.each([
    ['a plan that does not exist', { plan: 'ENTERPRISE' }],
    ['no plan', {}],
    ['a tenant id beside the plan (P0-48)', { plan: 'CANTINA', tenantId: TENANT }],
  ])('refuses %s, naming the plans there are', async (_what, body) => {
    const { asked, billing } = recording();
    const response = await post('OWNER', billing, body);

    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain(
      'Send a JSON body naming the plan: {\\"plan\\": \\"CANTINA\\"} or {\\"plan\\": \\"ECOMMERCE\\"}.',
    );
    expect(asked).toEqual([]);
  });
});
