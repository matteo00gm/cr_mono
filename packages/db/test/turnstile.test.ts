import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { readTurnstileState, setTurnstileEnabled } from '../src/turnstile.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The Turnstile statements, without a database (P4-14). What the tenant policy
 * then admits — this winery's flag and events, and no other's — is asserted
 * against Postgres in `apps/api/test/turnstile.integration.test.ts`.
 */

const capturing = (rows: unknown[] = []) => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve(rows);
  });

  return { statements, tx: { execute } as unknown as DbTransaction };
};

const sqlOf = (statement: unknown): { sql: string; params: unknown[] } => {
  const query = new PgDialect().sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]);
  return { sql: query.sql, params: query.params };
};

describe('reading the state', () => {
  it('maps the flag and the two counts', async () => {
    const { tx } = capturing([{ enabled: true, unauthorized_origins: 51, rate_limited: 3 }]);

    await expect(readTurnstileState(tx)).resolves.toEqual({
      enabled: true,
      signals: { unauthorizedOrigins: 51, rateLimited: 3 },
    });
  });

  it('reads nothing as off and quiet, which is what a missing scope finds', async () => {
    const { tx } = capturing([]);

    await expect(readTurnstileState(tx)).resolves.toEqual({
      enabled: false,
      signals: { unauthorizedOrigins: 0, rateLimited: 0 },
    });
  });

  it('reads a null flag as off', async () => {
    const { tx } = capturing([{ enabled: null, unauthorized_origins: 0, rate_limited: 0 }]);

    expect((await readTurnstileState(tx)).enabled).toBe(false);
  });

  it('counts only the last hour, and only the two refusals that suggest it', async () => {
    const { statements, tx } = capturing([]);

    await readTurnstileState(tx);

    const { sql } = sqlOf(statements[0]);

    expect(sql).toContain("interval '1 hour'");
    expect(sql).toContain("type = 'UNAUTHORIZED_ORIGIN'");
    expect(sql).toContain("type = 'RATE_LIMITED'");
    /* No tenant predicate is written: the policy is the scope. */
    expect(sql).not.toContain('tenant_id');
  });
});

describe('setting the flag', () => {
  it('writes the value as a bound parameter', async () => {
    const { statements, tx } = capturing([{ id: 't1' }]);

    await expect(setTurnstileEnabled(tx, true)).resolves.toBe(true);
    expect(sqlOf(statements[0]).params).toEqual([true]);
  });

  it('reports that nothing changed when no tenant row was visible', async () => {
    const { tx } = capturing([]);

    await expect(setTurnstileEnabled(tx, false)).resolves.toBe(false);
  });
});
