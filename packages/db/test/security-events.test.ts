import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/client.js';
import { insertSecurityEvent } from '../src/security-events.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The `security_events` statement, without a database (P2-16).
 *
 * What is worth pinning here is the shape of the write and the scope it opens:
 * whether the row is written under a tenant, and whether it asks for anything
 * back. Whether the policy then admits it is a question only Postgres can
 * answer, and the integration suite beside this one asks it.
 */

/** The literal SQL of a statement, with its bound values elided. */
const text = (statement: unknown): string =>
  ((statement as { queryChunks?: unknown[] }).queryChunks ?? [])
    .flatMap((chunk): string[] => {
      if (typeof chunk !== 'object' || chunk === null) return [];
      if (Array.isArray((chunk as { value?: unknown[] }).value)) {
        return (chunk as { value: string[] }).value;
      }
      return 'queryChunks' in chunk ? [text(chunk)] : [];
    })
    .join(' ');

const capturing = () => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve([]);
  });
  const tx = { execute } as unknown as DbTransaction;
  const db = {
    transaction: <T>(fn: (t: DbTransaction) => Promise<T>) => fn(tx),
  } as unknown as Database;

  return { statements, db };
};

describe('insertSecurityEvent', () => {
  it('writes the refusal without asking for the row back', async () => {
    /*
     * No `RETURNING`. `app_rw` holds INSERT on this table and nothing else
     * (P0-31), and Postgres applies the SELECT policy to a RETURNING clause, so
     * asking would fail with 42501 on a write that is otherwise allowed.
     */
    const { statements, db } = capturing();

    await insertSecurityEvent({ type: 'INVALID_KEY', origin: 'https://evil.example' }, db);

    const statement = text(statements.at(-1));

    expect(statement).toContain('insert into security_events');
    expect(statement).toContain('ip_bucket');
    expect(statement).not.toContain('returning');
  });

  it('writes a row belonging to no tenant without opening a tenant scope', async () => {
    // An unknown key resolved to nobody — which is why it was refused. The
    // policy admits the row by name, so there is no tenant to set.
    const { statements, db } = capturing();

    await insertSecurityEvent({ type: 'INVALID_KEY' }, db);

    expect(statements).toHaveLength(1);
    expect(text(statements[0])).not.toContain('set_config');
  });

  it('writes an attributed row under that tenant, and nothing wider', async () => {
    const { statements, db } = capturing();
    const tenantId = randomUUID();

    await insertSecurityEvent({ type: 'UNAUTHORIZED_ORIGIN', tenantId }, db);

    expect(statements).toHaveLength(2);
    // withTenant first: the row is written under the tenant it belongs to.
    expect(text(statements[0])).toContain('set_config');
    expect(text(statements[1])).toContain('insert into security_events');
  });
});
