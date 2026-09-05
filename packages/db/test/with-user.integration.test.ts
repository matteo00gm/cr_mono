import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { withTenant } from '../src/with-tenant.js';
import { InvalidUserIdError, NestedUserContextError, withUser } from '../src/with-user.js';
import { startPostgres } from './support/postgres.js';
import { createAuthUser, createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The user-scoped context (P0-47).
 *
 * Tenant resolution has to read `memberships` before a tenant is known, and the
 * point of this file is that it does **not** need an un-scoped connection to do
 * it. P0-37 wrote the policy for exactly this case:
 *
 * ```sql
 * USING      (tenant_id = app.tenant_id OR user_id = app.user_id)
 * WITH CHECK (tenant_id = app.tenant_id)
 * ```
 *
 * So what is asserted here is the *bound*: with only `app.user_id` set, the
 * caller sees their own membership rows and nothing else — not another user's,
 * not another tenant's data, and they cannot write. Every one of those is a
 * property of the policy rather than of the query, which is why they are tested
 * against a real database instead of reasoned about.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

let alice = '';
let bob = '';
let wineryA = '';
let wineryB = '';

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  // `max: 1`: the GUCs are session state, so every statement has to land on the
  // connection that set them.
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  alice = await createAuthUser(db, 'alice');
  bob = await createAuthUser(db, 'bob');

  wineryA = await createTenant(db, 'winery-a');
  await db.execute(
    sql`insert into memberships (tenant_id, user_id, role) values (${wineryA}::uuid, ${alice}, 'EDITOR')`,
  );

  wineryB = await createTenant(db, 'winery-b');
  await db.execute(
    sql`insert into memberships (tenant_id, user_id, role) values (${wineryB}::uuid, ${alice}, 'OWNER')`,
  );
  await db.execute(
    sql`insert into memberships (tenant_id, user_id, role) values (${wineryB}::uuid, ${bob}, 'EDITOR')`,
  );

  // Leave no tenant context behind for the assertions below.
  await db.execute(sql`select set_config('app.tenant_id', '', false)`);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

const membershipsFor = (userId: string): Promise<{ tenant_id: string; role: string }[]> =>
  withUser(
    userId,
    async (tx) => {
      const rows = await tx.execute<{ tenant_id: string; role: string }>(
        sql`select tenant_id, role from memberships`,
      );
      return [...rows];
    },
    db,
  );

describe('what a user context can read', () => {
  it('returns exactly the caller’s own membership rows', async () => {
    /*
     * Note the query has no `WHERE user_id = …`. That is the point: the rows
     * come back scoped because the *policy* scopes them, so the guarantee
     * survives a careless query rather than depending on one.
     */
    const rows = await membershipsFor(alice);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.tenant_id).sort()).toEqual([wineryA, wineryB].sort());
  });

  it('carries the role belonging to each row', async () => {
    // Alice is EDITOR on one winery and OWNER on the other — the case that
    // makes "role is a property of a user" wrong.
    const rows = await membershipsFor(alice);
    const byTenant = Object.fromEntries(rows.map((row) => [row.tenant_id, row.role]));

    expect(byTenant[wineryA]).toBe('EDITOR');
    expect(byTenant[wineryB]).toBe('OWNER');
  });

  it('never returns another user’s membership', async () => {
    /*
     * Alice and Bob share winery B, so a policy that leaked by *tenant* rather
     * than by user would show Alice Bob's row here. The fixture is built that
     * way deliberately — with disjoint tenants this assertion would pass while
     * proving nothing.
     */
    const rows = await membershipsFor(alice);

    expect(rows).toHaveLength(2);
    expect(await membershipsFor(bob)).toHaveLength(1);
  });

  it('returns nothing for a user with no memberships', async () => {
    const stranger = await createAuthUser(db, 'stranger');
    await db.execute(sql`select set_config('app.tenant_id', '', false)`);

    expect(await membershipsFor(stranger)).toHaveLength(0);
  });

  it('cannot reach tenant data, because no other policy reads app.user_id', async () => {
    /*
     * The bound that makes this a *scoped* context rather than a second hole.
     * `memberships` is the only table whose policy mentions `app.user_id`, so a
     * user context is not a general-purpose read — it can answer "which
     * wineries am I in" and nothing else.
     */
    const products = await withUser(
      alice,
      async (tx) => [...(await tx.execute(sql`select id from products`))],
      db,
    );
    const tenants = await withUser(
      alice,
      async (tx) => [...(await tx.execute(sql`select id from tenants`))],
      db,
    );

    expect(products).toHaveLength(0);
    expect(tenants).toHaveLength(0);
  });
});

