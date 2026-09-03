import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { RLS_POLICIES } from '../src/rls.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The powers `app_rw` must not have (P0-39).
 *
 * P0-38 proves the policies work against the role as it is configured today.
 * This proves the configuration itself, because every one of these attributes
 * silently disables every policy at once — and does so without failing a single
 * isolation test, since a role that bypasses RLS passes them by seeing
 * everything it is asked about and nothing it is not.
 *
 * The realistic failure is a convenience change: someone grants ownership to
 * fix a permission error, or points the application at the migration role
 * during an incident. This test is what makes that loud.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let admin: DbClient | undefined;
let db: Database;
let adminDb: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  // Catalogue reads go through the superuser: `pg_roles` is readable by
  // anyone, but asking as app_rw would leave the test unable to distinguish
  // "attribute is false" from "row is not visible".
  admin = createDbClient(started.adminUrl, { max: 1 });
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await admin?.close();
  await container?.stop();
}, 60_000);

describe('app_rw role attributes', () => {
  it('cannot bypass RLS and is not a superuser', async () => {
    // Either attribute makes every policy in P0-37 decorative, and neither
    // shows up as a failure anywhere else: the suite would stay green while
    // isolation was gone.
    const rows = await adminDb.execute(sql`
      select rolbypassrls, rolsuper, rolcreatedb, rolcreaterole
      from pg_roles where rolname = 'app_rw'
    `);
    const role = [...rows][0];

    expect(role?.rolbypassrls).toBe(false);
    expect(role?.rolsuper).toBe(false);
    expect(role?.rolcreatedb).toBe(false);
    expect(role?.rolcreaterole).toBe(false);
  });

  it('owns none of the tables it reads', async () => {
    /*
     * Ownership is the quiet way around FORCE ROW LEVEL SECURITY — or it was,
     * before FORCE. With FORCE the owner is still subject to policies, so this
     * is defence in depth rather than the only guard, but an owner can also
     * ALTER the table to remove FORCE, which is the path this closes.
     */
    const rows = await adminDb.execute(sql`
      select tablename, tableowner from pg_tables where schemaname = 'public'
    `);
    const ownedByAppRw = [...rows]
      .filter((row) => (row as { tableowner: unknown }).tableowner === 'app_rw')
      .map((row) => String((row as { tablename: unknown }).tablename));

    expect(ownedByAppRw).toEqual([]);
  });

  it('leaves every RLS-protected table owned by app_migrate', async () => {
    // The positive half: not merely "not app_rw" but the role the migrations
    // actually run as, which is what the FORCE reasoning depends on.
    const rows = await adminDb.execute(sql`
      select tablename, tableowner from pg_tables where schemaname = 'public'
    `);
    const owners = new Map(
      [...rows].map((row) => [
        String((row as { tablename: unknown }).tablename),
        String((row as { tableowner: unknown }).tableowner),
      ]),
    );

    for (const { table } of RLS_POLICIES) {
      expect(owners.get(table), table).toBe('app_migrate');
    }
  });
});

describe('app_rw privileges', () => {
  it('cannot create a table', async () => {
    // A table app_rw created would be owned by app_rw, and an owner can drop
    // FORCE from its own table. This is the first step of that path.
    const error = await db
      .execute(sql`create table rls_escape (id int)`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot disable row level security on a table it does not own', async () => {
    // The direct attack, and the one a well-meaning fix reaches for when a
    // query mysteriously returns nothing.
    const error = await db
      .execute(sql`alter table products disable row level security`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot drop the isolation policy', async () => {
    const error = await db
      .execute(sql`drop policy tenant_isolation on products`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot add a policy of its own', async () => {
    // Adding a permissive policy is additive in Postgres: a second policy ORs
    // with the first, so one `using (true)` would open every table without
    // touching the existing policy at all.
    const error = await db
      .execute(sql`create policy wide_open on products using (true)`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('gains nothing by granting itself everything', async () => {
    /*
     * Postgres does not raise here. A GRANT issued by a non-owner emits a
     * warning — "no privileges were granted" — and succeeds as a no-op, so an
     * assertion on the error code would fail while the security property held
     * perfectly. The outcome is what matters, so the outcome is what is
     * asserted: TRUNCATE is a privilege app_rw was never given, and it still
     * does not have it afterwards.
     */
    const before = await db.execute(
      sql`select has_table_privilege('app_rw', 'products', 'TRUNCATE') as allowed`,
    );

    expect([...before][0]?.allowed).toBe(false);

    await db.execute(sql`grant all on products to app_rw`);

    const after = await db.execute(
      sql`select has_table_privilege('app_rw', 'products', 'TRUNCATE') as allowed`,
    );

    expect([...after][0]?.allowed).toBe(false);
  });

  it('cannot read the migration ledger', async () => {
    // app_rw gets no USAGE on the drizzle schema (P0-21). The ledger decides
    // whether a migration is re-applied, so the runtime role has no business
    // reading it, let alone rewriting it.
    const error = await db
      .execute(sql`select * from drizzle.__drizzle_migrations`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('app_admin', () => {
  it('can bypass RLS but has no way to log in', async () => {
    /*
     * The break-glass role. BYPASSRLS is what makes it useful for reading
     * unattributed security_events (P0-32); NOLOGIN with no password is what
     * makes it safe to have. Enabling it is a deliberate act by a human with
     * master access, not a credential sitting in an environment variable.
     */
    const rows = await adminDb.execute(sql`
      select rolbypassrls, rolcanlogin from pg_roles where rolname = 'app_admin'
    `);
    const role = [...rows][0];

    expect(role?.rolbypassrls).toBe(true);
    expect(role?.rolcanlogin).toBe(false);
  });
});

describe('app_migrate', () => {
  it('cannot bypass RLS either, which is why FORCE matters', async () => {
    // If app_migrate could bypass, FORCE would be pointless and a migration
    // run against the wrong tenant context would read across every tenant.
    const rows = await adminDb.execute(sql`
      select rolbypassrls, rolsuper from pg_roles where rolname = 'app_migrate'
    `);
    const role = [...rows][0];

    expect(role?.rolbypassrls).toBe(false);
    expect(role?.rolsuper).toBe(false);
  });
});
