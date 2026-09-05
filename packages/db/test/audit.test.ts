import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { insertAuditRow } from '../src/audit.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The audit insert, without a database (P0-53).
 *
 * The statement's shape, which is cheap to assert and easy to get wrong. What
 * it *does* — rolling back with its transaction, refusing a malformed address,
 * being refused an UPDATE — is asserted against a real container in
 * `audit-writer.integration.test.ts`, because no mock can answer any of it.
 */

const TENANT = 'a0000000-0000-4000-8000-000000000001';

const capturing = () => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve([]);
  });

  return { statements, execute, tx: { execute } as unknown as DbTransaction };
};

const sqlOf = (statement: unknown): { sql: string; params: unknown[] } => {
  const query = new PgDialect().sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]);
  return { sql: query.sql, params: query.params };
};

const row = {
  tenantId: TENANT,
  actorUserId: 'user_matteo',
  action: 'domain.added',
  target: 'shop.example',
  metadata: JSON.stringify({ requestId: 'r1' }),
  ip: '203.0.113.7',
  userAgent: 'Firefox/1',
};

describe('the statement', () => {
  it('writes every column the audit row carries', async () => {
    const { tx, statements } = capturing();

    await insertAuditRow(tx, row);

    const { sql, params } = sqlOf(statements[0]);
    expect(sql).toContain('insert into audit_log');
    for (const value of Object.values(row)) expect(params, value).toContain(value);
  });

  it('asks for nothing back', async () => {
    /*
     * No `RETURNING`, deliberately. `app_rw` holds INSERT on this table and
     * nothing else (P0-31's append-only revoke), and Postgres applies the
     * SELECT policy to a RETURNING clause — so asking for the row back would
     * fail with 42501 on a write that is otherwise permitted.
     */
    const { tx, statements } = capturing();

    await insertAuditRow(tx, row);

    expect(sqlOf(statements[0]).sql.toLowerCase()).not.toContain('returning');
  });

  it('casts ip to inet and metadata to jsonb', async () => {
    // Both columns are typed, and postgres-js would otherwise send text. The
    // `inet` cast is what turns a malformed address into a write-time failure.
    const { tx, statements } = capturing();

    await insertAuditRow(tx, row);

    const { sql } = sqlOf(statements[0]);
    expect(sql).toContain('::inet');
    expect(sql).toContain('::jsonb');
  });

  it('binds every value as a parameter', async () => {
    // An action name or a user agent reaching SQL by concatenation is
    // injection into the one table that is supposed to be trustworthy.
    const { tx, statements } = capturing();

    await insertAuditRow(tx, { ...row, action: "'; drop table audit_log; --" });

    const { sql, params } = sqlOf(statements[0]);
    expect(sql).not.toContain('drop table');
    expect(params).toContain("'; drop table audit_log; --");
  });

  it('sends null rather than undefined for an absent actor', async () => {
    /*
     * Not every audited action has a human behind it — a Stripe webhook
     * downgrading a subscription (P5-09) belongs in this log, and attributing
     * it to a person would be a lie. `undefined` would be sent as a missing
     * parameter rather than as SQL NULL.
     */
    const { tx, statements } = capturing();

    await insertAuditRow(tx, {
      ...row,
      actorUserId: undefined,
      target: undefined,
      metadata: undefined,
      ip: undefined,
      userAgent: undefined,
    });

    const { params } = sqlOf(statements[0]);
    expect(params).not.toContain(undefined);
    expect(params.filter((param) => param === null)).toHaveLength(5);
  });
});
