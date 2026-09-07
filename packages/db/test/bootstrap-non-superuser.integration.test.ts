import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type DbClient } from '../src/client.js';
import { applyBootstrap, applyMigrations, withRole } from '../src/deploy.js';
import { POSTGRES_IMAGE, ROLE_PASSWORDS } from './support/postgres.js';

/**
 * Bootstrap applied by a role that is **not** a superuser.
 *
 * **This suite exists because a deploy found a bug eleven integration files
 * could not.** `bootstrap/0001_roles.sql` runs
 * `ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate`, which requires the caller to
 * be a *member* of that role. A true superuser passes that check implicitly —
 * and the container's `postgres` user is one — so every existing suite stayed
 * green while the statement failed on RDS with `permission denied to change
 * default privileges`.
 *
 * RDS's master is `rds_superuser`: `CREATEROLE` and `CREATEDB`, but **not**
 * `SUPERUSER`. Every other privilege assertion in this repository shares the
 * same blind spot, because they all bootstrap as a role more privileged than
 * any managed provider will ever hand out. This file closes it for the path
 * that matters most — the one a deploy actually runs.
 *
 * It starts its own container rather than using the shared harness, because the
 * harness bootstraps as the superuser by design and the whole point here is not
 * to.
 */

/**
 * As close to `rds_superuser` as a plain container gets.
 *
 * **`BYPASSRLS` is part of the model, and CI is what established that.** The
 * first version of this role omitted it, and bootstrap failed with
 * `Only roles with the BYPASSRLS attribute may create roles with the BYPASSRLS
 * attribute` — `bootstrap/0001` creates the break-glass `app_admin` role with
 * it.
 *
 * That is a fidelity bug in the model rather than a bug in bootstrap, and the
 * evidence is direct: the real migration runner executed that same statement
 * against RDS successfully on 2026-09-07, so RDS's master demonstrably holds
 * the attribute. A model more restrictive than the thing it models produces
 * failures nobody will ever see, which is its own kind of untrue.
 *
 * It does not weaken what this file tests. `BYPASSRLS` is a row-security
 * attribute; `ALTER DEFAULT PRIVILEGES FOR ROLE x` needs *membership* in `x`,
 * which no attribute confers. The membership check is still the subject.
 */
const RDS_LIKE = { role: 'rds_like_master', password: 'rds_like_password' } as const;

let container: StartedPostgreSqlContainer | undefined;
let adminDb: DbClient['db'];
let adminClient: DbClient | undefined;
let rwClient: DbClient | undefined;

