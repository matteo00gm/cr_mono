import process from 'node:process';
import { randomUUID } from 'node:crypto';

import { runWithRequestContext } from '@catalogorosso/core';
import { insertSecurityEvent, resolveTenantByKeyAndOrigin } from '@catalogorosso/db';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAnalyticsPort } from '../src/analytics.js';
import { createDomainsPort } from '../src/domains.js';
import type { AppEnv } from '../src/env.js';
import { widgetCors } from '../src/middleware/cors.js';
import { errorHandler } from '../src/middleware/error.js';
import { requestContext } from '../src/middleware/logger.js';
import { refusalRecorders } from '../src/security-events.js';

/**
 * The refused-sites panel, end to end (P6-05).
 *
 * A key used from a site its winery has not verified is refused and recorded
 * by the real CORS guard; the panel reads the refusal; the one-click add is
 * the ordinary domains port — and the assertion this file exists for is that
 * it **does not make the site trusted**: the origin lands `PENDING`, with a
 * record to publish, and the widget goes on refusing it until that is done.
 */

let harness: TestDatabase | undefined;
let tenantId: string;
let key: string;

const NEW_SHOP = 'https://nuovo.cantina-bianchi.example';

/* One secret for every visit, as one deployment has: the same visitor is one bucket. */
const IP_SECRET = randomUUID();

const widget = () => {
  const app = new Hono<AppEnv>();

  app.use('*', requestContext());
  app.onError(errorHandler);
  app.get(
    '/config',
    widgetCors({
      resolve: (presented, origin) => resolveTenantByKeyAndOrigin(presented, origin),
      onRejected: refusalRecorders((event) => insertSecurityEvent(event)).onRejected,
      ipSecret: IP_SECRET,
    }),
    (c) => c.json({ ok: true }),
  );

  return app;
};

/*
 * The guard records a refusal without making the visitor wait for it
 * (`onRejected(event).catch(…)`), so a read polls until the write has landed.
 */
const panelShows = async (expected: unknown): Promise<void> => {
  await vi.waitFor(
    async () => {
      expect((await createAnalyticsPort().refusedOrigins(tenantId, {})).origins).toEqual(expected);
    },
    { timeout: 5_000 },
  );
};

const visit = (origin: string) =>
  widget().request(`/config?key=${encodeURIComponent(key)}`, {
    headers: { origin, 'x-forwarded-for': '203.0.113.7' },
  });

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');

  tenantId = randomUUID();
  key = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

  await harness.adminDb.execute(sql`
    insert into tenants (id, name, slug, status, plan, locale, stripe_subscription_id)
    values (${tenantId}::uuid, 'Bianchi', 'cantina-bianchi', 'ACTIVE', 'CANTINA', 'it',
            'sub_' || gen_random_uuid())
  `);
  await harness.adminDb.execute(sql`
    insert into widget_keys (tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4)
    values (${tenantId}::uuid, ${key}, md5(random()::text), 'sk_test_', 'abcd')
  `);
  await harness.adminDb.execute(sql`
    insert into tenant_domains (tenant_id, origin, registrable_domain, status)
    values (${tenantId}::uuid, 'https://cantina-bianchi.example', 'cantina-bianchi.example', 'VERIFIED')
  `);
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('a site the winery has not verified', () => {
  it('is refused, recorded, and shown to the winery as not one of its domains', async () => {
    expect((await visit(NEW_SHOP)).status).toBe(403);
    expect((await visit(NEW_SHOP)).status).toBe(403);

    await panelShows([
      expect.objectContaining({ origin: NEW_SHOP, attempts: 2, sources: 1, domain: null }),
    ]);
  });

  it('added from the panel, is PENDING with a record to publish — not trusted', async () => {
    /* As the route runs it: inside a request whose tenant is the member's (P0-53's audit needs it). */
    const { domain } = await runWithRequestContext({ requestId: randomUUID(), tenantId }, () =>
      createDomainsPort().add({ tenantId, input: NEW_SHOP, kind: 'production' }),
    );

    expect(domain.status).toBe('PENDING');
    expect(domain.verificationToken).not.toBeNull();
  });

  it('is still refused by the widget until it is verified', async () => {
    expect((await visit(NEW_SHOP)).status).toBe(403);
  });

  it('and the panel says so: added, waiting for verification', async () => {
    await panelShows([
      expect.objectContaining({ origin: NEW_SHOP, attempts: 3, domain: 'PENDING' }),
    ]);
  });
});
