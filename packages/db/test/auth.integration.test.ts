import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The Better Auth tables against real Postgres (P0-23a).
 *
 * Two things are worth proving here rather than in a shape spec: that the
 * tables are reachable *without* tenant context, which is the whole reason they
 * carry no policy, and that the new foreign key on `memberships` actually
 * refuses a membership for a user who does not exist.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** foreign_key_violation. */
const FOREIGN_KEY_VIOLATION = '23503';
/** unique_violation. */
const UNIQUE_VIOLATION = '23505';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

const makeUser = async (email = `${randomUUID()}@example.com`): Promise<string> => {
  const id = `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

  await db.execute(sql`
    insert into auth_users (id, name, email) values (${id}, 'Matteo', ${email})
  `);

  return id;
};

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

describe('auth tables', () => {
  it('are readable and writable with no tenant context at all', async () => {
    /*
     * The property that makes login possible. Every tenant-scoped table
     * returns nothing without `app.tenant_id` set — by design — and if these
     * behaved the same way, no user could ever be found in order to discover
     * which tenants they belong to.
     */
    await db.execute(sql`select set_config('app.tenant_id', '', false)`);

    const id = await makeUser();
    const rows = await db.execute(sql`select id from auth_users where id = ${id}`);

    expect([...rows]).toHaveLength(1);
  });

  it('refuses two users with the same email', async () => {
    const email = `${randomUUID()}@example.com`;
    await makeUser(email);

    const error = await makeUser(email).catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('removes sessions and accounts when the user goes', async () => {
    // A session outliving its user authenticates as somebody who no longer
    // exists — the failure this cascade prevents.
    const userId = await makeUser();

    await db.execute(sql`
      insert into auth_sessions (id, user_id, token, expires_at)
      values (${`sess_${randomUUID()}`}, ${userId}, ${randomUUID()}, now() + interval '1 day')
    `);
    await db.execute(sql`
      insert into auth_accounts (id, user_id, account_id, provider_id, issuer, password)
      values (
        ${`acct_${randomUUID()}`}, ${userId}, ${userId}, 'credential',
        -- Required since Better Auth 1.7 (P0-45). What identifies an account is
        -- (issuer, account_id), because one provider can front several issuers.
        'local:credential', 'argon2-hash'
      )
    `);

    await db.execute(sql`delete from auth_users where id = ${userId}`);

    const sessions = await db.execute(sql`select 1 from auth_sessions where user_id = ${userId}`);
    const accounts = await db.execute(sql`select 1 from auth_accounts where user_id = ${userId}`);

    expect([...sessions]).toHaveLength(0);
    expect([...accounts]).toHaveLength(0);
  });

  it('keeps the password hash on the account, not on the user', async () => {
    // One row per provider per user, and the credential provider is one of
    // them. A `password` column on auth_users would have to be null for every
    // OAuth user and would invite reading it as "the" password.
    const rows = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'auth_users' and column_name = 'password'
    `);

    expect([...rows]).toHaveLength(0);
  });
});

describe('memberships.user_id foreign key', () => {
  it('refuses a membership for a user who does not exist', async () => {
    /*
     * The key P0-23a exists to add. Until now `user_id` was text pointing at
     * nothing: a membership could name a user who had never existed, and the
     * row would sit there granting access to an account nobody could log into
     * — or worse, that someone could later create.
     */
    const tenantId = await createTenant(db, 'fk-check');

    const error = await db
      .execute(
        sql`
        insert into memberships (tenant_id, user_id, role)
        values (${tenantId}::uuid, 'user_never_existed', 'OWNER')
      `,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('accepts one for a user who does', async () => {
    const userId = await makeUser();
    const tenantId = await createTenant(db, 'fk-ok');

    await db.execute(sql`
      insert into memberships (tenant_id, user_id, role)
      values (${tenantId}::uuid, ${userId}, 'OWNER')
    `);

    const rows = await db.execute(
      sql`select 1 from memberships where tenant_id = ${tenantId}::uuid`,
    );

    expect([...rows]).toHaveLength(1);
  });

  it('removes the membership when the user is deleted', async () => {
    // Deleting a user must not leave a membership granting access to a tenant.
    const userId = await makeUser();
    const tenantId = await createTenant(db, 'fk-cascade');

    await db.execute(sql`
      insert into memberships (tenant_id, user_id, role)
      values (${tenantId}::uuid, ${userId}, 'EDITOR')
    `);

    await db.execute(sql`delete from auth_users where id = ${userId}`);

    const rows = await db.execute(
      sql`select 1 from memberships where tenant_id = ${tenantId}::uuid`,
    );

    expect([...rows]).toHaveLength(0);
  });
});
