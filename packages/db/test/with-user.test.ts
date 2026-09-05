import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/client.js';
import { readMembershipsForUser } from '../src/memberships.js';
import { withTenant, type DbTransaction } from '../src/with-tenant.js';
import { InvalidUserIdError, NestedUserContextError, withUser } from '../src/with-user.js';

/**
 * The user context, without a database (P0-47).
 *
 * What matters *here* is the mechanics: the guards fire, the GUC is set
 * transaction-locally, and the id is bound as a parameter rather than
 * interpolated. Whether the resulting context can actually read only the
 * caller's own membership rows is a property of the P0-37 policy and is
 * asserted against a real container in `with-user.integration.test.ts` — no
 * mock can answer that one.
 */

const TENANT = 'a0000000-0000-4000-8000-000000000001';

const createMockDb = () => {
  const statements: unknown[] = [];
  // Return type annotated rather than inferred: `Promise.resolve([])` infers
  // `never[]`, so a later test that resolves real rows cannot override it.
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve([]);
  });

  const tx = { execute } as unknown as DbTransaction;
  // Held as its own reference rather than reached for as `db.transaction`,
  // which `@typescript-eslint/unbound-method` flags — reasonably, since an
  // unbound method assertion is one refactor away from losing its `this`.
  const transaction = vi.fn((cb: (tx: DbTransaction) => Promise<unknown>) => cb(tx));
  const db = { transaction } as unknown as Database;

  return { db, tx, execute, transaction, statements };
};

const sqlOf = (statement: unknown): { sql: string; params: unknown[] } => {
  const query = new PgDialect().sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]);
  return { sql: query.sql, params: query.params };
};

describe('the guards', () => {
  it('refuses an empty or blank user id', async () => {
    const { db } = createMockDb();

    await expect(withUser('', () => Promise.resolve('ok'), db)).rejects.toBeInstanceOf(
      InvalidUserIdError,
    );
    await expect(withUser('   ', () => Promise.resolve('ok'), db)).rejects.toBeInstanceOf(
      InvalidUserIdError,
    );
  });

  it('refuses to open inside a tenant context', async () => {
    /*
     * With both GUCs set the `memberships` policy matches on either, so a read
     * that looked tenant-scoped would also return that user's rows in other
     * tenants. Nothing needs that, and an accidental nesting is far likelier to
     * be a bug than an intention.
     */
    const { db } = createMockDb();

    await expect(
      withTenant(TENANT, () => withUser('user_1', () => Promise.resolve('ok'), db), db),
    ).rejects.toBeInstanceOf(NestedUserContextError);
  });

  it('names the active tenant in the nesting error, so the cause is findable', async () => {
    const { db } = createMockDb();

    const error: unknown = await withTenant(
      TENANT,
      () => withUser('user_1', () => Promise.resolve('ok'), db),
      db,
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(TENANT);
  });

  it('does not open a transaction when a guard fires', async () => {
    // Fail before touching the database, not after: a rejected call should
    // cost nothing and leave no transaction to roll back.
    const { db, transaction } = createMockDb();

    await withUser('', () => Promise.resolve('ok'), db).catch(() => undefined);

    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('the statement it issues', () => {
  it('sets app.user_id transaction-locally', async () => {
    /*
     * `true` as the third argument is `SET LOCAL`. Without it the value
     * outlives the transaction and leaks onto whichever request borrows the
     * pooled connection next — the failure that never reproduces locally and is
     * unfalsifiable in production, which is why it is asserted on the SQL
     * rather than trusted to a comment.
     */
    const { db, statements } = createMockDb();

    await withUser('user_1', () => Promise.resolve('ok'), db);

    const { sql } = sqlOf(statements[0]);
    expect(sql).toContain("set_config('app.user_id'");
    expect(sql).toContain('true');
  });

  it('binds the id as a parameter rather than interpolating it', async () => {
    // A user id reaching `set_config` by string concatenation is SQL injection
    // into the RLS context itself — the one place it would be worst.
    const { db, statements } = createMockDb();

    await withUser("'; drop table memberships; --", () => Promise.resolve('ok'), db);

    const { sql, params } = sqlOf(statements[0]);
    expect(sql).not.toContain('drop table');
    expect(params).toContain("'; drop table memberships; --");
  });

  it('returns whatever the callback returns', async () => {
    const { db } = createMockDb();

    await expect(withUser('user_1', () => Promise.resolve(['a', 'b']), db)).resolves.toEqual([
      'a',
      'b',
    ]);
  });
});

describe('readMembershipsForUser', () => {
  it('selects tenant and role together, in one query', async () => {
    /*
     * The pairing is the security property. A second query for the role — or a
     * role cached per user — is how somebody who is EDITOR on one winery and
     * OWNER on another ends up with OWNER on both.
     */
    const { db, statements } = createMockDb();

    await readMembershipsForUser('user_1', db);

    // Two statements: the `set_config`, then the select.
    expect(statements).toHaveLength(2);
    const { sql } = sqlOf(statements[1]);
    expect(sql).toContain('tenant_id');
    expect(sql).toContain('role');
    expect(sql).toContain('from memberships');
  });

  it('filters by user as well, though RLS already does', async () => {
    // Belt and braces: if this clause went, the rows would be the same because
    // the policy scopes them; if the policy went, the integration suite fails.
    // Two independent reasons the answer is right.
    const { db, statements } = createMockDb();

    await readMembershipsForUser('user_1', db);

    expect(sqlOf(statements[1]).params).toContain('user_1');
  });

  it('maps snake_case columns onto the camelCase shape callers expect', async () => {
    const { db, execute } = createMockDb();
    execute.mockImplementation((statement: unknown) => {
      const { sql } = sqlOf(statement);
      return Promise.resolve(
        sql.includes('from memberships') ? [{ tenant_id: TENANT, role: 'EDITOR' }] : [],
      );
    });

    await expect(readMembershipsForUser('user_1', db)).resolves.toEqual([
      { tenantId: TENANT, role: 'EDITOR' },
    ]);
  });
});
