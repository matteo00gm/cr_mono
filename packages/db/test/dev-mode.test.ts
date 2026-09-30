import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { enableDevMode, endDevMode, readDevMode } from '../src/dev-mode.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * Development mode's statements, without a database (P4-19b). Whether the
 * grant really ends on time is the policy's, and `dev-mode.integration`'s.
 */

const capturing = (...responses: unknown[][]) => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve(responses.shift() ?? []);
  });

  return { statements, tx: { execute } as unknown as DbTransaction };
};

const params = (statement: unknown): unknown[] =>
  new PgDialect().sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]).params;

const LOCAL = 'http://localhost:3000';
const AT = new Date('2026-10-01T09:00:00.000Z');

describe('development mode', () => {
  it('reads only a grant that has not run out', async () => {
    const { tx, statements } = capturing([{ dev_origin: LOCAL, dev_mode_expires_at: AT }]);

    await expect(readDevMode(tx)).resolves.toEqual({ origin: LOCAL, expiresAt: AT });
    expect(text(statements[0])).toContain('dev_mode_expires_at > now()');
  });

  it('reads nothing when there is no grant', async () => {
    const { tx } = capturing([]);

    await expect(readDevMode(tx)).resolves.toBeUndefined();
  });

  it('starts a grant from now(), never from a clock it is handed', async () => {
    const { tx, statements } = capturing([{ dev_origin: LOCAL, dev_mode_expires_at: AT }]);

    await expect(enableDevMode(tx, LOCAL, 24)).resolves.toEqual({ origin: LOCAL, expiresAt: AT });
    expect(text(statements[0])).toContain('now() + make_interval(hours =>');
    expect(params(statements[0])).toEqual([LOCAL, 24]);
  });

  it('ends a grant and says which origin it was for', async () => {
    const { tx, statements } = capturing([{ dev_origin: LOCAL }], []);

    await expect(endDevMode(tx)).resolves.toBe(LOCAL);
    expect(text(statements[0])).toContain('FOR UPDATE');
    expect(text(statements[1])).toContain('dev_origin = NULL, dev_mode_expires_at = NULL');
  });

  it('ends nothing quietly when there was nothing', async () => {
    const { tx } = capturing([{ dev_origin: null }], []);

    await expect(endDevMode(tx)).resolves.toBeUndefined();
  });
});
