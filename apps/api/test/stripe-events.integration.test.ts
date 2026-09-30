import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { logger } from '../src/middleware/logger.js';
import { createStripeEventsPort, type StripeDelivery } from '../src/stripe-events.js';

/**
 * The Stripe events port against real Postgres (P5-04).
 *
 * The port with its default claim — `withTenantWebhookEvent` as `app_rw` — so
 * the row's two tests are what a delivery through the port actually does:
 * replaying an event is a no-op answered as a duplicate, and concurrent
 * duplicate deliveries apply once.
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

const winery = async () => {
  const tenantId = randomUUID();

  await admin().execute(sql`
    INSERT INTO tenants (id, name, slug, status) VALUES (${tenantId}, 'Cantina', ${`se-${tenantId}`}, 'TRIALING')
  `);

  return tenantId;
};

const nameOf = async (tenantId: string) => {
  const rows = await admin().execute(sql`SELECT name FROM tenants WHERE id = ${tenantId}`);

  return ([...rows][0] as { name: string } | undefined)?.name;
};

const claimed = async (eventId: string) => {
  const rows = await admin().execute(
    sql`SELECT 1 FROM processed_webhooks WHERE provider = 'stripe' AND event_id = ${eventId}`,
  );

  return [...rows].length;
};

const delivery = (
  tenantId: string | undefined,
  eventId = `evt_${randomUUID()}`,
): StripeDelivery => ({
  eventId,
  type: 'invoice.paid',
  payload: {
    id: eventId,
    type: 'invoice.paid',
    data: { object: { metadata: tenantId === undefined ? {} : { tenant_id: tenantId } } },
  },
});

let applied = 0;

/** Stands in for P5-05's state machine: one visible write, counted. */
const port = createStripeEventsPort({
  apply: async (tx) => {
    applied += 1;
    await tx.execute(sql`UPDATE tenants SET name = name || '+'`);

    return true;
  },
});

describe('a delivery through the port', () => {
  it('is applied once, and its replay is answered as a duplicate that changes nothing', async () => {
    const tenantId = await winery();
    const sent = delivery(tenantId);

    expect(await port.record(sent)).toEqual({ duplicate: false, applied: true });
    expect(await port.record(sent)).toEqual({ duplicate: true, applied: false });
    expect(await nameOf(tenantId)).toBe('Cantina+');
  });

  it('is applied once when ten copies arrive together', async () => {
    const tenantId = await winery();
    const sent = delivery(tenantId);
    applied = 0;

    const results = await Promise.all(Array.from({ length: 10 }, () => port.record(sent)));

    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(applied).toBe(1);
    expect(await nameOf(tenantId)).toBe('Cantina+');
  });

  it('is never claimed when it names nobody, so nothing is marked handled that was not', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const sent = delivery(undefined);

    expect(await port.record(sent)).toEqual({ duplicate: false, applied: false });
    expect(await claimed(sent.eventId)).toBe(0);
  });
});
