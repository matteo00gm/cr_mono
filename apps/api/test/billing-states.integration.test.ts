import process from 'node:process';

import { isServed, type TenantStatus } from '@catalogorosso/core';
import {
  seedStates,
  startTestDatabase,
  type SeededState,
  type TestDatabase,
} from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createBillingEffect } from '../src/billing-events.js';
import { createDevBillingPort } from '../src/dev-billing.js';
import { logger } from '../src/middleware/logger.js';
import { createStripeEventsPort } from '../src/stripe-events.js';

/**
 * One winery in every billing state, by the webhook path (P5-14): the fixtures
 * the local stack and P3-22's browser matrix stand on, asserted where they land
 * — and that each paid state got there through a claimed Stripe event rather
 * than a status somebody wrote.
 */

let harness: TestDatabase | undefined;
let seeded: readonly SeededState[] = [];

const admin = () => {
  if (harness === undefined) throw new Error('no database');
  return harness.adminDb;
};

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);

  const dev = createDevBillingPort({
    stripeEvents: createStripeEventsPort({ apply: createBillingEffect({ livemode: false }) }),
  });

  seeded = await seedStates({ transition: (tenantId, step) => dev.apply(tenantId, step) });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

const row = async (tenantId: string) => {
  const rows = await admin().execute(sql`
    SELECT status, trial_ends_at, stripe_subscription_id AS subscription FROM tenants WHERE id = ${tenantId}
  `);

  return [...rows][0] as {
    status: string;
    trial_ends_at: Date | string | null;
    subscription: string | null;
  };
};

const claims = async (tenantId: string) => {
  const rows = await admin().execute(sql`
    SELECT count(*)::int AS claimed FROM audit_log
    WHERE tenant_id = ${tenantId} AND action = 'billing.status_changed'
  `);

  return ([...rows][0] as { claimed: number }).claimed;
};

const by = (slug: string): SeededState => {
  const state = seeded.find((candidate) => candidate.slug === slug);
  if (state === undefined) throw new Error(`no fixture ${slug}`);
  return state;
};

describe('every state', () => {
  it('is seeded once, each on its own storefront origin', () => {
    expect(seeded.map((state) => state.slug)).toEqual([
      'trialing-fresh',
      'trialing-capped',
      'trialing-expired',
      'active-healthy',
      'active-capped',
      'past-due',
      'subscription-ended',
      'pending-verification',
    ]);
    expect(new Set(seeded.map((state) => state.origin)).size).toBe(8);
  });

  it.each([
    'trialing-fresh',
    'trialing-capped',
    'trialing-expired',
    'active-healthy',
    'active-capped',
    'past-due',
    'subscription-ended',
    'pending-verification',
  ])('%s lands in the status its recipe names', async (slug) => {
    const state = by(slug);

    expect((await row(state.tenantId)).status).toBe(state.status);
  });
});

describe('the webhook path', () => {
  it.each([
    ['active-healthy', 1],
    ['past-due', 2],
    ['subscription-ended', 2],
  ])('%s got there through %i claimed, audited Stripe events', async (slug, events) => {
    expect(await claims(by(slug).tenantId)).toBe(events);
  });

  it('ends a subscription by clearing it, so the winery could buy again', async () => {
    expect((await row(by('subscription-ended').tenantId)).subscription).toBeNull();
  });
});

describe('what the gate makes of them', () => {
  const served = async (slug: string) => {
    const { status, trial_ends_at: ends } = await row(by(slug).tenantId);

    return isServed({
      status: status as TenantStatus,
      trialEndsAt: ends === null ? null : new Date(ends),
    });
  };

  it('serves a running trial and a paying winery', async () => {
    expect(await served('trialing-fresh')).toBe(true);
    expect(await served('active-healthy')).toBe(true);
  });

  it('serves no expired trial, no failed payment and no ended subscription', async () => {
    expect(await served('trialing-expired')).toBe(false);
    expect(await served('past-due')).toBe(false);
    expect(await served('subscription-ended')).toBe(false);
  });
});
