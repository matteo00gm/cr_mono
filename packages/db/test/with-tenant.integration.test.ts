import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { NestedTenantContextError, withTenant } from '../src/with-tenant.js';

/**
 * RLS isolation against real Postgres (P0-19).
 *
 * Every other test of `withTenant` mocks the database, which can show that the
 * right SQL is emitted but not that it has the intended effect. The property
 * this file exists for — tenant context not surviving the transaction on a
 * reused connection — is invisible to a mock by construction.
 */

/**
 * Drizzle wraps driver errors as `Failed query: ...` and keeps the Postgres
 * error on `cause`, so matching the message finds nothing useful. The SQLSTATE
 * is the stable, translation-independent assertion.
 */
const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** insufficient_privilege — what a WITH CHECK violation raises. */
const RLS_VIOLATION = '42501';

const TENANT_A = 'a0000000-0000-4000-8000-000000000001';
const TENANT_B = 'b0000000-0000-4000-8000-000000000002';

// Typed as optional because cleanup must survive a setup that failed halfway;
// declaring them non-nullable made the guards in afterAll look redundant to
// the linter while still being necessary at runtime.
let container: StartedPostgreSqlContainer | undefined;
/** Owns the schema. Superuser, so RLS never applies to it. */
let admin: DbClient | undefined;
/** Connects as `app_rw`: no superuser, no BYPASSRLS, not the table owner. */
let app: DbClient | undefined;
/** Assigned in beforeAll; tests do not run if that failed. */
let db: Database;

const APP_ROLE = 'app_rw';
const APP_PASSWORD = 'app_rw_password';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const adminClient = createDbClient(`${container.getConnectionUri()}?sslmode=disable`, {
    max: 1,
  });
  admin = adminClient;

  await adminClient.db.execute(sql`
    create table products (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null,
      name text not null
    )
  `);

  // Seeded before RLS is enabled, because FORCE applies to the table owner too.
  await adminClient.db.execute(sql`
    insert into products (tenant_id, name) values
      (${TENANT_A}::uuid, 'Barolo'),
      (${TENANT_A}::uuid, 'Barbaresco'),
      (${TENANT_B}::uuid, 'Chianti')
  `);

  await adminClient.db.execute(sql`alter table products enable row level security`);
  // FORCE matters: without it the *owner* bypasses its own policies.
  await adminClient.db.execute(sql`alter table products force row level security`);
  /*
   * `nullif(..., '')` is load-bearing, not defensive noise.
   *
   * Once a custom GUC has been set in a session, ending the transaction
   * reverts it to the empty string rather than unsetting it. Without the
   * nullif, `''::uuid` raises 22P02, so a connection that previously carried
   * tenant context throws on its next query instead of returning zero rows —
   * an error where the policy should simply match nothing.
   */
  await adminClient.db.execute(sql`
    create policy tenant_isolation on products
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  `);

  /*
   * Run the assertions as a non-superuser, non-owner role — a preview of P0-21.
   *
   * This is not incidental. The first version of this suite connected as the
   * container's default user, which is a SUPERUSER: superusers bypass RLS
   * outright and `FORCE` does not apply to them, so every policy above was
   * inert and the isolation tests passed nothing. A suite that proves
   * isolation must connect the way the application does.
   */
  await adminClient.db.execute(
    sql`create role ${sql.raw(APP_ROLE)} login password ${sql.raw(`'${APP_PASSWORD}'`)} nosuperuser nobypassrls`,
  );
  await admin.db.execute(
    sql`grant select, insert, update, delete on products to ${sql.raw(APP_ROLE)}`,
  );

  // max: 1 is the point. With a larger pool the "context does not leak"
  // assertion could pass merely by landing on a different connection.
  const appClient = createDbClient(
    `postgres://${APP_ROLE}:${APP_PASSWORD}@${container.getHost()}:${String(container.getPort())}/${container.getDatabase()}?sslmode=disable`,
    { max: 1 },
  );
  app = appClient;
  db = appClient.db;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await admin?.close();
  await container?.stop();
}, 60_000);

describe('withTenant against real Postgres', () => {
  it("sees only the active tenant's rows", async () => {
    const rows = await withTenant(TENANT_A, (tx) => tx.execute(sql`select name from products`), db);

    expect([...rows].map((r) => r.name).sort()).toEqual(['Barbaresco', 'Barolo']);
  });

  it("cannot read another tenant's row even by explicit id", async () => {
    // The IDOR shape: naming the row directly must still return nothing,
    // rather than relying on the caller to add a tenant filter.
    const rows = await withTenant(
      TENANT_A,
      (tx) => tx.execute(sql`select name from products where tenant_id = ${TENANT_B}::uuid`),
      db,
    );

    expect([...rows]).toHaveLength(0);
  });

  it('cannot insert a row belonging to another tenant', async () => {
    // WITH CHECK, not just USING: reading is only half of isolation.
    const error = await withTenant(
      TENANT_A,
      (tx) =>
        tx.execute(sql`insert into products (tenant_id, name) values (${TENANT_B}::uuid, 'x')`),
      db,
    ).catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(RLS_VIOLATION);
  });

  it('leaves no tenant context on the connection after the transaction', async () => {
    await withTenant(TENANT_A, (tx) => tx.execute(sql`select 1`), db);

    // Same pooled connection, outside any transaction. If set_config had been
    // called without is_local, this would still read TENANT_A and the next
    // request to borrow this connection would inherit it.
    //
    // Asserted as "not the tenant id" rather than "null": Postgres reverts a
    // custom GUC to the empty string at transaction end, so the plan's stated
    // expectation of null is not what the server actually returns.
    const rows = await db.execute(sql`select current_setting('app.tenant_id', true) as tenant`);
    const leaked = [...rows][0]?.tenant;

    expect(leaked).not.toBe(TENANT_A);
    expect(leaked === null || leaked === '').toBe(true);
  });

  it('returns nothing when queried with no tenant context at all', async () => {
    // Fails closed: an unset app.tenant_id makes the policy NULL, not true.
    const rows = await db.execute(sql`select name from products`);

    expect([...rows]).toHaveLength(0);
  });

  it('runs as a role that cannot bypass RLS', async () => {
    // If this regresses, every other assertion in this file silently stops
    // proving anything — which is exactly how the first version of this suite
    // passed while measuring nothing.
    const rows = await db.execute(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    const role = [...rows][0];

    expect(role?.rolsuper).toBe(false);
    expect(role?.rolbypassrls).toBe(false);
  });

  it('rejects a nested tenant context rather than silently re-setting it', async () => {
    await expect(
      withTenant(TENANT_A, () => withTenant(TENANT_B, () => Promise.resolve(null), db), db),
    ).rejects.toBeInstanceOf(NestedTenantContextError);
  });
});
