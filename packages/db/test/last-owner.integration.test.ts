import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { countOwners, removeMember, setMemberRole } from '../src/members-write.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The last-OWNER guard, against real Postgres (P0-52).
 *
 * **The concurrency case is why this exists as its own suite**, and it cannot
 * be written anywhere else. Two demotions arriving together each see the other
 * owner still in place; without a lock covering the whole roster they both
 * succeed and the winery is left with nobody who can manage billing — an
 * unrecoverable support incident, because every path back needs an OWNER
 * (§2.7).
 *
 * A unit test with a fake transaction cannot tell a correct `FOR UPDATE` from a
 * missing one. Only two real connections racing can.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

const USERS = ['user_a', 'user_b', 'user_c'] as const;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  // More than one, so the concurrency test has two connections to race.
  client = createDbClient(started.roleUrl('app_rw'), { max: 4 });
  db = client.db;

  /*
   * Each tenant row goes in inside `withTenant` for its own id, because
   * `tenants` carries `WITH CHECK (id = app.tenant_id)` — the row has to
   * satisfy the policy it is creating the context for. A bare insert is
   * refused with 42501, which is how P0-51's first version of this seed failed
   * in CI.
   *
   * `withTenant` rather than the suite's session-level `useTenant`, because
   * this client keeps a pool of four for the concurrency tests below and a
   * session GUC would land on whichever connection served the statement.
   */
  for (const [id, name, slug] of [
    [TENANT, 'Cantina Rossi', 'cantina-rossi'],
    [OTHER, 'Cantina Verdi', 'cantina-verdi'],
  ] as const) {
    await withTenant(
      id,
      (tx) =>
        tx.execute(sql`
          INSERT INTO tenants (id, name, slug)
          VALUES (${id}::uuid, ${name}, ${slug})
          ON CONFLICT DO NOTHING
        `),
      db,
    );
  }

  // `auth_users` carries no policy — authentication precedes tenant
  // resolution — so this works from any context, including none.
  await db.execute(sql`
    INSERT INTO auth_users (id, name, email) VALUES
      ('user_a', 'A', 'a@cantina.example'),
      ('user_b', 'B', 'b@cantina.example'),
      ('user_c', 'C', 'c@cantina.example')
    ON CONFLICT DO NOTHING
  `);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

/** Rebuilds the roster so each test starts from a known set. */
const roster = async (
  ...rows: readonly (readonly [string, 'OWNER' | 'EDITOR'])[]
): Promise<void> => {
  await withTenant(
    TENANT,
    async (tx) => {
      await tx.execute(sql`DELETE FROM memberships`);
      for (const [userId, role] of rows) {
        await tx.execute(sql`
          INSERT INTO memberships (tenant_id, user_id, role)
          VALUES (${TENANT}::uuid, ${userId}, ${role}::membership_role)
        `);
      }
    },
    db,
  );
};

const rolesNow = async (): Promise<Record<string, string>> => {
  const rows = await withTenant(
    TENANT,
    (tx) => tx.execute(sql`SELECT user_id, role FROM memberships ORDER BY user_id`),
    db,
  );

  return Object.fromEntries(
    [...rows].map((row) => {
      const typed = row as { user_id: string; role: string };
      return [typed.user_id, typed.role];
    }),
  );
};

beforeEach(async () => {
  await roster(['user_a', 'OWNER'], ['user_b', 'EDITOR']);
});

describe('demoting', () => {
  it('refuses the only owner', async () => {
    const outcome = await withTenant(
      TENANT,
      (tx) => setMemberRole(tx, { userId: 'user_a', role: 'EDITOR' }),
      db,
    );

    expect(outcome).toBe('would-remove-last-owner');
    // Refused *and* unchanged. A guard that reports a refusal after writing is
    // worse than none, because the report is believed.
    expect(await rolesNow()).toEqual({ user_a: 'OWNER', user_b: 'EDITOR' });
  });

  it('allows one of three owners', async () => {
    await roster(['user_a', 'OWNER'], ['user_b', 'OWNER'], ['user_c', 'OWNER']);

    const outcome = await withTenant(
      TENANT,
      (tx) => setMemberRole(tx, { userId: 'user_a', role: 'EDITOR' }),
      db,
    );

    // The guard must not be "owners cannot be demoted". That would make an
    // owner permanent, which is its own support incident.
    expect(outcome).toBe('changed');
    expect(await rolesNow()).toMatchObject({ user_a: 'EDITOR', user_b: 'OWNER' });
  });

  it('allows an editor to be promoted and the previous owner then demoted', async () => {
    // The documented way through the refusal, asserted so the message the
    // caller is given is one that actually works.
    await withTenant(TENANT, (tx) => setMemberRole(tx, { userId: 'user_b', role: 'OWNER' }), db);
    const outcome = await withTenant(
      TENANT,
      (tx) => setMemberRole(tx, { userId: 'user_a', role: 'EDITOR' }),
      db,
    );

    expect(outcome).toBe('changed');
    expect(await rolesNow()).toEqual({ user_a: 'EDITOR', user_b: 'OWNER' });
  });

  it('treats a no-op re-assignment of the only owner as a change', async () => {
    // Setting OWNER to OWNER is not a demotion. Refusing it would make the
    // dashboard's "save" button fail on a form nobody edited.
    const outcome = await withTenant(
      TENANT,
      (tx) => setMemberRole(tx, { userId: 'user_a', role: 'OWNER' }),
      db,
    );

    expect(outcome).toBe('changed');
  });
});

