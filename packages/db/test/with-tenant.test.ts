import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/client.js';
import {
  type DbTransaction,
  getCurrentTenantId,
  InvalidTenantIdError,
  NestedTenantContextError,
  withTenant,
} from '../src/with-tenant.js';

const VALID_UUID_A = 'a0000000-0000-4000-8000-000000000001';
const VALID_UUID_B = 'b0000000-0000-4000-8000-000000000002';

const createMockDb = () => {
  const executedStatements: unknown[] = [];
  const executeSpy = vi.fn((sqlStatement: unknown) => {
    executedStatements.push(sqlStatement);
    return Promise.resolve();
  });

  const mockTx = {
    execute: executeSpy,
  } as unknown as DbTransaction;

  const mockDb: Database = {
    transaction: vi.fn(async (cb: (tx: DbTransaction) => Promise<unknown>) => {
      return cb(mockTx);
    }),
  } as unknown as Database;

  return { mockDb, mockTx, executeSpy, executedStatements };
};

describe('withTenant RLS transaction helper (P0-19)', () => {
  it('rejects empty or non-UUID tenant IDs fail-closed', async () => {
    const { mockDb } = createMockDb();

    await expect(withTenant('', () => Promise.resolve('ok'), mockDb)).rejects.toBeInstanceOf(
      InvalidTenantIdError,
    );
    await expect(
      withTenant('not-a-uuid', () => Promise.resolve('ok'), mockDb),
    ).rejects.toBeInstanceOf(InvalidTenantIdError);
    await expect(
      withTenant('12345678-1234-1234-1234-12345678901z', () => Promise.resolve('ok'), mockDb),
    ).rejects.toBeInstanceOf(InvalidTenantIdError);
    // Right characters, wrong shape: no grouping, so `set_config` would take a
    // value the policy's ::uuid cast then rejects at query time instead.
    await expect(
      withTenant('a0000000000040008000000000000001', () => Promise.resolve('ok'), mockDb),
    ).rejects.toBeInstanceOf(InvalidTenantIdError);
  });

  it('accepts a well-formed UUID of any version', async () => {
    // Validation is on shape, not on the version nibble. A v7 id — time-ordered,
    // the sensible choice if these keys ever move off gen_random_uuid() for
    // index locality — must not be rejected by a helper that has no business
    // caring how the database generated it.
    const { mockDb } = createMockDb();
    const v7 = '01935b3e-7c00-7000-8000-0000000000ff';

    await expect(withTenant(v7, () => Promise.resolve('ok'), mockDb)).resolves.toBe('ok');
  });

  it('sets transaction-local app.tenant_id and executes callback', async () => {
    const { mockDb, mockTx, executeSpy } = createMockDb();

    const result = await withTenant(
      VALID_UUID_A,
      (tx) => {
        expect(tx).toBe(mockTx);
        expect(getCurrentTenantId()).toBe(VALID_UUID_A);
        return Promise.resolve('success');
      },
      mockDb,
    );

    expect(result).toBe('success');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(getCurrentTenantId()).toBeUndefined();
  });

  it('emits set_config with is_local=true and the id as a bound parameter', () => {
    // The guarantee this whole helper exists for, asserted on the actual SQL.
    // Counting execute() calls cannot see it: flip the third argument to false
    // and tenant context survives the transaction on a pooled connection,
    // leaking into whichever request borrows that connection next — while
    // every other test in this file still passes.
    const { mockDb, executedStatements } = createMockDb();

    return withTenant(VALID_UUID_A, () => Promise.resolve(null), mockDb).then(() => {
      const [statement] = executedStatements;
      const { sql: text, params } = new PgDialect().sqlToQuery(statement as never);

      expect(text).toBe("SELECT set_config('app.tenant_id', $1, true)");
      // Bound, not interpolated: a tenant id is attacker-influenced input in
      // any endpoint that accepts one.
      expect(params).toEqual([VALID_UUID_A]);
    });
  });

  it('sets the tenant context before running the callback, not after', async () => {
    // Ordering is load-bearing: RLS reads app.tenant_id at statement time, so
    // a callback that runs before set_config sees no tenant context at all.
    const order: string[] = [];
    const mockTx = {
      execute: vi.fn(() => {
        order.push('set_config');
        return Promise.resolve();
      }),
    } as unknown as DbTransaction;
    const mockDb = {
      transaction: vi.fn((cb: (tx: DbTransaction) => Promise<unknown>) => cb(mockTx)),
    } as unknown as Database;

    await withTenant(
      VALID_UUID_A,
      () => {
        order.push('callback');
        return Promise.resolve(null);
      },
      mockDb,
    );

    expect(order).toEqual(['set_config', 'callback']);
  });

  it('detects and rejects nested withTenant calls to prevent context poisoning', async () => {
    const { mockDb } = createMockDb();

    await expect(
      withTenant(
        VALID_UUID_A,
        () => {
          return withTenant(VALID_UUID_B, () => Promise.resolve('nested'), mockDb);
        },
        mockDb,
      ),
    ).rejects.toBeInstanceOf(NestedTenantContextError);

    expect(getCurrentTenantId()).toBeUndefined();
  });

  it('clears active tenant context even if callback throws', async () => {
    const { mockDb } = createMockDb();

    await expect(
      withTenant(
        VALID_UUID_A,
        () => {
          return Promise.reject(new Error('Database operation failed'));
        },
        mockDb,
      ),
    ).rejects.toThrow('Database operation failed');

    expect(getCurrentTenantId()).toBeUndefined();
  });

  it('supports concurrent tenant contexts independently without interference', async () => {
    const { mockDb } = createMockDb();

    const taskA = withTenant(
      VALID_UUID_A,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return getCurrentTenantId();
      },
      mockDb,
    );

    const taskB = withTenant(
      VALID_UUID_B,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getCurrentTenantId();
      },
      mockDb,
    );

    const [tenantA, tenantB] = await Promise.all([taskA, taskB]);
    expect(tenantA).toBe(VALID_UUID_A);
    expect(tenantB).toBe(VALID_UUID_B);
  });
});
