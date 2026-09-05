import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `usage_events` and `usage_daily` against real Postgres (P0-30).
 *
 * The append-only assertions are the point of this file. Append-only is a
 * property of the grant, and a grant is exactly the kind of thing that looks
 * right in a migration and is wrong in the database.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';
/** check_violation. */
const CHECK_VIOLATION = '23514';
/** unique_violation. */
const UNIQUE_VIOLATION = '23505';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let admin: DbClient | undefined;
let adminDb: Database;
let db: Database;
let tenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  // As app_rw: the grants under test are the ones the application actually has.
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  // The cascade below is a property of the foreign key, not of the runtime
  // role — and since P0-33a revoked DELETE on `tenants` from app_rw, only a
  // role that still holds it can exercise the cascade at all.
  admin = createDbClient(started.adminUrl, { max: 1 });
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await admin?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  tenantId = await createTenant(db, 'usage');
});

const insertEvent = (period = '202609', kind = 'CHAT_MESSAGE') =>
  db.execute(sql`
    insert into usage_events (tenant_id, period, kind, input_tokens, output_tokens, cost_micros)
    values (${tenantId}::uuid, ${period}, ${kind}, 420, 88, 1250)
    returning id
  `);

describe('usage_events', () => {
  it('records a metered action', async () => {
    const rows = await insertEvent();

    expect([...rows]).toHaveLength(1);
  });

  it('refuses a period that is not YYYYMM', async () => {
    // The quota lookup is an equality match on this column, so a row in any
    // other format is invisible to it — and invisible usage grants free usage.
    const error = await insertEvent('2026-09').catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('cannot be updated by the application role', async () => {
    // Append-only is the grant, not the intention. If this ever passes, the
    // code path that bills a tenant can also rewrite what it billed them.
    await insertEvent();

    const error = await db
      .execute(sql`update usage_events set cost_micros = 0 where tenant_id = ${tenantId}::uuid`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot be deleted by the application role', async () => {
    await insertEvent();

    const error = await db
      .execute(sql`delete from usage_events where tenant_id = ${tenantId}::uuid`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('still allows the reads quota enforcement depends on', async () => {
    await insertEvent();
    await insertEvent();

    const rows = await db.execute(sql`
      select sum(cost_micros)::bigint as total, count(*)::int as events
      from usage_events where tenant_id = ${tenantId}::uuid and period = '202609'
    `);
    const row = [...rows][0];

    expect(Number(row?.events)).toBe(2);
    expect(Number(row?.total)).toBe(2500);
  });

  it('cannot be erased by deleting its tenant as app_rw', async () => {
    /*
     * Inverted by P0-33a, and this is the ledger where it matters most.
     *
     * `usage_events` is what the tenant is billed from. The revoke above makes
     * it append-only for app_rw — and `DELETE FROM tenants` cascaded straight
     * through it, because a referential cascade is not permission-checked
     * against the invoking role. Cancelling a subscription must not destroy the
     * record of what was owed.
     */
    await insertEvent();

    const error = await db
      .execute(sql`delete from tenants where id = ${tenantId}::uuid`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);

    const kept = await db.execute(
      sql`select 1 from usage_events where tenant_id = ${tenantId}::uuid`,
    );
    expect([...kept]).toHaveLength(1);
  });

  it('still cascades for a role that may delete a tenant', async () => {
    // The foreign key is unchanged; only who may trigger it is. A deleted
    // tenant must not leave billing rows referencing something unlookupable —
    // that clean-up is now P7-08's, running as a role that holds DELETE.
    await insertEvent();
    await adminDb.execute(sql`delete from tenants where id = ${tenantId}::uuid`);

    // Read as admin, which bypasses RLS: this has to prove the rows are gone,
    // not merely invisible to a tenant context whose tenant no longer exists.
    const rows = await adminDb.execute(
      sql`select 1 from usage_events where tenant_id = ${tenantId}::uuid`,
    );

    expect([...rows]).toHaveLength(0);
  });
});

describe('usage_daily', () => {
  const insertDay = (day = '2026-09-01', messages = 3) =>
    db.execute(sql`
      insert into usage_daily (tenant_id, day, messages) values (${tenantId}::uuid, ${day}, ${messages})
    `);

  it('holds one row per tenant per day', async () => {
    await insertDay();
    const error = await insertDay().catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('keeps the UPDATE the rollup job needs, unlike the ledger', async () => {
    // The nightly job re-runs and must converge rather than fail. This is the
    // deliberate asymmetry with usage_events, so it is asserted rather than
    // assumed.
    await insertDay();
    await db.execute(sql`
      update usage_daily set messages = 9 where tenant_id = ${tenantId}::uuid and day = '2026-09-01'
    `);

    const rows = await db.execute(
      sql`select messages from usage_daily where tenant_id = ${tenantId}::uuid`,
    );

    expect(Number([...rows][0]?.messages)).toBe(9);
  });

  it('counts a day with no activity as zero, not null', async () => {
    await db.execute(
      sql`insert into usage_daily (tenant_id, day) values (${tenantId}::uuid, '2026-09-02')`,
    );

    const rows = await db.execute(
      sql`select messages, tokens_in, cost_micros from usage_daily where tenant_id = ${tenantId}::uuid`,
    );
    const row = [...rows][0];

    expect(Number(row?.messages)).toBe(0);
    expect(Number(row?.tokens_in)).toBe(0);
    expect(Number(row?.cost_micros)).toBe(0);
  });
});
