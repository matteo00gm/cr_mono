import { describe, expect, it, vi } from 'vitest';

import {
  emailIsMember,
  insertInvitation,
  insertMembershipFromInvitation,
  markInvitationAccepted,
  readActiveTenantName,
  readOpenInvitations,
  revokeInvitation,
} from '../src/invitations.js';
import { readUserEmail } from '../src/users.js';
import { withInvitation } from '../src/with-invitation.js';
import type { Database } from '../src/client.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The invitation statements, without a database (P0-51).
 *
 * Shapes only: which values a statement binds, and which branch a result takes.
 * Whether the token is single-use under concurrency, and whether RLS lets the
 * acceptance path read a row it has no membership for, are properties of
 * Postgres — asserted against a real one in
 * `invitations.integration.test.ts`.
 */

/** Captures statements and answers with whatever rows the test supplies. */
const capturing = (...responses: unknown[][]) => {
  const statements: unknown[] = [];
  let call = 0;
  // Held as its own reference rather than reached for as `tx.execute`, which
  // `unbound-method` flags.
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    const rows = responses[call] ?? [];
    call += 1;
    return Promise.resolve(rows);
  });

  return { statements, execute, tx: { execute } as unknown as DbTransaction };
};

/** See `email-suppressions.test.ts` — `queryChunks` interleaves literals and values. */
const params = (statement: unknown): unknown[] =>
  ((statement as { queryChunks?: unknown[] }).queryChunks ?? []).filter(
    (chunk) =>
      !(
        typeof chunk === 'object' &&
        chunk !== null &&
        Array.isArray((chunk as { value?: unknown }).value)
      ),
  );

const text = (statement: unknown): string =>
  ((statement as { queryChunks?: unknown[] }).queryChunks ?? [])
    .flatMap((chunk) =>
      typeof chunk === 'object' &&
      chunk !== null &&
      Array.isArray((chunk as { value?: unknown[] }).value)
        ? ((chunk as { value: unknown[] }).value as string[])
        : [],
    )
    .join(' ');

describe('insertInvitation', () => {
  const invitation = {
    email: 'anna@cantina.example',
    role: 'EDITOR',
    tokenHash: 'deadbeef',
    invitedBy: 'user_matteo',
    expiresAt: new Date('2026-09-13T00:00:00.000Z'),
  };

  it('takes the tenant from the RLS context, not from an argument', async () => {
    const { tx, statements } = capturing([{ id: 'inv_1' }]);
    await insertInvitation(tx, invitation);

    /*
     * The P0-48 invariant, expressed in SQL. There is no `tenantId` parameter
     * to get wrong, because the value is read from `app.tenant_id` — which only
     * `withTenant` sets, from a memberships row.
     */
    expect(text(statements[0])).toContain("current_setting('app.tenant_id'");
    expect(params(statements[0])).not.toContain('11111111-1111-1111-1111-111111111111');
  });

  it('returns the new id', async () => {
    const { tx } = capturing([{ id: 'inv_1' }]);
    expect(await insertInvitation(tx, invitation)).toBe('inv_1');
  });

  it('returns undefined when the conflict clause suppressed the insert', async () => {
    // `RETURNING` yields no row when `DO NOTHING` fired. That is how the caller
    // learns not to send a second email — the re-invite no-op the row asks for.
    const { tx } = capturing([]);
    expect(await insertInvitation(tx, invitation)).toBeUndefined();
  });

  it('binds the expiry as a string, never as a Date', async () => {
    /*
     * postgres-js binds prepared-statement parameters as text and throws
     * `ERR_INVALID_ARG_TYPE` when a `Date` reaches it through a raw `sql`
     * template — drizzle's query builder converts one, its `sql` tag does not.
     *
     * The throw happens at bind time against a real connection, so the fake
     * transaction in this file cannot reproduce it; CI found it. What *can* be
     * asserted here is the property that avoids it, which is enough to stop the
     * next author reverting the `toISOString()` as noise.
     */
    const { tx, statements } = capturing([{ id: 'inv_1' }]);
    await insertInvitation(tx, invitation);

    for (const bound of params(statements[0])) {
      expect(bound).not.toBeInstanceOf(Date);
    }
    expect(params(statements[0])).toContain('2026-09-13T00:00:00.000Z');
  });

  it('conflicts only on rows that are still open', async () => {
    const { tx, statements } = capturing([{ id: 'inv_1' }]);
    await insertInvitation(tx, invitation);

    // A partial target, so a fresh invitation after a revocation or an expiry
    // still succeeds — which is what an owner does when a link stopped working.
    expect(text(statements[0])).toContain('accepted_at IS NULL AND revoked_at IS NULL');
  });
});

