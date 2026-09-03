import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `security_events` against real Postgres (P0-32).
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';
/** invalid_text_representation — an unknown enum label. */
const INVALID_ENUM = '22P02';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let admin: DbClient | undefined;
let adminDb: Database;
let db: Database;
let tenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  // Unattributed rows are readable only by a role that bypasses RLS. app_admin
  // is NOLOGIN by design (P0-21), so the suite uses the container superuser to
  // stand in for the break-glass path.
  admin = createDbClient(started.adminUrl, { max: 1 });
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await admin?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  tenantId = await createTenant(db, 'sec');
});

describe('security_events', () => {
  it('records a rejection that has no resolvable tenant', async () => {
    /*
     * The row this table exists for. An invalid `pk_` matched no tenant, so
     * there is nothing to scope it to — and it is still the row most worth
     * having.
     *
     * Written **without RETURNING**, and that is a constraint P0-37 imposes
     * rather than a stylistic choice. Postgres applies the SELECT policy to a
     * RETURNING clause, so asking for the row back requires it to be visible
     * under `USING` — which for an unattributed row it deliberately is not.
     * The insert then fails with 42501 even though `WITH CHECK` permits it.
     * P2-16's writer must not use RETURNING for these.
     */
    await db.execute(sql`
      insert into security_events (type, origin, public_key, ip)
      values ('INVALID_KEY', 'https://attacker.example', 'pk_bogus', '203.0.113.9')
    `);

    // Invisible to the tenant-scoped role...
    const asTenant = await db.execute(
      sql`select 1 from security_events where public_key = 'pk_bogus'`,
    );

    expect([...asTenant]).toHaveLength(0);

    // ...and present for a role that bypasses RLS.
    const asAdmin = await adminDb.execute(
      sql`select tenant_id from security_events where public_key = 'pk_bogus'`,
    );

    expect([...asAdmin]).toHaveLength(1);
    expect([...asAdmin][0]?.tenant_id).toBeNull();
  });

  it('refuses to hand an unattributed row back through RETURNING', async () => {
    // Asserted so the constraint above is a tested fact rather than a comment
    // someone deletes.
    const error = await db
      .execute(
        sql`
        insert into security_events (type, public_key) values ('INVALID_KEY', 'pk_returning')
        returning id
      `,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('records a rejection that does resolve to a tenant', async () => {
    const rows = await db.execute(sql`
      insert into security_events (tenant_id, type, origin, public_key)
      values (${tenantId}::uuid, 'UNAUTHORIZED_ORIGIN', 'https://thief.example', 'pk_live_abc')
      returning id
    `);

    expect([...rows]).toHaveLength(1);
  });

  it('refuses a type outside the declared set', async () => {
    const error = await db
      .execute(sql`insert into security_events (type) values ('SOMETHING_NEW')`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INVALID_ENUM);
  });

  it('cannot be updated or deleted by the application role', async () => {
    // This table records attacks, and the credential most likely to be in an
    // attacker's hands is the application's own.
    await db.execute(sql`
      insert into security_events (tenant_id, type, public_key)
      values (${tenantId}::uuid, 'RATE_LIMITED', 'pk_live_abc')
    `);

    const updateError = await db
      .execute(
        sql`update security_events set type = 'INVALID_KEY' where tenant_id = ${tenantId}::uuid`,
      )
      .catch((caught: unknown) => caught);
    const deleteError = await db
      .execute(sql`delete from security_events where tenant_id = ${tenantId}::uuid`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(updateError)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(pgErrorCode(deleteError)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('counts presentations of one key from one origin', async () => {
    // The P2-16 question, asked the way P2-16 asks it.
    for (const origin of ['https://a.example', 'https://a.example', 'https://b.example']) {
      await db.execute(sql`
        insert into security_events (type, public_key, origin)
        values ('UNAUTHORIZED_ORIGIN', 'pk_live_counted', ${origin})
      `);
    }

    // Counted through the admin connection: these rows carry no tenant, so the
    // strict USING hides them from app_rw. That is a real consequence for
    // P2-16 — abuse counting across unattributed rejections cannot run as the
    // application role.
    const rows = await adminDb.execute(sql`
      select count(*)::int as hits from security_events
      where public_key = 'pk_live_counted' and origin = 'https://a.example'
    `);

    expect(Number([...rows][0]?.hits)).toBe(2);
  });

  it('goes with its tenant when it had one', async () => {
    await db.execute(sql`
      insert into security_events (tenant_id, type) values (${tenantId}::uuid, 'QUOTA_EXCEEDED')
    `);
    await db.execute(sql`delete from tenants where id = ${tenantId}::uuid`);

    const rows = await db.execute(
      sql`select 1 from security_events where tenant_id = ${tenantId}::uuid`,
    );

    expect([...rows]).toHaveLength(0);
  });
});
