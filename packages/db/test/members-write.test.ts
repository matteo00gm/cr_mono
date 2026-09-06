import { describe, expect, it, vi } from 'vitest';

import { countOwners, removeMember, setMemberRole } from '../src/members-write.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The membership writes, without a database (P0-52).
 *
 * Shapes and branches only. **Whether the lock actually serialises two
 * concurrent demotions is the whole point of the row, and it cannot be asserted
 * here** — a fake transaction executes statements in order by construction, so
 * a missing `FOR UPDATE` would look identical to a correct one. That lives in
 * `last-owner.integration.test.ts`, against two real connections.
 *
 * What is worth asserting here is that the guard is *in the statement*. A
 * caller cannot skip it, and this is the test that fails if somebody later
 * splits it into a helper.
 */

const capturing = (...responses: unknown[][]) => {
  const statements: unknown[] = [];
  let call = 0;
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    const rows = responses[call] ?? [];
    call += 1;
    return Promise.resolve(rows);
  });

  return { statements, execute, tx: { execute } as unknown as DbTransaction };
};

/** The literal SQL of a statement, with its bound values elided. */
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

/** lock, exists, write — the three statements each write issues, in order. */
const LOCK = 0;
const WRITE = 2;

describe('the lock', () => {
  it('covers the whole roster, in a stable order', async () => {
    const { tx, statements } = capturing([], [{ '?column?': 1 }], [{ user_id: 'user_a' }]);
    await setMemberRole(tx, { userId: 'user_a', role: 'EDITOR' });

    const lock = text(statements[LOCK]);

    /*
     * The *set*, not the target row. The decision depends on whether another
     * owner exists, so locking only the row being changed leaves that other
     * owner free to disappear underneath the decision.
     */
    expect(lock).toContain('FOR UPDATE');
    expect(lock).toContain('FROM memberships');
    expect(lock).not.toContain('user_id =');

    // Two transactions locking the same rows in different orders deadlock;
    // Postgres locks in the order rows are returned, so this makes the second
    // one wait instead of failing.
    expect(lock).toContain('ORDER BY user_id');
  });

  it('is taken before anything is read or written', async () => {
    const { tx, statements } = capturing([], [{ '?column?': 1 }], [{ user_id: 'user_a' }]);
    await removeMember(tx, { userId: 'user_a' });

    // A lock taken after the deciding read is not a lock, it is a delay.
    expect(text(statements[0])).toContain('FOR UPDATE');
    expect(statements).toHaveLength(3);
  });
});

describe('setMemberRole', () => {
  const change = { userId: 'user_a', role: 'EDITOR' } as const;

  it('carries the guard in the UPDATE itself', async () => {
    const { tx, statements } = capturing([], [{ '?column?': 1 }], [{ user_id: 'user_a' }]);
    await setMemberRole(tx, change);

    const write = text(statements[WRITE]);

    /*
     * The assertion that stops the guard being refactored into a helper the
     * next handler forgets to call. There is no way to perform this write
     * without the condition, because the condition is part of it.
     */
    expect(write).toContain('UPDATE memberships');
    expect(write).toContain("role <> 'OWNER'");
    expect(write).toContain('EXISTS');
    expect(write).toContain("other.role = 'OWNER'");
  });

  it('reports a changed row', async () => {
    const { tx } = capturing([], [{ '?column?': 1 }], [{ user_id: 'user_a' }]);
    expect(await setMemberRole(tx, change)).toBe('changed');
  });

  it('reports a refusal when the guard matched no row', async () => {
    // The member exists, so this is the guard firing rather than a missing
    // target — the distinction the caller turns into 409 versus 404.
    const { tx } = capturing([], [{ '?column?': 1 }], []);
    expect(await setMemberRole(tx, change)).toBe('would-remove-last-owner');
  });

  it('reports a missing member without attempting the write', async () => {
    const { tx, statements } = capturing([], []);

    expect(await setMemberRole(tx, change)).toBe('no-such-member');
    // Two statements, not three: nothing was written.
    expect(statements).toHaveLength(2);
  });

  it('names no tenant, because RLS is what scopes it', async () => {
    const { tx, statements } = capturing([], [{ '?column?': 1 }], [{ user_id: 'user_a' }]);
    await setMemberRole(tx, change);

    // `memberships` is under a policy, so `WHERE user_id =` inside withTenant
    // reaches exactly this tenant's row. A tenant predicate here would be a
    // second source of truth for something the policy already decides.
    expect(text(statements[WRITE])).not.toContain('tenant_id');
  });
});

describe('removeMember', () => {
  it('carries the guard in the DELETE itself', async () => {
    const { tx, statements } = capturing([], [{ '?column?': 1 }], [{ user_id: 'user_a' }]);
    await removeMember(tx, { userId: 'user_a' });

    const write = text(statements[WRITE]);
    expect(write).toContain('DELETE FROM memberships');
    expect(write).toContain("role <> 'OWNER'");
    expect(write).toContain('EXISTS');
  });

  it('reports each outcome', async () => {
    expect(
      await removeMember(capturing([], [{ '?column?': 1 }], [{ user_id: 'a' }]).tx, {
        userId: 'user_a',
      }),
    ).toBe('changed');

    expect(
      await removeMember(capturing([], [{ '?column?': 1 }], []).tx, { userId: 'user_a' }),
    ).toBe('would-remove-last-owner');

    expect(await removeMember(capturing([], []).tx, { userId: 'user_a' })).toBe('no-such-member');
  });
});

describe('countOwners', () => {
  it('returns the count', async () => {
    const { tx } = capturing([{ owners: 3 }]);
    expect(await countOwners(tx)).toBe(3);
  });

  it('returns zero rather than undefined when the query answers nothing', async () => {
    // `count(*)` always returns a row, so this is defensive — and it is the
    // difference between the dashboard greying out a control and rendering
    // "undefined owners".
    const { tx } = capturing([]);
    expect(await countOwners(tx)).toBe(0);
  });
});
