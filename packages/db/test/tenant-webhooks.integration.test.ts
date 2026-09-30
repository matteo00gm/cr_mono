import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { claimWebhookEvent, withTenantWebhookEvent } from '../src/webhooks.js';
import { InvalidTenantIdError, type DbTransaction } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The ledger inside a winery's scope, against real Postgres (P5-04, ADR 0029).
 *
 * What only a database can say: that the claim and a write to `tenants`
 * commit together under the tenant policy, that the write reaches the named
 * winery and no other, and that twenty simultaneous deliveries apply once. As
 * `app_rw`, so the append-only grant on `processed_webhooks` and every policy
 * are in force.
 */

let container: StartedPostgreSqlContainer | undefined;
let clients: DbClient[] = [];
let db: Database;
let adminDb: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  const runtime = createDbClient(started.roleUrl('app_rw'), { max: 4 });
  const admin = createDbClient(started.adminUrl, { max: 1 });

  clients = [runtime, admin];
  db = runtime.db;
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await container?.stop();
}, 60_000);

const winery = async (): Promise<string> => {
  const tenantId = randomUUID();

  await adminDb.execute(sql`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${tenantId}::uuid, 'Cantina', ${`tw-${tenantId}`}, 'TRIALING')
  `);

  return tenantId;
};

const nameOf = async (tenantId: string): Promise<string | undefined> => {
  const rows = await adminDb.execute(sql`SELECT name FROM tenants WHERE id = ${tenantId}::uuid`);

  return ([...rows][0] as { name: string } | undefined)?.name;
};

/** An effect standing in for P5-05's: it renames every tenant it can reach. */
const rename = (to: string) => async (tx: DbTransaction) => {
  const rows = await tx.execute(sql`UPDATE tenants SET name = ${to} RETURNING id`);

  return [...rows].length;
};

const stripe = (eventId = `evt_${randomUUID()}`) => ({ provider: 'stripe', eventId });

describe('withTenantWebhookEvent', () => {
  it('applies the effect under the named winery, which reaches its row and no other', async () => {
    const mine = await winery();
    const theirs = await winery();

    const run = await withTenantWebhookEvent(mine, stripe(), rename('Pagata'), db);

    expect(run).toEqual({ claimed: true, result: 1 });
    expect(await nameOf(mine)).toBe('Pagata');
    expect(await nameOf(theirs)).toBe('Cantina');
  });

  it('does not run the effect again for a redelivery', async () => {
    const tenantId = await winery();
    const event = stripe();
    let runs = 0;

    const apply = async (tx: DbTransaction) => {
      runs += 1;
      return rename('Once')(tx);
    };

    await withTenantWebhookEvent(tenantId, event, apply, db);
    const again = await withTenantWebhookEvent(tenantId, event, apply, db);

    expect(again).toEqual({ claimed: false });
    expect(runs).toBe(1);
  });

  it('leaves nothing claimed when the effect throws, so the redelivery applies', async () => {
    const tenantId = await winery();
    const event = stripe();

    await expect(
      withTenantWebhookEvent(
        tenantId,
        event,
        async (tx) => {
          await rename('Half')(tx);
          throw new Error('the database fell over mid-effect');
        },
        db,
      ),
    ).rejects.toThrow('mid-effect');

    expect(await nameOf(tenantId)).toBe('Cantina');

    const retried = await withTenantWebhookEvent(tenantId, event, rename('Whole'), db);

    expect(retried).toEqual({ claimed: true, result: 1 });
    expect(await nameOf(tenantId)).toBe('Whole');
  });

  it('applies exactly one of twenty simultaneous deliveries', async () => {
    const tenantId = await winery();
    const event = stripe();
    let runs = 0;

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        withTenantWebhookEvent(
          tenantId,
          event,
          async (tx) => {
            runs += 1;
            return rename('Raced')(tx);
          },
          db,
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.claimed)).toHaveLength(1);
    expect(runs).toBe(1);
  });

  it('claims an event for a winery that no longer exists, whose effect reaches nothing', async () => {
    const gone = randomUUID();
    const event = stripe();

    expect(await withTenantWebhookEvent(gone, event, rename('Ghost'), db)).toEqual({
      claimed: true,
      result: 0,
    });
    expect(await claimWebhookEvent(db, event)).toBe(false);
  });

  it('refuses a malformed winery before claiming anything', async () => {
    const event = stripe();

    await expect(withTenantWebhookEvent('not-a-uuid', event, rename('Never'), db)).rejects.toThrow(
      InvalidTenantIdError,
    );
    expect(await claimWebhookEvent(db, event)).toBe(true);
  });

  it('keeps one ledger with Resend: the same id from each provider is two events', async () => {
    const tenantId = await winery();
    const eventId = `evt_${randomUUID()}`;

    await claimWebhookEvent(db, { provider: 'resend', eventId });

    expect(
      await withTenantWebhookEvent(tenantId, { provider: 'stripe', eventId }, rename('Both'), db),
    ).toEqual({
      claimed: true,
      result: 1,
    });
  });
});