describe('emailIsMember', () => {
  it('is true when the join returns a row', async () => {
    const { tx } = capturing([{ '?column?': 1 }]);
    expect(await emailIsMember(tx, 'matteo@cantina.example')).toBe(true);
  });

  it('is false when it does not', async () => {
    const { tx } = capturing([]);
    expect(await emailIsMember(tx, 'stranger@example.com')).toBe(false);
  });

  it('has no tenant predicate, because RLS is the predicate', async () => {
    const { tx, statements } = capturing([]);
    await emailIsMember(tx, 'matteo@cantina.example');

    /*
     * Deliberate, and asserted so it is not "fixed" later. `memberships` is the
     * scoped side of the join; adding a redundant `tenant_id =` here would
     * suggest the isolation comes from the query rather than from the policy,
     * which is the wrong lesson for the next person to copy.
     */
    expect(text(statements[0])).not.toContain('tenant_id');
    expect(text(statements[0])).toContain('JOIN auth_users');
  });
});

describe('insertMembershipFromInvitation', () => {
  it('binds the role it was given and nothing from a request', async () => {
    const { tx, statements } = capturing([]);
    await insertMembershipFromInvitation(tx, {
      tenantId: '11111111-1111-1111-1111-111111111111',
      userId: 'user_anna',
      role: 'EDITOR',
      invitedBy: 'user_matteo',
    });

    expect(params(statements[0])).toEqual([
      '11111111-1111-1111-1111-111111111111',
      'user_anna',
      'EDITOR',
      'user_matteo',
    ]);
  });

  it('leaves an existing membership alone', async () => {
    const { tx, statements } = capturing([]);
    await insertMembershipFromInvitation(tx, {
      tenantId: '11111111-1111-1111-1111-111111111111',
      userId: 'user_anna',
      role: 'OWNER',
      invitedBy: 'user_matteo',
    });

    // Accepting a second invitation to a winery you already belong to must not
    // silently change the role you have — in either direction.
    expect(text(statements[0])).toContain('ON CONFLICT (tenant_id, user_id) DO NOTHING');
  });
});

describe('the small reads', () => {
  it('marks an invitation accepted by id', async () => {
    const { tx, statements } = capturing([]);
    await markInvitationAccepted(tx, 'inv_1');

    expect(params(statements[0])).toEqual(['inv_1']);
  });

  it('reads the one visible tenant with no WHERE clause', async () => {
    const { tx, statements } = capturing([{ name: 'Cantina Rossi' }]);

    expect(await readActiveTenantName(tx)).toBe('Cantina Rossi');
    // `tenants`' policy is `id = app.tenant_id`, so inside withTenant this table
    // holds exactly one visible row. A predicate here would imply otherwise.
    expect(text(statements[0])).not.toContain('WHERE');
  });

  it('reports a missing user as undefined rather than empty string', async () => {
    // A session for an account deleted between sign-in and now. The acceptance
    // path treats that as a bad token, and it can only do so if this is
    // distinguishable from an address.
    const { tx } = capturing([]);
    expect(await readUserEmail(tx, 'user_ghost')).toBeUndefined();
  });
});