describe('what a user context cannot write', () => {
  it('cannot insert a membership for itself', async () => {
    /*
     * `WITH CHECK` is tenant-only, deliberately: including `user_id` there
     * would let any authenticated user insert a membership for themselves into
     * any tenant — the entire authorisation model, gone. Reading your own rows
     * is safe; writing them is not.
     */
    const error = await withUser(
      alice,
      (tx) =>
        tx.execute(
          sql`insert into memberships (tenant_id, user_id, role)
              values (${wineryA}::uuid, ${bob}, 'OWNER')`,
        ),
      db,
    ).catch((caught: unknown) => caught);

    // insufficient_privilege — the WITH CHECK refused it.
    expect(pgErrorCode(error)).toBe('42501');
  });
});

describe('the guards', () => {
  it('refuses an empty user id', async () => {
    /*
     * `nullif(current_setting(…), '')` treats an empty GUC as absent, so an
     * empty id would match no row rather than every row — safe, but a confusing
     * zero. Failing loudly says which of the two happened.
     */
    await expect(withUser('', async (tx) => tx.execute(sql`select 1`), db)).rejects.toBeInstanceOf(
      InvalidUserIdError,
    );
    await expect(
      withUser('   ', async (tx) => tx.execute(sql`select 1`), db),
    ).rejects.toBeInstanceOf(InvalidUserIdError);
  });

  it('refuses to open inside a tenant context', async () => {
    /*
     * With both GUCs set the policy matches on either, so a read that looked
     * tenant-scoped would also return that user's rows in *other* tenants.
     * Nothing needs that, and an accidental nesting is far likelier to be a bug
     * than an intention.
     */
    await expect(
      withTenant(wineryA, () => withUser(alice, async (tx) => tx.execute(sql`select 1`), db), db),
    ).rejects.toBeInstanceOf(NestedUserContextError);
  });

  it('does not leave the setting behind for the next transaction', async () => {
    /*
     * `SET LOCAL` semantics, and the reason `withTenant` uses them too: a value
     * that outlived its transaction would leak onto whichever request borrowed
     * the pooled connection next — the failure that never reproduces locally.
     */
    await membershipsFor(alice);

    const after = await db.execute<{ value: string | null }>(
      sql`select nullif(current_setting('app.user_id', true), '') as value`,
    );

    expect([...after][0]?.value).toBeNull();
  });

  it('leaves a tenant-scoped read unaffected afterwards', async () => {
    // The contexts are independent: using one must not disturb the other.
    await membershipsFor(alice);

    const rows = await withTenant(
      wineryB,
      async (tx) => [...(await tx.execute(sql`select tenant_id from memberships`))],
      db,
    );

    // Winery B has both Alice and Bob — tenant scope sees the whole roster.
    expect(rows).toHaveLength(2);
  });
});

describe('the alternative that was not taken', () => {
  it('confirms a bare read without either GUC returns nothing', async () => {
    /*
     * Why an un-scoped connection was not needed. Without context the policy
     * denies everything, which is what makes the pre-tenant read look
     * impossible at first — and `app.user_id` is the answer P0-37 already
     * wrote, rather than a second exception beside the Better Auth one.
     */
    await useTenant(db, wineryA);
    await db.execute(sql`select set_config('app.tenant_id', '', false)`);
    await db.execute(sql`select set_config('app.user_id', '', false)`);

    const rows = await db.execute(sql`select tenant_id from memberships`);

    expect([...rows]).toHaveLength(0);
  });
});
