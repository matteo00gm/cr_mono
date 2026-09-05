import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `audit_log` against real Postgres (P0-31).
 *
 * The privilege assertions are the reason this file exists. Append-only is a
 * grant, and a grant is the kind of thing that reads correctly in a migration
 * and is wrong in the database.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';
/** invalid_text_representation — what a malformed inet raises. */
const INVALID_TEXT = '22P02';

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
  tenantId = await createTenant(db, 'audit');
});

const write = (action = 'domain.removed') =>
  db.execute(sql`
    insert into audit_log (tenant_id, actor_user_id, action, target, metadata, ip, user_agent)
    values (${tenantId}::uuid, 'user_2abc', ${action}, 'example.com',
            ${JSON.stringify({ reason: 'manual' })}::jsonb, '203.0.113.7', 'Mozilla/5.0')
    returning id
  `);

describe('audit_log', () => {
  it('records an action', async () => {
    expect([...(await write())]).toHaveLength(1);
  });

  it('records an action with no human behind it', async () => {
    const rows = await db.execute(sql`
      insert into audit_log (tenant_id, action) values (${tenantId}::uuid, 'subscription.downgraded')
      returning actor_user_id
    `);

    expect([...rows][0]?.actor_user_id).toBeNull();
  });

  it('cannot be updated by the application role', async () => {
    await write();

    const error = await db
      .execute(
        sql`update audit_log set action = 'nothing.happened' where tenant_id = ${tenantId}::uuid`,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot be deleted by the application role', async () => {
    // The whole point: a bug — or an attacker with the application's
    // credentials — must not be able to erase the record of what it did.
    await write();

    const error = await db
      .execute(sql`delete from audit_log where tenant_id = ${tenantId}::uuid`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses a malformed ip at write time', async () => {
    const error = await db
      .execute(
        sql`insert into audit_log (tenant_id, action, ip) values (${tenantId}::uuid, 'x', 'not-an-ip')`,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INVALID_TEXT);
  });

  it('round-trips metadata as structured json', async () => {
    await write();

    const rows = await db.execute(
      sql`select metadata from audit_log where tenant_id = ${tenantId}::uuid`,
    );

    expect([...rows][0]?.metadata).toEqual({ reason: 'manual' });
  });

  it('cannot be erased by deleting its tenant as app_rw', async () => {
    /*
     * This assertion used to say the opposite, and that was the P0-33a finding.
     *
     * The revoke above makes this table append-only for app_rw — and it was
     * defeated entirely by `DELETE FROM tenants`, because a referential cascade
     * is **not** permission-checked against the invoking role. One statement the
     * runtime role held erased the record of who deleted the tenant: the exact
     * thing the revoke exists to protect, removed by the role it constrains.
     *
     * P0-33a revoked DELETE on `tenants` from app_rw, so the cascade is now
     * unreachable from the application at all.
     */
    await write();

    const error = await db
      .execute(sql`delete from tenants where id = ${tenantId}::uuid`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);

    const rows = await db.execute(sql`select 1 from audit_log where tenant_id = ${tenantId}::uuid`);
    expect([...rows]).toHaveLength(1);
  });

  it('still cascades for a role that may delete a tenant', async () => {
    // The foreign key is unchanged; only who may trigger it is. GDPR erasure
    // (P7-08) runs as such a role, which is the deliberate path P0-33a chose.
    await adminDb.execute(sql`delete from tenants where id = ${tenantId}::uuid`);

    const rows = await adminDb.execute(
      sql`select 1 from audit_log where tenant_id = ${tenantId}::uuid`,
    );
    expect([...rows]).toHaveLength(0);
  });
});
