import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/client.js';
import { withTenant, type DbTransaction } from '../src/with-tenant.js';
import {
  InvalidWidgetScopeError,
  NestedWidgetContextError,
  withWidgetKey,
} from '../src/with-widget-key.js';

/**
 * The widget's resolution scope, without a database (P2-07).
 *
 * The mechanics only: the guards fire, the transaction is opened read-only, and
 * both values are set transaction-locally as bound parameters. What the policies
 * then admit is a property of Postgres and is asserted against a real one in
 * `widget-resolution.integration.test.ts`.
 */

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const KEY = ['pk', 'test', 'resolution0001'].join('_');
const ORIGIN = 'https://cantina.example';

const createMockDb = () => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve([]);
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

describe('the guards', () => {
  it.each([
    ['', ORIGIN],
    ['   ', ORIGIN],
    [KEY, ''],
    [KEY, '  '],
  ])('refuses a key of %j with an origin of %j', async (key, origin) => {
    const { db } = createMockDb();

    // Empty matches no row, and would come back looking like an unknown key.
    await expect(
      withWidgetKey(key, origin, () => Promise.resolve('ok'), db),
    ).rejects.toBeInstanceOf(InvalidWidgetScopeError);
  });

  it('refuses to open inside a tenant context, and names the tenant', async () => {
    /*
     * With app.tenant_id set as well, each policy's tenant branch and widget
     * branch are OR-ed, so a read that looked tenant-scoped could also see
     * another tenant's key, domain and tenant row.
     */
    const { db } = createMockDb();

    const error: unknown = await withTenant(
      TENANT,
      () => withWidgetKey(KEY, ORIGIN, () => Promise.resolve('ok'), db),
      db,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NestedWidgetContextError);
    expect((error as Error).message).toContain(TENANT);
  });

  it('opens no transaction when a guard fires', async () => {
    const { db, transaction } = createMockDb();

    await withWidgetKey('', ORIGIN, () => Promise.resolve('ok'), db).catch(() => undefined);

    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('the transaction it opens', () => {
  it('is read-only, so nothing a policy admits can be written', async () => {
    /*
     * The bound ADR 0022 rests on. A DELETE is filtered by USING alone, so under
     * an admitting branch it would match the admitted rows — and tenant_domains
     * cannot have DELETE revoked, because removing a domain is a real operation.
     */
    const { db, transaction } = createMockDb();

    await withWidgetKey(KEY, ORIGIN, () => Promise.resolve('ok'), db);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]?.[1]).toEqual({ accessMode: 'read only' });
  });

  it('sets both values transaction-locally, as bound parameters', async () => {
    const { db, statements } = createMockDb();
    const hostile = "'; set_config('app.tenant_id', 'x', false); --";

    await withWidgetKey(hostile, ORIGIN, () => Promise.resolve('ok'), db);

    const { sql, params } = sqlOf(statements[0]);

    // `true` is SET LOCAL: without it the values outlive the transaction on a
    // pooled connection, and the next request inherits the widget scope.
    expect(sql.match(/set_config\(\$\d+, \$\d+, true\)/g)).toHaveLength(2);
    expect(sql).not.toContain('app.tenant_id');
    expect(params).toEqual(['app.widget_key', hostile, 'app.widget_origin', ORIGIN]);
  });

  it('returns whatever the callback returns', async () => {
    const { db } = createMockDb();

    await expect(withWidgetKey(KEY, ORIGIN, () => Promise.resolve(['a']), db)).resolves.toEqual([
      'a',
    ]);
  });
});
