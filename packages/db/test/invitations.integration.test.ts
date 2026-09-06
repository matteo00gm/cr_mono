import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import {
  emailIsMember,
  insertInvitation,
  insertMembershipFromInvitation,
  markInvitationAccepted,
} from '../src/invitations.js';
import { readUserEmail } from '../src/users.js';
import { withInvitation } from '../src/with-invitation.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Invitations against real Postgres (P0-51).
 *
 * Three properties can only be asserted here, and each is the reason a piece of
 * the design looks the way it does:
 *
 * 1. **Acceptance reads the row with no membership**, which is what the token
 *    GUC exists for. A unit test cannot tell a working policy from an absent one.
 * 2. **The token is single-use under concurrency.** Two simultaneous
 *    acceptances must produce one membership, and that depends on `FOR UPDATE`
 *    doing what it claims.
 * 3. **RLS still isolates the table** for everything else: another tenant must
 *    not see an invitation, token or no token.
 */

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const IN_A_WEEK = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

/** Seeds a tenant and a user, as the migration role, outside RLS. */
const seed = async (): Promise<void> => {
  await db.execute(sql`
    INSERT INTO tenants (id, name, slug) VALUES
      (${TENANT_A}::uuid, 'Cantina Rossi', 'cantina-rossi'),
      (${TENANT_B}::uuid, 'Cantina Verdi', 'cantina-verdi')
    ON CONFLICT DO NOTHING
  `);

  await db.execute(sql`
    INSERT INTO auth_users (id, name, email) VALUES
      ('user_matteo', 'Matteo', 'matteo@cantina.example'),
      ('user_anna', 'Anna', 'anna@cantina.example'),
      ('user_mallory', 'Mallory', 'mallory@evil.example')
    ON CONFLICT DO NOTHING
  `);

  // The inviting OWNER, so `members:manage` has somebody to belong to.
  await withTenant(
    TENANT_A,
    async (tx) => {
      await tx.execute(sql`
      INSERT INTO memberships (tenant_id, user_id, role)
      VALUES (${TENANT_A}::uuid, 'user_matteo', 'OWNER')
      ON CONFLICT DO NOTHING
    `);
    },
    db,
  );
};

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 4 });
  db = client.db;
  await seed();
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

/** Creates an open invitation and returns its token hash. */
const invite = async (email: string, role = 'EDITOR', tenant = TENANT_A): Promise<string> => {
  const tokenHash = `hash_${email}_${String(Math.random()).slice(2)}`;

  await withTenant(
    tenant,
    async (tx) => {
      await insertInvitation(tx, {
        email,
        role,
        tokenHash,
        invitedBy: 'user_matteo',
        expiresAt: IN_A_WEEK(),
      });
    },
    db,
  );

  return tokenHash;
};

describe('accepting', () => {
  it('reads the invitation and writes the membership with no prior membership', async () => {
    /*
     * The circularity this design exists to break: the caller is not a member
     * of the tenant, so a tenant-scoped read returns nothing — and being a
     * member is what the request creates. Without the token GUC this test
     * cannot pass, and with an un-scoped connection it would pass while a
     * second table sat outside RLS.
     */
    const tokenHash = await invite('anna@cantina.example');

    const result = await withInvitation(
      tokenHash,
      async (tx, invitation) => {
        const email = await readUserEmail(tx, 'user_anna');
        expect(email).toBe('anna@cantina.example');
        expect(invitation.tenantId).toBe(TENANT_A);
        expect(invitation.role).toBe('EDITOR');

        await insertMembershipFromInvitation(tx, {
          tenantId: invitation.tenantId,
          userId: 'user_anna',
          role: invitation.role,
          invitedBy: invitation.invitedBy,
        });
        await markInvitationAccepted(tx, invitation.id);

        return invitation.tenantId;
      },
      db,
    );

    expect(result).toBe(TENANT_A);

    const rows = await withTenant(
      TENANT_A,
      (tx) => tx.execute(sql`SELECT role FROM memberships WHERE user_id = 'user_anna'`),
      db,
    );
    expect([...rows]).toHaveLength(1);
    expect(([...rows][0] as { role?: string }).role).toBe('EDITOR');
  });

  it('refuses a token that has already been redeemed', async () => {
    // The same token, a second time. `accepted_at` is set, so the filter in
    // `withInvitation` excludes the row and the callback never runs.
    const tokenHash = await invite('second@cantina.example');

    await withInvitation(
      tokenHash,
      (tx, invitation) => markInvitationAccepted(tx, invitation.id),
      db,
    );

    let ran = false;
    const outcome = await withInvitation(
      tokenHash,
      () => {
        ran = true;
        return Promise.resolve('should not happen');
      },
      db,
    );

    expect(outcome).toBeUndefined();
    expect(ran).toBe(false);
  });

  it('refuses an expired token', async () => {
    const tokenHash = 'hash_expired';
    await withTenant(
      TENANT_A,
      (tx) =>
        insertInvitation(tx, {
          email: 'late@cantina.example',
          role: 'EDITOR',
          tokenHash,
          invitedBy: 'user_matteo',
          expiresAt: new Date(Date.now() - 1000),
        }),
      db,
    );

    expect(await withInvitation(tokenHash, () => Promise.resolve('ran'), db)).toBeUndefined();
  });

  it('lets exactly one of two simultaneous acceptances through', async () => {
    /*
     * **The concurrency case, and the reason the row is taken `FOR UPDATE`.**
     * Two requests arriving together — a double-clicked link, or a mail client
     * prefetching it — would otherwise both read an open invitation and both
     * write a membership. The second is harmless here only because the
     * memberships unique constraint catches it; on a design where acceptance
     * granted something countable, it would not be.
     */
    const tokenHash = await invite('race@cantina.example');

    const attempt = () =>
      withInvitation(
        tokenHash,
        async (tx, invitation) => {
          await markInvitationAccepted(tx, invitation.id);
          return 'accepted';
        },
        db,
      );

    const results = await Promise.all([attempt(), attempt()]);

    expect(results.filter((result) => result === 'accepted')).toHaveLength(1);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
  });
});

