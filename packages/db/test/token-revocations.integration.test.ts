import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `token_revocations` against real Postgres (P0-35).
 *
 * Revocation behaviour belongs to P2-15, which tests it through the verify
 * middleware. What is asserted here is what the schema itself guarantees.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** unique_violation. */
const UNIQUE_VIOLATION = '23505';
/** not_null_violation. */
const NOT_NULL_VIOLATION = '23502';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  tenantId = await createTenant(db, 'tok');
});

const revoke = (jti: string, expiresAt = '2026-12-31T00:00:00Z') =>
  db.execute(sql`
    insert into token_revocations (jti, tenant_id, expires_at)
    values (${jti}, ${tenantId}::uuid, ${expiresAt}::timestamptz)
  `);

describe('token_revocations', () => {
  it('revokes a token', async () => {
    await revoke('jti-one');

    const rows = await db.execute(sql`select 1 from token_revocations where jti = 'jti-one'`);

    expect([...rows]).toHaveLength(1);
  });

  it('treats revoking twice as already revoked, not as a new fact', async () => {
    // P4-06 removes a domain and revokes every token issued to it. Doing that
    // twice — a retry, or two admins at once — must not be an error the caller
    // has to distinguish from a real failure.
    await revoke('jti-dup');
    const error = await revoke('jti-dup').catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a revocation with no expiry', async () => {
    // A row with no expiry could never be swept, so the list would grow
    // without bound and the sweep's cheapness argument would quietly fail.
    const error = await db
      .execute(
        sql`insert into token_revocations (jti, tenant_id) values ('jti-noexp', ${tenantId}::uuid)`,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(NOT_NULL_VIOLATION);
  });

  it('lets the sweep delete rows past expiry', async () => {
    // Deliberately deletable, unlike the P0-30 to P0-32 ledgers: an expired
    // token cannot be replayed whether or not it is listed here.
    await revoke('jti-expired', '2020-01-01T00:00:00Z');
    await db.execute(sql`delete from token_revocations where expires_at < now()`);

    const rows = await db.execute(sql`select 1 from token_revocations where jti = 'jti-expired'`);

    expect([...rows]).toHaveLength(0);
  });

  it('goes with its tenant', async () => {
    await revoke('jti-tenant');
    await db.execute(sql`delete from tenants where id = ${tenantId}::uuid`);

    const rows = await db.execute(sql`select 1 from token_revocations where jti = 'jti-tenant'`);

    expect([...rows]).toHaveLength(0);
  });
});