let masterUrl: string;
let roleUrl: (role: 'app_rw' | 'app_migrate') => string;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();

  const host = container.getHost();
  const port = String(container.getPort());
  const database = container.getDatabase();
  const adminUrl = `${container.getConnectionUri()}?sslmode=disable`;

  masterUrl = `postgres://${RDS_LIKE.role}:${RDS_LIKE.password}@${host}:${port}/${database}?sslmode=disable`;
  roleUrl = (role) =>
    `postgres://${role}:${ROLE_PASSWORDS[role]}@${host}:${port}/${database}?sslmode=disable`;

  adminClient = createDbClient(adminUrl, { max: 1 });
  adminDb = adminClient.db;

  /*
   * Built as the container superuser, then never used for the bootstrap itself.
   * `CREATEROLE` and `CREATEDB` without `SUPERUSER` is what RDS hands you, and
   * the distinction is the entire subject of this file: a superuser is
   * implicitly a member of every role, so it passes membership checks it was
   * never granted.
   */
  await adminDb.execute(
    sql.raw(`CREATE ROLE ${RDS_LIKE.role} LOGIN CREATEROLE CREATEDB BYPASSRLS NOSUPERUSER
             PASSWORD '${RDS_LIKE.password}'`),
  );

  /*
   * **Owner of the database and of `public`, because that is what RDS gives
   * the master.** Three statements in `bootstrap/0001` need it and would
   * otherwise fail for a reason that has nothing to do with what is under test:
   * `REVOKE ALL ON SCHEMA public FROM PUBLIC` and `GRANT ... ON SCHEMA public`
   * need schema ownership, and `GRANT CREATE ON DATABASE` needs the grantor to
   * hold it with grant option.
   *
   * Modelling those as failures would be modelling the wrong thing — the point
   * is the *membership* check that `ALTER DEFAULT PRIVILEGES` performs, which
   * ownership does not confer.
   */
  await adminDb.execute(sql.raw(`ALTER DATABASE ${database} OWNER TO ${RDS_LIKE.role}`));
  await adminDb.execute(sql.raw(`ALTER SCHEMA public OWNER TO ${RDS_LIKE.role}`));

  /*
   * Extensions pre-created as superuser, all four of them.
   *
   * On RDS `rds_superuser` may install these from the allowlist; a synthetic
   * `NOSUPERUSER` role in a plain container may not, and `vector` in particular
   * is not a trusted extension. `bootstrap/0000` uses `IF NOT EXISTS`, so it
   * finds them already present and moves on — which is also what happens on a
   * re-run against a real database.
   */
  for (const extension of ['vector', 'pg_trgm', 'unaccent', 'citext']) {
    await adminDb.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS ${extension}`));
  }
}, 240_000);

afterAll(async () => {
  await rwClient?.close();
  await adminClient?.close();
  await container?.stop();
}, 60_000);

describe('bootstrap as a non-superuser', () => {
  it('applies without a permission error', async () => {
    /*
     * The assertion that would have caught it. Before the explicit
     * `GRANT app_migrate, app_rw TO current_user`, this threw
     * `permission denied to change default privileges` — on RDS, on the first
     * real deploy, with every existing suite green.
     */
    await expect(applyBootstrap(masterUrl, ROLE_PASSWORDS)).resolves.toBeUndefined();
  });

  it('is re-runnable, because a deploy runs it every time', async () => {
    // The second run also re-grants membership, which must not error on a role
    // that already has it.
    await expect(applyBootstrap(masterUrl, ROLE_PASSWORDS)).resolves.toBeUndefined();
  });

  it('leaves default privileges that actually work', async () => {
    /*
     * **The assertion that matters, and it is not "no error was thrown".**
     * `ALTER DEFAULT PRIVILEGES` could plausibly be skipped or misapplied and
     * still not raise — the symptom would be `app_rw` unable to read tables
     * `app_migrate` creates, which shows up as every query failing at runtime
     * long after the deploy reported success.
     *
     * So: run the real migrations as `app_migrate`, then read one of the tables
     * they created as `app_rw`.
     */
    await applyMigrations(withRole(masterUrl, 'app_migrate', ROLE_PASSWORDS.app_migrate));

    rwClient = createDbClient(roleUrl('app_rw'), { max: 1 });

    const rows = await rwClient.db.execute(sql`SELECT count(*)::int AS n FROM tenants`);
    expect(([...rows][0] as { n: number }).n).toBe(0);
  });

  it('makes app_migrate the owner, not the bootstrapping role', async () => {
    /*
     * Everything about tenant isolation depends on this. `FORCE ROW LEVEL
     * SECURITY` does not apply to a table's owner, so if the master had ended
     * up owning these tables every P0-37 policy would be inert for it — and the
     * bug would be invisible until somebody connected as master and saw every
     * tenant's rows.
     */
    const rows = await adminDb.execute(sql`
      SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tenants'
    `);

    expect(([...rows][0] as { tableowner: string }).tableowner).toBe('app_migrate');
  });

  it('does not make the bootstrapping role a superuser by accident', async () => {
    /*
     * Guards the guard. If `rds_like_master` were somehow a superuser every
     * assertion above would pass while testing nothing — the exact failure this
     * file exists to correct.
     *
     * `rolbypassrls` is asserted true in the same breath, because it is part of
     * the model rather than an accident: RDS's master holds it, proven by the
     * real runner creating `app_admin` on 2026-09-07. Pinning both means a
     * future edit cannot quietly make this role either more or less privileged
     * than the thing it stands in for.
     */
    const rows = await adminDb.execute(
      sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${RDS_LIKE.role}`,
    );
    const role = [...rows][0] as { rolsuper: boolean; rolbypassrls: boolean };

    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(true);
  });
});