describe('isolation', () => {
  it('hides an invitation from another tenant', async () => {
    const tokenHash = await invite('isolated@cantina.example');
    expect(tokenHash).toBeDefined();

    const rows = await withTenant(
      TENANT_B,
      (tx) => tx.execute(sql`SELECT id FROM invitations WHERE email = 'isolated@cantina.example'`),
      db,
    );

    // The token branch of the policy is an addition, not a replacement: a
    // tenant with no token still sees only its own rows.
    expect([...rows]).toHaveLength(0);
  });

  it('shows an invitation to its own tenant', async () => {
    // Guards the guard above: if the policy hid rows from *everyone*, the
    // isolation assertion would pass while the feature was broken.
    await invite('visible@cantina.example');

    const rows = await withTenant(
      TENANT_A,
      (tx) => tx.execute(sql`SELECT id FROM invitations WHERE email = 'visible@cantina.example'`),
      db,
    );

    expect([...rows]).toHaveLength(1);
  });

  it('refuses to create an invitation for another tenant', async () => {
    /*
     * The WITH CHECK half. `insertInvitation` takes the tenant from
     * `app.tenant_id` rather than from an argument, so this asserts the policy
     * rather than the statement: an INSERT naming another tenant is rejected by
     * Postgres, not by our SQL.
     */
    await expect(
      withTenant(
        TENANT_A,
        (tx) =>
          tx.execute(sql`
            INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
            VALUES (${TENANT_B}::uuid, 'x@y.example', 'OWNER', 'hash_cross', 'user_mallory', now() + interval '1 day')
          `),
        db,
      ),
    ).rejects.toThrow();
  });
});

describe('re-inviting', () => {
  it('is a no-op while an invitation is open', async () => {
    const email = 'repeat@cantina.example';
    await invite(email);

    const second = await withTenant(
      TENANT_A,
      (tx) =>
        insertInvitation(tx, {
          email,
          role: 'OWNER',
          tokenHash: 'hash_repeat_second',
          invitedBy: 'user_matteo',
          expiresAt: IN_A_WEEK(),
        }),
      db,
    );

    /*
     * `undefined`, so the caller does not send a second email. Two live tokens
     * for one seat is the failure being prevented: revoking the invitation
     * leaves the other one working, and nobody remembers there were two.
     */
    expect(second).toBeUndefined();

    const rows = await withTenant(
      TENANT_A,
      (tx) => tx.execute(sql`SELECT id FROM invitations WHERE email = ${email}`),
      db,
    );
    expect([...rows]).toHaveLength(1);
  });

  it('is allowed again once the first is revoked', async () => {
    // The partial index is on *open* rows, so a genuine re-invite after a
    // revocation works — which is what an owner does when somebody says the
    // link stopped working.
    const email = 'revoked@cantina.example';
    await invite(email);

    await withTenant(
      TENANT_A,
      (tx) => tx.execute(sql`UPDATE invitations SET revoked_at = now() WHERE email = ${email}`),
      db,
    );

    const second = await withTenant(
      TENANT_A,
      (tx) =>
        insertInvitation(tx, {
          email,
          role: 'EDITOR',
          tokenHash: 'hash_after_revoke',
          invitedBy: 'user_matteo',
          expiresAt: IN_A_WEEK(),
        }),
      db,
    );

    expect(second).toBeDefined();
  });
});

describe('emailIsMember', () => {
  it('sees a member of this tenant and not of another', async () => {
    await withTenant(
      TENANT_B,
      (tx) =>
        tx.execute(sql`
          INSERT INTO memberships (tenant_id, user_id, role)
          VALUES (${TENANT_B}::uuid, 'user_mallory', 'OWNER')
          ON CONFLICT DO NOTHING
        `),
      db,
    );

    await withTenant(
      TENANT_A,
      async (tx) => {
        expect(await emailIsMember(tx, 'matteo@cantina.example')).toBe(true);
        // In tenant B, not A. The join has no tenant predicate of its own — RLS
        // on `memberships` is what scopes it, and this is that assertion.
        expect(await emailIsMember(tx, 'mallory@evil.example')).toBe(false);
      },
      db,
    );
  });
});
