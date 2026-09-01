import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `memberships` against real Postgres (P0-23).
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

const UNIQUE_VIOLATION = '23505';
const INVALID_ENUM = '22P02';
const FOREIGN_KEY_VIOLATION = '23503';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

const createTenant = async (slug: string): Promise<string> => {
  const rows = await db.execute(
    sql`insert into tenants (name, slug) values (${slug}, ${slug}) returning id`,
  );
  return String([...rows][0]?.id);
};

const addMember = (tenantId: string, userId: string, role = 'EDITOR') =>
  db.execute(sql`
    insert into memberships (tenant_id, user_id, role)
    values (${tenantId}::uuid, ${userId}, ${role}::membership_role)
    returning id
  `);

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

describe('memberships', () => {
  it('accepts a Better Auth style user id', async () => {
    // Not a UUID, on purpose: this is the shape Better Auth actually generates.
    const tenantId = await createTenant('better-auth-ids');

    await expect(addMember(tenantId, 'yZ3kQ1pR8sT0uV5wX7nA2bC4dE6fG9hJ')).resolves.toBeDefined();
  });

  it('rejects a second membership for the same user in the same tenant', async () => {
    // Promotion has to be an UPDATE of the role column. A second row would make
    // "what role does this user have here" ambiguous, and every check downstream
    // would have to pick a tie-break rule.
    const tenantId = await createTenant('one-row-each');
    await addMember(tenantId, 'user-duplicate', 'EDITOR');

    const error = await addMember(tenantId, 'user-duplicate', 'OWNER').catch(
      (caught: unknown) => caught,
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('allows the same user in different tenants', async () => {
    // The uniqueness is per tenant, not global — an agency managing two
    // wineries is an ordinary case, not an error.
    const first = await createTenant('agency-one');
    const second = await createTenant('agency-two');
    await addMember(first, 'shared-user', 'OWNER');

    await expect(addMember(second, 'shared-user', 'EDITOR')).resolves.toBeDefined();
  });

  it('rejects a role outside the launch set', async () => {
    // ADMIN is planned, and precisely because it is planned the database has to
    // refuse it until the migration that adds it — otherwise a capability check
    // written against a role the enum does not know silently never matches.
    const tenantId = await createTenant('role-guard');

    const error = await addMember(tenantId, 'user-admin', 'ADMIN').catch(
      (caught: unknown) => caught,
    );

    expect(pgErrorCode(error)).toBe(INVALID_ENUM);
  });

  it('refuses a membership for a tenant that does not exist', async () => {
    const error = await addMember('00000000-0000-4000-8000-000000000000', 'ghost').catch(
      (caught: unknown) => caught,
    );

    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('deletes memberships when the tenant is deleted', async () => {
    // An orphaned membership is a row that grants access to a tenant that is
    // gone — and, with ids reused by nothing, a row nobody will ever notice.
    const tenantId = await createTenant('cascade-me');
    await addMember(tenantId, 'user-cascade');

    await db.execute(sql`delete from tenants where id = ${tenantId}::uuid`);

    const rows = await db.execute(
      sql`select 1 from memberships where tenant_id = ${tenantId}::uuid`,
    );
    expect([...rows]).toHaveLength(0);
  });

  it('has the by-user index in the migrated database, not only in the model', async () => {
    /*
     * Existence, deliberately — not an EXPLAIN assertion.
     *
     * The planner will not choose an index on a table holding a handful of test
     * rows, and it cannot be pushed into doing so honestly here: ANALYZE needs
     * table ownership, which `app_rw` does not have. An `enable_seqscan = off`
     * dressed up as a plan assertion would prove only that the index is usable,
     * which is what this checks directly and without the theatre. What is
     * actually at risk is someone replacing this with an index on
     * (tenant_id, user_id), which cannot serve a lookup with no tenant.
     */
    const rows = await db.execute(sql`
      select indexdef from pg_indexes
      where tablename = 'memberships' and indexname = 'memberships_user_id_idx'
    `);

    expect(String([...rows][0]?.indexdef)).toContain('(user_id)');
  });

  it('stamps updated_at on update', async () => {
    const tenantId = await createTenant('touch-membership');
    const inserted = await addMember(tenantId, 'user-touch', 'EDITOR');
    const id = [...inserted][0]?.id;

    const before = await db.execute(sql`select updated_at from memberships where id = ${id}::uuid`);
    await db.execute(
      sql`update memberships set role = 'OWNER'::membership_role where id = ${id}::uuid`,
    );
    const after = await db.execute(sql`select updated_at from memberships where id = ${id}::uuid`);

    expect(Number([...after][0]?.updated_at)).toBeGreaterThan(Number([...before][0]?.updated_at));
  });
});
