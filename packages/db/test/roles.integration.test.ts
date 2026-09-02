import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { applyBootstrap } from '../src/deploy.js';
import { ROLE_PASSWORDS, startPostgres, type TestPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Bootstrap: database roles (P0-21).
 *
 * These assertions look like trivia — a boolean column in `pg_roles` — but each
 * one is a way RLS silently stops applying. A superuser bypasses every policy;
 * so does BYPASSRLS; so does the table's owner, even with FORCE set. The full
 * privilege sweep is P0-39; this proves the roles bootstrap creates are the
 * roles it claims to create.
 */

const attributes = (db: Database, role: string) =>
  db
    .execute(
      sql`select rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole
          from pg_roles where rolname = ${role}`,
    )
    .then((rows) => [...rows][0]);

let started: TestPostgres;
let container: StartedPostgreSqlContainer | undefined;
let admin: DbClient | undefined;
let db: Database;

beforeAll(async () => {
  started = await startPostgres();
  container = started.container;

  admin = createDbClient(started.adminUrl, { max: 1 });
  db = admin.db;
}, 180_000);

afterAll(async () => {
  await admin?.close();
  await container?.stop();
}, 60_000);

describe('bootstrap/0001_roles', () => {
  it('creates app_rw as a role that cannot defeat RLS', async () => {
    const role = await attributes(db, 'app_rw');

    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: true,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  it('creates app_migrate without superuser or BYPASSRLS either', async () => {
    // The migration role owns the tables, and FORCE ROW LEVEL SECURITY covers
    // an owner — but only if that owner is not separately exempt.
    const role = await attributes(db, 'app_migrate');

    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: true,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  it('creates app_admin with BYPASSRLS but no way to log in', async () => {
    // Break-glass has to be able to read across tenants; it must not be
    // reachable with a password sitting in a parameter store. Enabling it is a
    // deliberate act by a human with master access, which is the audit trail.
    const role = await attributes(db, 'app_admin');

    expect(role).toMatchObject({ rolbypassrls: true, rolcanlogin: false, rolsuper: false });
  });

  it('gives only app_migrate the ability to create objects', async () => {
    const rows = await db.execute(sql`
      select
        has_schema_privilege('app_rw', 'public', 'USAGE') as rw_usage,
        has_schema_privilege('app_rw', 'public', 'CREATE') as rw_create,
        has_schema_privilege('app_migrate', 'public', 'CREATE') as migrate_create
    `);

    // No CREATE for app_rw is what stops it owning a table — and an owner is
    // exempt from its own policies unless FORCE is set on every one of them.
    expect([...rows][0]).toEqual({ rw_usage: true, rw_create: false, migrate_create: true });
  });

  it('leaves nothing reachable through PUBLIC', async () => {
    // PUBLIC is every role, including ones added years from now for unrelated
    // reasons. A grant left on PUBLIC is a grant nobody remembers making.
    const rows = await db.execute(
      sql`select has_schema_privilege('public', 'public', 'USAGE') as public_usage`,
    );

    expect([...rows][0]?.public_usage).toBe(false);
  });

  it('grants app_rw DML on tables app_migrate creates, without an explicit grant', async () => {
    // ALTER DEFAULT PRIVILEGES applies only to objects created *after* it runs
    // and only to those created by the role it names. Both halves are easy to
    // get wrong in a way that grants nothing and is noticed much later.
    const migrator = createDbClient(started.roleUrl('app_migrate'), { max: 1 });

    try {
      await migrator.db.execute(sql`create table default_privilege_probe (id int primary key)`);

      const rows = await db.execute(sql`
        select
          has_table_privilege('app_rw', 'default_privilege_probe', 'SELECT') as can_select,
          has_table_privilege('app_rw', 'default_privilege_probe', 'INSERT') as can_insert,
          has_table_privilege('app_rw', 'default_privilege_probe', 'UPDATE') as can_update,
          has_table_privilege('app_rw', 'default_privilege_probe', 'DELETE') as can_delete
      `);

      expect([...rows][0]).toEqual({
        can_select: true,
        can_insert: true,
        can_update: true,
        can_delete: true,
      });
    } finally {
      await migrator.close();
    }
  });

  it('rotates the password on re-apply rather than failing', async () => {
    // Bootstrap runs on every deploy, so "the role already exists" cannot be an
    // error. Rotation falling out of that is the useful part: changing a
    // password is re-running bootstrap with a new value, not a separate ritual.
    const rotated = 'app_rw_rotated_password';

    await applyBootstrap(started.adminUrl, { ...ROLE_PASSWORDS, app_rw: rotated });

    const withNewPassword = createDbClient(
      started.roleUrl('app_rw').replace(ROLE_PASSWORDS.app_rw, rotated),
      { max: 1 },
    );

    try {
      const rows = await withNewPassword.db.execute(sql`select current_user as who`);
      expect([...rows][0]?.who).toBe('app_rw');
    } finally {
      await withNewPassword.close();
      // Put it back: later files in this suite, and any suite sharing the
      // fixture, expect the documented password.
      await applyBootstrap(started.adminUrl, ROLE_PASSWORDS);
    }
  });
});