describe('withInvitation', () => {
  /** A database whose single transaction hands back canned rows. */
  const fakeDb = (...responses: unknown[][]) => {
    const captured = capturing(...responses);
    const transaction = vi.fn((fn: (tx: DbTransaction) => Promise<unknown>) => fn(captured.tx));

    return { ...captured, db: { transaction } as unknown as Database };
  };

  const row = {
    id: 'inv_1',
    tenant_id: '11111111-1111-1111-1111-111111111111',
    email: 'anna@cantina.example',
    role: 'EDITOR',
    invited_by: 'user_matteo',
    expires_at: new Date('2026-09-13T00:00:00.000Z'),
  };

  it('sets the token scope before reading, and the tenant from the row after', async () => {
    const { db, statements } = fakeDb([], [row], []);

    const seen = await withInvitation(
      'deadbeef',
      (_tx, invitation) => Promise.resolve(invitation),
      db,
    );

    expect(seen?.tenantId).toBe('11111111-1111-1111-1111-111111111111');

    /*
     * The ordering is the design. The token GUC is set first, because the
     * policy on `invitations` is what lets the row be read at all with no
     * membership; the tenant GUC is set *from that row*, so the membership
     * write that follows is scoped by a value Postgres produced rather than one
     * the request supplied.
     */
    expect(text(statements[0])).toContain("set_config('app.invitation_token'");
    expect(text(statements[1])).toContain('FOR UPDATE');
    expect(text(statements[2])).toContain("set_config('app.tenant_id'");
    expect(params(statements[2])).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('makes every setting transaction-local', async () => {
    const { db, statements } = fakeDb([], [row], []);
    await withInvitation('deadbeef', () => Promise.resolve('ran'), db);

    /*
     * Without the third `true`, the setting outlives the transaction on a
     * pooled connection and the next request inherits somebody else's scope.
     * Asserted on the SQL rather than on the bound parameters because the flag
     * is a literal in the statement, not a value passed in — which is itself
     * the safer arrangement: it cannot be turned off by a caller.
     */
    for (const index of [0, 2]) {
      expect(text(statements[index]), String(index)).toContain(', true)');
    }
  });

  it('does not run the callback when the token matches nothing', async () => {
    const { db } = fakeDb([], []);
    let ran = false;

    const outcome = await withInvitation(
      'nope',
      () => {
        ran = true;
        return Promise.resolve('should not happen');
      },
      db,
    );

    /*
     * `undefined` for every unusable token — unknown, expired, revoked, already
     * redeemed — because the endpoint answers all of them alike. Distinguishing
     * them would make this an oracle for which invitations exist.
     */
    expect(outcome).toBeUndefined();
    expect(ran).toBe(false);
  });

  it('excludes spent, revoked and expired rows in the query itself', async () => {
    const { db, statements } = fakeDb([], []);
    await withInvitation('deadbeef', () => Promise.resolve('ran'), db);

    const query = text(statements[1]);
    expect(query).toContain('accepted_at IS NULL');
    expect(query).toContain('revoked_at IS NULL');
    expect(query).toContain('expires_at > now()');
  });
});

describe('readOpenInvitations (E8)', () => {
  it('selects only the columns a screen may see', async () => {
    const { tx, statements } = capturing([]);
    await readOpenInvitations(tx);

    const sql = text(statements[0]);

    /*
     * `token_hash` is absent, and that is the assertion worth having: the hash
     * is what the credential reduces to, and a list endpoint returning it hands
     * anyone with `members:manage` material to attack offline — for no gain
     * over revoking and re-inviting.
     */
    expect(sql).not.toContain('token_hash');
    expect(sql).toContain('email');
    expect(sql).toContain('expires_at');
  });

  it('lists open invitations only', async () => {
    const { tx, statements } = capturing([]);
    await readOpenInvitations(tx);

    // Accepted and revoked rows are history. A screen listing them shows an
    // owner a growing set of things they cannot act on.
    expect(text(statements[0])).toContain('accepted_at IS NULL AND revoked_at IS NULL');
  });

  it('maps snake_case columns to the shape the API returns', async () => {
    const { tx } = capturing([
      {
        id: 'inv_1',
        email: 'anna@cantina.example',
        role: 'EDITOR',
        invited_by: 'user_matteo',
        expires_at: new Date('2026-09-14T00:00:00.000Z'),
        created_at: new Date('2026-09-07T00:00:00.000Z'),
      },
    ]);

    expect((await readOpenInvitations(tx))[0]).toEqual({
      id: 'inv_1',
      email: 'anna@cantina.example',
      role: 'EDITOR',
      invitedBy: 'user_matteo',
      expiresAt: new Date('2026-09-14T00:00:00.000Z'),
      createdAt: new Date('2026-09-07T00:00:00.000Z'),
    });
  });
});

describe('revokeInvitation (E8)', () => {
  it('stamps rather than deletes, and only an open row', async () => {
    const { tx, statements } = capturing([{ email: 'anna@cantina.example' }]);
    await revokeInvitation(tx, 'inv_1');

    const sql = text(statements[0]);

    /*
     * Stamping keeps the fact that an invitation was sent and withdrawn, which
     * a members screen may never show and an incident review will want — and
     * the partial unique index covers open rows only, so a stamped row does not
     * block a fresh invitation to the same address.
     */
    expect(sql).toContain('SET revoked_at = now()');
    expect(sql).not.toContain('DELETE');
    expect(sql).toContain('accepted_at IS NULL AND revoked_at IS NULL');
  });

  it('returns the address, so the audit row needs no second read', async () => {
    const { tx } = capturing([{ email: 'anna@cantina.example' }]);

    expect(await revokeInvitation(tx, 'inv_1')).toBe('anna@cantina.example');
  });

  it('returns undefined when nothing matched', async () => {
    // Already accepted, already revoked, or absent. The caller turns all three
    // into one 404 rather than pretending success.
    const { tx } = capturing([]);

    expect(await revokeInvitation(tx, 'inv_gone')).toBeUndefined();
  });
});
