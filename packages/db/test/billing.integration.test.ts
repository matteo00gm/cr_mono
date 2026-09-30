import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readBillingState } from '../src/billing.js';
import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * A winery's billing state, as `app_rw` reads it under RLS (P5-02).
 *
 * The property worth a container: the read is the scope's and nobody else's.
 * A Stripe customer id is the handle a Checkout session is opened against, so
 * reading another winery's would bill the wrong one.
 */

let container: StartedPostgreSqlContainer | undefined;
let clients: DbClient[] = [];
let db: Database;
let adminDb: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  const runtime = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  const admin = createDbClient(started.adminUrl, { max: 1 });

  clients = [runtime, admin];
  db = runtime.db;
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await container?.stop();
}, 60_000);

const winery = async (billing: { customer?: string; subscription?: string } = {}) => {
  const tenantId = randomUUID();

  await adminDb.execute(sql`
    INSERT INTO tenants (id, name, slug, status, plan, locale, stripe_customer_id, stripe_subscription_id)
    VALUES (
      ${tenantId}::uuid, 'Cantina', ${`billing-${tenantId}`}, 'ACTIVE', 'CANTINA', 'en',
      ${billing.customer ?? null}, ${billing.subscription ?? null}
    )
  `);

  return tenantId;
};

describe('reading billing state', () => {
  it('reads the scope’s own winery', async () => {
    const tenantId = await winery({ customer: 'cus_mine', subscription: 'sub_mine' });

    expect(await withTenant(tenantId, readBillingState, db)).toEqual({
      status: 'ACTIVE',
      plan: 'CANTINA',
      stripeCustomerId: 'cus_mine',
      stripeSubscriptionId: 'sub_mine',
      locale: 'en',
    });
  });

  it('reads nulls for a winery that has never bought anything', async () => {
    const tenantId = await winery();

    expect(await withTenant(tenantId, readBillingState, db)).toMatchObject({
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
  });

  it('never reads another winery’s customer', async () => {
    await winery({ customer: 'cus_theirs', subscription: 'sub_theirs' });
    const mine = await winery();

    const state = await withTenant(mine, readBillingState, db);

    expect(state?.stripeCustomerId).toBeNull();
  });

  it('reads nothing outside a scope', async () => {
    await winery({ customer: 'cus_someone' });

    expect(await db.transaction((tx) => readBillingState(tx))).toBeUndefined();
  });
});
