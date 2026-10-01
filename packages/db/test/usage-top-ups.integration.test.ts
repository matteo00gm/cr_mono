import { randomUUID } from 'node:crypto';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { countPurchased, recordTopUp } from '../src/usage.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';

/**
 * Messages bought on top of a plan, against real Postgres (P5-11a).
 *
 * Two properties worth a container. **One payment is one credit**: the unique
 * payment intent is what stops a second event about the same money from
 * crediting it again, and uniqueness is the database's. **A ledger stays a
 * ledger**: append-only is a grant, and a grant is exactly what looks right in
 * a migration and is wrong in the database.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';
/** check_violation. */
const CHECK_VIOLATION = '23514';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  // As app_rw: the grants under test are the ones the application actually has.
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  tenantId = await createTenant(db, 'top-ups');
});

const credit = (tenant: string, period: string, paymentIntentId = `pi_${randomUUID()}`) =>
  withTenant(tenant, (tx) => recordTopUp(tx, { period, messages: 1_000, paymentIntentId }), db);

const purchased = (tenant: string, period: string) =>
  withTenant(tenant, (tx) => countPurchased(tx, period), db);

describe('crediting a top-up', () => {
  it('credits a payment, and the month it counts towards reads it', async () => {
    expect(await credit(tenantId, '202610')).toBe('credited');
    expect(await purchased(tenantId, '202610')).toBe(1_000);
  });

  it('credits one payment once, however many events say it was paid', async () => {
    const payment = `pi_${randomUUID()}`;

    expect(await credit(tenantId, '202610', payment)).toBe('credited');
    expect(await credit(tenantId, '202610', payment)).toBe('duplicate');
    expect(await purchased(tenantId, '202610')).toBe(1_000);
  });

  it('adds every payment in a month together', async () => {
    await credit(tenantId, '202610');
    await credit(tenantId, '202610');

    expect(await purchased(tenantId, '202610')).toBe(2_000);
  });

  it('counts only the month asked for: last month’s messages do not carry over', async () => {
    await credit(tenantId, '202609');

    expect(await purchased(tenantId, '202610')).toBe(0);
  });

  it('counts only the scope’s own winery', async () => {
    const other = await createTenant(db, 'top-ups-other');

    await credit(other, '202610');

    expect(await purchased(tenantId, '202610')).toBe(0);
  });

  it('refuses a period that is not YYYYMM, which the quota read would never find', async () => {
    await expect(credit(tenantId, '2026-10')).rejects.toSatisfy(
      (error) => pgErrorCode(error) === CHECK_VIOLATION,
    );
  });

  it('refuses a credit of nothing', async () => {
    await expect(
      withTenant(
        tenantId,
        (tx) =>
          recordTopUp(tx, { period: '202610', messages: 0, paymentIntentId: `pi_${randomUUID()}` }),
        db,
      ),
    ).rejects.toSatisfy((error) => pgErrorCode(error) === CHECK_VIOLATION);
  });
});

describe('the ledger', () => {
  it('cannot be rewritten by the application role', async () => {
    await credit(tenantId, '202610');

    await expect(
      withTenant(
        tenantId,
        (tx) => tx.execute(sql`update usage_top_ups set messages_purchased = 1000000`),
        db,
      ),
    ).rejects.toSatisfy((error) => pgErrorCode(error) === INSUFFICIENT_PRIVILEGE);
  });

  it('cannot be erased by the application role', async () => {
    await credit(tenantId, '202610');

    await expect(
      withTenant(tenantId, (tx) => tx.execute(sql`delete from usage_top_ups`), db),
    ).rejects.toSatisfy((error) => pgErrorCode(error) === INSUFFICIENT_PRIVILEGE);
  });
});