describe('removing', () => {
  it('refuses the only owner', async () => {
    const outcome = await withTenant(TENANT, (tx) => removeMember(tx, { userId: 'user_a' }), db);

    expect(outcome).toBe('would-remove-last-owner');
    expect(await rolesNow()).toEqual({ user_a: 'OWNER', user_b: 'EDITOR' });
  });

  it('allows an editor', async () => {
    const outcome = await withTenant(TENANT, (tx) => removeMember(tx, { userId: 'user_b' }), db);

    expect(outcome).toBe('changed');
    expect(await rolesNow()).toEqual({ user_a: 'OWNER' });
  });

  it('allows one of two owners', async () => {
    await roster(['user_a', 'OWNER'], ['user_b', 'OWNER']);

    expect(await withTenant(TENANT, (tx) => removeMember(tx, { userId: 'user_b' }), db)).toBe(
      'changed',
    );
    expect(await rolesNow()).toEqual({ user_a: 'OWNER' });
  });
});

describe('a member of another winery', () => {
  it('is not found rather than refused', async () => {
    await withTenant(
      OTHER,
      (tx) =>
        tx.execute(sql`
          INSERT INTO memberships (tenant_id, user_id, role)
          VALUES (${OTHER}::uuid, 'user_c', 'OWNER')
          ON CONFLICT DO NOTHING
        `),
      db,
    );

    const outcome = await withTenant(
      TENANT,
      (tx) => setMemberRole(tx, { userId: 'user_c', role: 'EDITOR' }),
      db,
    );

    /*
     * `no-such-member`, which the API turns into a 404 — the same answer a
     * made-up user id gets. A 403 here would tell an owner of one winery which
     * accounts belong to another (§3.5).
     */
    expect(outcome).toBe('no-such-member');

    // And the other tenant's row is untouched, which is RLS doing its job:
    // `WHERE user_id =` inside withTenant reaches one tenant's rows only.
    const rows = await withTenant(
      OTHER,
      (tx) => tx.execute(sql`SELECT role FROM memberships WHERE user_id = 'user_c'`),
      db,
    );
    expect(([...rows][0] as { role?: string }).role).toBe('OWNER');
  });
});

describe('concurrency', () => {
  it('lets exactly one of two simultaneous demotions through', async () => {
    /*
     * **The reason this row is its own PR.** Two owners, two requests arriving
     * together, each demoting the other. Without a lock covering the whole
     * roster both statements see a second owner, both succeed, and the winery
     * is left with none — and nothing errors, so nobody finds out until
     * somebody needs the billing page.
     *
     * `lockRoster` takes `FOR UPDATE` over every membership row for the tenant
     * before deciding, so the second transaction blocks until the first
     * commits and then re-evaluates against what is actually there.
     */
    await roster(['user_a', 'OWNER'], ['user_b', 'OWNER']);

    const demote = (userId: string) =>
      withTenant(TENANT, (tx) => setMemberRole(tx, { userId, role: 'EDITOR' }), db);

    const outcomes = await Promise.all([demote('user_a'), demote('user_b')]);

    expect(outcomes.filter((outcome) => outcome === 'changed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'would-remove-last-owner')).toHaveLength(1);

    // The property that matters, stated independently of the outcomes: one
    // owner survives.
    expect(await withTenant(TENANT, (tx) => countOwners(tx), db)).toBe(1);
  });

  it('lets exactly one of a simultaneous demotion and removal through', async () => {
    // The mixed pair, because the two statements are separate and a lock that
    // only covered one of them would pass the test above.
    await roster(['user_a', 'OWNER'], ['user_b', 'OWNER']);

    const outcomes = await Promise.all([
      withTenant(TENANT, (tx) => setMemberRole(tx, { userId: 'user_a', role: 'EDITOR' }), db),
      withTenant(TENANT, (tx) => removeMember(tx, { userId: 'user_b' }), db),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'changed')).toHaveLength(1);
    expect(await withTenant(TENANT, (tx) => countOwners(tx), db)).toBe(1);
  });

  it('survives three at once', async () => {
    // Three owners, all demoting themselves. Exactly two may succeed.
    await roster(['user_a', 'OWNER'], ['user_b', 'OWNER'], ['user_c', 'OWNER']);

    const outcomes = await Promise.all(
      USERS.map((userId) =>
        withTenant(TENANT, (tx) => setMemberRole(tx, { userId, role: 'EDITOR' }), db),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === 'changed')).toHaveLength(2);
    expect(await withTenant(TENANT, (tx) => countOwners(tx), db)).toBe(1);
  });
});

describe('countOwners', () => {
  it('counts owners and not editors', async () => {
    await roster(['user_a', 'OWNER'], ['user_b', 'OWNER'], ['user_c', 'EDITOR']);

    expect(await withTenant(TENANT, (tx) => countOwners(tx), db)).toBe(2);
  });

  it('counts this winery only', async () => {
    // Under RLS the query needs no tenant predicate; this is the assertion that
    // the policy is what scopes it.
    await roster(['user_a', 'OWNER']);

    expect(await withTenant(TENANT, (tx) => countOwners(tx), db)).toBe(1);
  });
});
