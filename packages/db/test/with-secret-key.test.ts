import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/client.js';
import {
  InvalidSecretKeyScopeError,
  NestedSecretKeyContextError,
  resolveTenantBySecretKey,
  SECRET_KEY_GUC,
} from '../src/with-secret-key.js';
import { withTenant, type DbTransaction } from '../src/with-tenant.js';

/**
 * The secret-key scope, without a database (P4-10).
 *
 * The mechanics only: the guards fire before a transaction opens, it is opened
 * read-only, the hash is bound rather than spliced, and the hand-over clears the
 * secret value in the same statement that sets the tenant. What the policy then
 * admits is asserted against real Postgres in `with-secret-key.integration`.
 */

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

const createMockDb = (results: unknown[][] = []) => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve(results.shift() ?? []);
  });

  const tx = { execute } as unknown as DbTransaction;
  const transaction = vi.fn<
    (cb: (tx: DbTransaction) => Promise<unknown>, config?: unknown) => Promise<unknown>
  >((cb) => cb(tx));
  const db = { transaction } as unknown as Database;

  return { db, statements, transaction };
};

const sqlOf = (statement: unknown): { sql: string; params: unknown[] } => {
  const query = new PgDialect().sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]);
  return { sql: query.sql, params: query.params };
};

/** The four reads of a successful resolution, in order. */
const found = (): unknown[][] => [
  [],
  [{ tenant_id: TENANT }],
  [],
  [{ status: 'ACTIVE', plan: 'ECOMMERCE', locale: 'it' }],
  [{ origin: 'https://a.example' }, { origin: 'https://b.example' }],
];

describe('the guards', () => {
  it.each(['', '   '])('refuses a hash of %j before opening anything', async (hash) => {
    const { db, transaction } = createMockDb();

    await expect(resolveTenantBySecretKey(hash, db)).rejects.toBeInstanceOf(
      InvalidSecretKeyScopeError,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses to open inside a tenant context, and names the tenant', async () => {
    const { db, transaction } = createMockDb();

    const error: unknown = await withTenant(
      TENANT,
      () => resolveTenantBySecretKey(HASH, db),
      db,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NestedSecretKeyContextError);
    expect((error as Error).message).toContain(TENANT);
    // withTenant's own transaction, and no second one.
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe('the transaction it opens', () => {
  it('is read-only', async () => {
    /* The path is driven by an unauthenticated caller until the key verifies,
     * and the WITH CHECK beneath it should never be the only thing in the way. */
    const { db, transaction } = createMockDb();

    await resolveTenantBySecretKey(HASH, db);

    expect(transaction.mock.calls[0]?.[1]).toEqual({ accessMode: 'read only' });
  });

  it('sets the hash transaction-locally, as a bound parameter', async () => {
    const { db, statements } = createMockDb();
    const hostile = "'; select set_config('app.tenant_id', 'x', false); --";

    await resolveTenantBySecretKey(hostile, db);

    const { sql, params } = sqlOf(statements[0]);

    expect(sql).toMatch(/set_config\(\$1, \$2, true\)/u);
    expect(params).toEqual([SECRET_KEY_GUC, hostile]);
  });

  it('asks only for an active row', async () => {
    const { db, statements } = createMockDb();

    await resolveTenantBySecretKey(HASH, db);

    expect(sqlOf(statements[1]).sql).toMatch(/revoked_at IS NULL/u);
  });

  it('stops after the key lookup when nothing matches', async () => {
    const { db, statements } = createMockDb();

    await expect(resolveTenantBySecretKey(HASH, db)).resolves.toBeUndefined();
    expect(statements).toHaveLength(2);
  });
});

describe('the hand-over', () => {
  it('clears the secret and sets the tenant in one statement, both locally', async () => {
    /*
     * One statement, so the widened branch and a tenant context are never open
     * at the same time; both local, so neither outlives the transaction.
     */
    const { db, statements } = createMockDb(found());

    await resolveTenantBySecretKey(HASH, db);

    const { sql, params } = sqlOf(statements[2]);

    expect(sql.match(/set_config\([^)]*, true\)/gu)).toHaveLength(2);
    expect(sql).toMatch(/set_config\(\$1, '', true\), set_config\('app\.tenant_id', \$2, true\)/u);
    expect(params).toEqual([SECRET_KEY_GUC, TENANT]);
  });

  it('reads only verified origins once it is a tenant', async () => {
    const { db, statements } = createMockDb(found());

    await resolveTenantBySecretKey(HASH, db);

    expect(sqlOf(statements[4]).sql).toMatch(/status = 'VERIFIED'/u);
  });

  it('returns what the mint needs', async () => {
    const { db } = createMockDb(found());

    await expect(resolveTenantBySecretKey(HASH, db)).resolves.toEqual({
      tenantId: TENANT,
      status: 'ACTIVE',
      plan: 'ECOMMERCE',
      locale: 'it',
      verifiedOrigins: ['https://a.example', 'https://b.example'],
    });
  });

  it('returns nothing when the tenant row is not visible', async () => {
    /* A key row whose tenant cannot be read is not a tenant we can mint for. */
    const { db } = createMockDb([[], [{ tenant_id: TENANT }], [], []]);

    await expect(resolveTenantBySecretKey(HASH, db)).resolves.toBeUndefined();
  });
});
