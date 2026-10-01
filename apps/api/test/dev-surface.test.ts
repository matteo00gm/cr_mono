import { ConflictError, NotFoundError } from '@catalogorosso/core';
import type { BillingState } from '@catalogorosso/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { buildDependencies } from '../src/composition.js';
import { createDevBillingPort, type DevBillingPort } from '../src/dev-billing.js';
import { registeredRoutes } from '../src/middleware/capability.js';
import type { StripeDelivery } from '../src/stripe-events.js';
import { DevSurfaceInProductionError } from '../src/surfaces/dev.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * The non-production billing switch (P5-14): it records through the webhook
 * port, it answers only an owner of the session's own winery, and it does not
 * exist in production — asserted here, in CI, rather than by convention.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

const trialing: BillingState = {
  status: 'TRIALING',
  plan: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  locale: 'it',
};

describe('the port', () => {
  const portWith = (states: (BillingState | undefined)[], applied = true) => {
    const recorded: StripeDelivery[] = [];
    let read = 0;
    const port = createDevBillingPort({
      stripeEvents: {
        record: (delivery) => {
          recorded.push(delivery);
          return Promise.resolve({ duplicate: false, applied });
        },
      },
      readState: () => Promise.resolve(states[Math.min(read++, states.length - 1)]),
      now: () => 1_790_000_000,
    });

    return { port, recorded };
  };

  it('records a Stripe-shaped event through the webhook port, and reports where it landed', async () => {
    const { port, recorded } = portWith([
      trialing,
      { ...trialing, status: 'ACTIVE', plan: 'ECOMMERCE', stripeSubscriptionId: 'sub_x' },
    ]);

    expect(await port.apply(TENANT, 'activate', 'ECOMMERCE')).toEqual({
      applied: true,
      status: 'ACTIVE',
      plan: 'ECOMMERCE',
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.type).toBe('checkout.session.completed');
    expect(recorded[0]?.eventId).toMatch(/^evt_dev_/u);
  });

  it('says so when the machine applied nothing', async () => {
    const { port } = portWith([trialing, trialing], false);

    expect(await port.apply(TENANT, 'activate')).toMatchObject({ applied: false });
  });

  it('refuses a transition the winery cannot take, as a 409 naming what is missing', async () => {
    const { port, recorded } = portWith([trialing]);

    await expect(port.apply(TENANT, 'fail_payment')).rejects.toThrow(ConflictError);
    expect(recorded).toEqual([]);
  });

  it('is a 404 for a winery that is gone', async () => {
    const { port } = portWith([undefined]);

    await expect(port.apply(TENANT, 'activate')).rejects.toThrow(NotFoundError);
  });
});

describe('the route', () => {
  const recording = () => {
    const asked: string[] = [];
    const dev: DevBillingPort = {
      apply: (tenantId, transition, plan) => {
        asked.push(`${tenantId}:${transition}:${plan ?? '-'}`);
        return Promise.resolve({ applied: true, status: 'ACTIVE', plan: 'CANTINA' });
      },
    };

    return { asked, dev };
  };

  const post = (dev: DevBillingPort, role: 'OWNER' | 'EDITOR', body: unknown) =>
    createApp({ auth: signedIn(), readMemberships: oneMembership(TENANT, role), dev }).request(
      '/v1/dev/billing-state',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

  it('moves the session’s own winery for an owner', async () => {
    const { asked, dev } = recording();
    const response = await post(dev, 'OWNER', { transition: 'activate', plan: 'CANTINA' });

    expect(response.status).toBe(200);
    expect(asked).toEqual([`${TENANT}:activate:CANTINA`]);
  });

  it('refuses an editor', async () => {
    const { asked, dev } = recording();

    expect((await post(dev, 'EDITOR', { transition: 'activate' })).status).toBe(403);
    expect(asked).toEqual([]);
  });

  it.each([
    ['an unknown transition', { transition: 'make_free' }],
    ['a tenant id beside the transition (P0-48)', { transition: 'activate', tenantId: TENANT }],
    ['no body', undefined],
  ])('refuses %s, naming the transitions there are', async (_what, body) => {
    const { asked, dev } = recording();
    const response = await post(dev, 'OWNER', body);

    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain('activate, fail_payment');
    expect(asked).toEqual([]);
  });

  it('is not there at all without its port', async () => {
    const response = await createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, 'OWNER'),
    }).request('/v1/dev/billing-state', { method: 'POST', body: '{}' });

    expect(response.status).toBe(404);
  });
});

describe('production', () => {
  /* The composition root builds a pool lazily; it needs an address, never a connection. */
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://app_rw:pw@localhost:5432/sommelier');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const config = {
    authSecret: 'a'.repeat(32),
    authBaseUrl: 'https://app.example',
    emailFrom: 'Sommelier <noreply@sommelier.example>',
    suppression: () => ({ isSuppressed: () => Promise.resolve(false) }),
  };

  it('has no /v1/dev route in the app it builds', () => {
    const app = createApp(buildDependencies({ ...config, stage: 'production' }));

    expect(registeredRoutes(app).filter((route) => route.path.startsWith('/v1/dev'))).toEqual([]);
  });

  it('refuses to start when handed the dev port anyway', () => {
    const { dev } = {
      dev: createDevBillingPort({ stripeEvents: { record: () => Promise.reject(new Error('x')) } }),
    };

    expect(() =>
      createApp({
        auth: signedIn(),
        readMemberships: oneMembership(TENANT, 'OWNER'),
        dev,
        production: true,
      }),
    ).toThrow(DevSurfaceInProductionError);
  });

  it('mounts it on every other stage, the composition root deciding', () => {
    const app = createApp(buildDependencies({ ...config, stage: 'dev' }));

    expect(registeredRoutes(app).map((route) => `${route.method} ${route.path}`)).toContain(
      'POST /v1/dev/billing-state',
    );
  });
});
