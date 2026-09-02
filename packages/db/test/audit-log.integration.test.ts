import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
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
  const rows = await db.execute(sql`
    insert into tenants (name, slug)
    values ('Audit', ${`audit-${String(Date.now())}-${String(Math.random()).slice(2)}`})
    returning id
  `);
  tenantId = String([...rows][0]?.id);
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

  it('goes with its tenant', async () => {
    await write();
    await db.execute(sql`delete from tenants where id = ${tenantId}::uuid`);

    const rows = await db.execute(sql`select 1 from audit_log where tenant_id = ${tenantId}::uuid`);

    expect([...rows]).toHaveLength(0);
  });
});
