import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  readBillingSnapshot,
  readBillingState,
  startTrial,
  writeBillingChange,
} from '../src/billing.js';
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

/**
 * A paying winery when given a subscription, and one waiting for its first
 * domain when not: ACTIVE without a subscription is what 0061's CHECK forbids.
 */
const winery = async (billing: { customer?: string; subscription?: string } = {}) => {
  const tenantId = randomUUID();
  const status = billing.subscription === undefined ? 'PENDING_VERIFICATION' : 'ACTIVE';

  await adminDb.execute(sql`
    INSERT INTO tenants (id, name, slug, status, plan, locale, stripe_customer_id, stripe_subscription_id)
    VALUES (
      ${tenantId}::uuid, 'Cantina', ${`billing-${tenantId}`}, ${status}::tenant_status, 'CANTINA', 'en',
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

describe('the status invariant (§5.2b, migration 0061)', () => {
  const insert = (status: string, extra: { subscription?: string; trialEndsAt?: boolean } = {}) =>
    adminDb.execute(sql`
      INSERT INTO tenants (id, name, slug, status, stripe_subscription_id, trial_ends_at)
      VALUES (
        gen_random_uuid(), 'Cantina', ${`inv-${randomUUID()}`}, ${status}::tenant_status,
        ${extra.subscription ?? null},
        ${extra.trialEndsAt === true ? sql`now() + interval '14 days'` : null}
      )
    `);

  it('refuses ACTIVE without a subscription, to every role — the owner included', async () => {
    await expect(insert('ACTIVE')).rejects.toMatchObject({
      cause: { constraint_name: 'tenant_status_coherent' },
    });
  });

  it('refuses TRIALING without an end to the trial', async () => {
    await expect(insert('TRIALING')).rejects.toMatchObject({
      cause: { constraint_name: 'tenant_status_coherent' },
    });
  });

  it('admits each served status with what it needs', async () => {
    await expect(insert('ACTIVE', { subscription: `sub_${randomUUID()}` })).resolves.toBeDefined();
    await expect(insert('TRIALING', { trialEndsAt: true })).resolves.toBeDefined();
  });

  it('asks nothing of the statuses that are not served', async () => {
    for (const status of ['PENDING_VERIFICATION', 'PAST_DUE', 'DISABLED', 'CANCELED']) {
      await expect(insert(status)).resolves.toBeDefined();
    }
  });
});

describe('starting the trial', () => {
  const pending = async () => {
    const tenantId = randomUUID();

    await adminDb.execute(sql`
      INSERT INTO tenants (id, name, slug) VALUES (${tenantId}::uuid, 'Cantina', ${`trial-${tenantId}`})
    `);

    return tenantId;
  };

  it('moves a winery waiting for its first domain into a trial of the days given', async () => {
    const tenantId = await pending();
    const before = Date.now();

    const endsAt = await withTenant(tenantId, (tx) => startTrial(tx, 14), db);

    expect(endsAt).toBeInstanceOf(Date);
    expect((endsAt?.getTime() ?? 0) - before).toBeGreaterThan(13.9 * 86_400_000);
    expect((endsAt?.getTime() ?? 0) - before).toBeLessThan(14.1 * 86_400_000);
    expect((await withTenant(tenantId, readBillingState, db))?.status).toBe('TRIALING');
  });

  it('gives no second trial, however many domains follow', async () => {
    const tenantId = await pending();

    await withTenant(tenantId, (tx) => startTrial(tx, 14), db);

    expect(await withTenant(tenantId, (tx) => startTrial(tx, 14), db)).toBeUndefined();
  });

  it('never moves a winery that has paid', async () => {
    const tenantId = await winery({
      customer: `cus_${randomUUID()}`,
      subscription: `sub_${randomUUID()}`,
    });

    expect(await withTenant(tenantId, (tx) => startTrial(tx, 14), db)).toBeUndefined();
    expect((await withTenant(tenantId, readBillingState, db))?.status).toBe('ACTIVE');
  });

  it('starts nothing outside a scope', async () => {
    await pending();

    expect(await db.transaction((tx) => startTrial(tx, 14))).toBeUndefined();
  });
});

describe('writing the machine’s answer', () => {
  it('writes every field in one statement, and the snapshot reads it back', async () => {
    const tenantId = await winery();
    const at = new Date('2026-09-30T12:00:20.000Z');

    const written = await withTenant(
      tenantId,
      (tx) =>
        writeBillingChange(tx, {
          status: 'PAST_DUE',
          plan: 'ECOMMERCE',
          customerId: `cus_${tenantId}`,
          subscriptionId: `sub_${tenantId}`,
          lastEventAt: at,
        }),
      db,
    );

    expect(written).toBe('written');
    expect(await withTenant(tenantId, readBillingSnapshot, db)).toEqual({
      status: 'PAST_DUE',
      plan: 'ECOMMERCE',
      customerId: `cus_${tenantId}`,
      subscriptionId: `sub_${tenantId}`,
      lastEventAt: at,
    });
  });

  it('reports a customer already bound to another winery, and keeps the caller’s transaction', async () => {
    const taken = `cus_${randomUUID()}`;
    await winery({ customer: taken, subscription: `sub_${randomUUID()}` });
    const mine = await winery();

    const outcome = await withTenant(
      mine,
      async (tx) => {
        const result = await writeBillingChange(tx, {
          status: 'ACTIVE',
          plan: 'CANTINA',
          customerId: taken,
          subscriptionId: `sub_${randomUUID()}`,
          lastEventAt: new Date(),
        });

        /* The savepoint rolled back only itself: this statement still runs. */
        const after = await readBillingState(tx);

        return { result, customer: after?.stripeCustomerId };
      },
      db,
    );

    expect(outcome).toEqual({ result: 'customer_taken', customer: null });
  });

  it('is refused by the invariant rather than written, for ACTIVE with no subscription', async () => {
    const tenantId = await winery();

    await expect(
      withTenant(
        tenantId,
        (tx) =>
          writeBillingChange(tx, {
            status: 'ACTIVE',
            plan: 'CANTINA',
            customerId: null,
            subscriptionId: null,
            lastEventAt: new Date(),
          }),
        db,
      ),
    ).rejects.toMatchObject({ cause: { constraint_name: 'tenant_status_coherent' } });
  });

  it('reaches only the scope’s own winery', async () => {
    const theirs = await winery({ customer: 'cus_untouched', subscription: `sub_${randomUUID()}` });
    const mine = await winery();

    await withTenant(
      mine,
      (tx) =>
        writeBillingChange(tx, {
          status: 'DISABLED',
          plan: null,
          customerId: null,
          subscriptionId: null,
          lastEventAt: new Date(),
        }),
      db,
    );

    expect((await withTenant(theirs, readBillingState, db))?.status).toBe('ACTIVE');
  });
});
