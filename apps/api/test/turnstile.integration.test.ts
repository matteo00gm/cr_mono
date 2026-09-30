import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { runWithRequestContext } from '@catalogorosso/core';
import { resolveTenantByKeyAndOrigin } from '@catalogorosso/db';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTurnstileSettingsPort } from '../src/turnstile-settings.js';

/**
 * The Turnstile flag against real Postgres (P4-14).
 *
 * The port under `withTenant`, as the dashboard route calls it, and the flag as
 * widget resolution reads it — the two ends of the switch, with the database in
 * between.
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

/** A winery with a verified origin and a key, as a widget would find it. */
const winery = async () => {
  const tenantId = randomUUID();
  const key = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');
  /* Unique per winery: one origin belongs to one tenant at most. */
  const origin = `https://www.w${tenantId.slice(0, 8)}.example`;

  await admin().execute(sql`
    INSERT INTO tenants (id, name, slug, status, stripe_subscription_id) VALUES (${tenantId}, 'Cantina', ${`c-${tenantId}`}, 'ACTIVE', 'sub_' || gen_random_uuid())
  `);
  await admin().execute(sql`
    INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status, verified_at)
    VALUES (${tenantId}, ${origin}, ${`w${tenantId.slice(0, 8)}.example`}, 'VERIFIED', now())
  `);
  await admin().execute(sql`
    INSERT INTO widget_keys (tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4)
    VALUES (${tenantId}, ${key}, md5(random()::text), 'sk_test_', 'abcd')
  `);

  return { tenantId, key, origin };
};

const event = (tenantId: string, type: string, age = '1 minute') =>
  admin().execute(sql`
    INSERT INTO security_events (tenant_id, type, origin, created_at)
    VALUES (${tenantId}, ${type}::security_event_type, 'https://evil.example', now() - ${age}::interval)
  `);

const settings = createTurnstileSettingsPort({ available: true });

/**
 * The port as a request calls it: inside a request context carrying the
 * tenant, which is where `audit()` reads it from (P0-53).
 */
const port = {
  read: settings.read,
  set: (tenantId: string, enabled: boolean) =>
    runWithRequestContext({ requestId: randomUUID(), tenantId }, () =>
      settings.set(tenantId, enabled),
    ),
};

describe('the flag', () => {
  it('is off for a new winery, and widget resolution says so', async () => {
    const { tenantId, key, origin } = await winery();

    expect((await port.read(tenantId)).enabled).toBe(false);
    expect(await resolveTenantByKeyAndOrigin(key, origin)).toMatchObject({
      found: true,
      turnstile: false,
    });
  });

  it('turned on by the owner is what the next widget request resolves', async () => {
    const { tenantId, key, origin } = await winery();

    const answer = await port.set(tenantId, true);

    expect(answer.enabled).toBe(true);
    expect(await resolveTenantByKeyAndOrigin(key, origin)).toMatchObject({ turnstile: true });
  });

  it('is audited on the change’s own transaction', async () => {
    const { tenantId } = await winery();

    await port.set(tenantId, true);
    await port.set(tenantId, false);

    const rows = [
      ...(await admin().execute(sql`
        SELECT action FROM audit_log WHERE tenant_id = ${tenantId} ORDER BY created_at
      `)),
    ];

    expect(rows).toEqual([
      { action: 'widget.turnstile_enabled' },
      { action: 'widget.turnstile_disabled' },
    ]);
  });

  it('changes nothing of another winery', async () => {
    const first = await winery();
    const second = await winery();

    await port.set(first.tenantId, true);

    expect((await port.read(second.tenantId)).enabled).toBe(false);
  });
});

describe('the suggestion', () => {
  it('counts the last hour of this winery’s own refusals', async () => {
    const { tenantId } = await winery();
    const other = await winery();

    for (let i = 0; i < 3; i += 1) await event(tenantId, 'UNAUTHORIZED_ORIGIN');
    await event(tenantId, 'RATE_LIMITED');
    await event(tenantId, 'UNAUTHORIZED_ORIGIN', '2 hours');
    await event(tenantId, 'INVALID_KEY');
    await event(other.tenantId, 'UNAUTHORIZED_ORIGIN');

    expect((await port.read(tenantId)).signals).toEqual({ unauthorizedOrigins: 3, rateLimited: 1 });
  });

  it('is made when they cross the line, and not before', async () => {
    const { tenantId } = await winery();

    for (let i = 0; i < 49; i += 1) await event(tenantId, 'UNAUTHORIZED_ORIGIN');
    expect((await port.read(tenantId)).suggested).toBe(false);

    await event(tenantId, 'UNAUTHORIZED_ORIGIN');
    expect((await port.read(tenantId)).suggested).toBe(true);
  });

  it('is not made where Turnstile is not set up, since it could not be turned on', async () => {
    const { tenantId } = await winery();
    for (let i = 0; i < 60; i += 1) await event(tenantId, 'UNAUTHORIZED_ORIGIN');

    expect(await createTurnstileSettingsPort({ available: false }).read(tenantId)).toMatchObject({
      suggested: false,
      available: false,
    });
  });
});
