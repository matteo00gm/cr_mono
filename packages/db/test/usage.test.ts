import { describe, expect, it, vi } from 'vitest';

import { countUsage, recordUsage } from '../src/usage.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The statements the ledger issues (P2-31).
 *
 * **These predicates are belt and braces, and that is exactly why they need a
 * unit test.** RLS scopes both tables, so a statement that dropped its tenant
 * predicate would still behave correctly against a real database — every
 * integration case would pass, and the redundancy that protects the day a
 * policy changes would be gone with nothing to show for it. Only the statement
 * text can say whether it is still there.
 */

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

const capturing = (...responses: unknown[][]) => {
  const statements: unknown[] = [];
  let call = 0;
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    const rows = responses[call] ?? [];
    call += 1;

    return Promise.resolve(rows);
  });

  return { statements, tx: { execute } as unknown as DbTransaction };
};

const USAGE = {
  period: '202609',
  kind: 'chat_message',
  sessionId: 'sess-1',
  inputTokens: 1000,
  outputTokens: 500,
  costMicros: 180,
};

describe('writing a bill', () => {
  it('takes the tenant from the setting, never from the caller', async () => {
    // P0-48: a tenant is never an argument, here or anywhere. `recordUsage` has
    // no parameter for one, and the statement reads whatever `withTenant` set.
    const { statements, tx } = capturing();

    await recordUsage(tx, USAGE);

    expect(text(statements[0])).toContain("current_setting('app.tenant_id'");
  });

  it('inserts and never updates, because the ledger is append-only', async () => {
    // P0-31 revokes UPDATE and DELETE from `app_rw`, so an upsert here would
    // fail at the grant — which is the point: a correction is another row.
    const { statements, tx } = capturing();

    await recordUsage(tx, USAGE);

    expect(statements).toHaveLength(1);
    expect(text(statements[0])).toContain('insert into usage_events');
    expect(text(statements[0])).not.toContain('on conflict');
  });
});

describe('counting a period', () => {
  it('is scoped by tenant, period and kind', async () => {
    const { statements, tx } = capturing([{ used: 3 }]);

    await countUsage(tx, '202609', 'chat_message');

    const statement = text(statements[0]);

    expect(statement).toContain("current_setting('app.tenant_id'");
    expect(statement).toContain('and period =');
    expect(statement).toContain('and kind =');
  });

  it('counts rows rather than summing tokens', async () => {
    // The tenant-facing limit is messages, because that is the unit a seller
    // understands and the unit the plan advertises. A cap in tokens is a cap
    // nobody can predict from their own behaviour.
    const { statements, tx } = capturing([{ used: 3 }]);

    await countUsage(tx, '202609', 'chat_message');

    expect(text(statements[0])).toContain('count(*)');
    expect(text(statements[0])).not.toContain('sum(');
  });

  it('is an equality on the period, which is what the YYYYMM shape is for', async () => {
    // Not a range over `created_at`: this runs before every model call, and the
    // index is on `(tenant_id, period)`.
    const { statements, tx } = capturing([{ used: 0 }]);

    await countUsage(tx, '202609', 'chat_message');

    expect(text(statements[0])).not.toContain('created_at');
  });

  it('refuses a count it could not read rather than reporting none', async () => {
    /*
     * Unreachable — `count(*)` always returns a row — and it throws anyway,
     * because the default that suggests itself is nought and nought is the
     * answer that grants unlimited usage. A cost gate whose read failed must
     * not be a cost gate that let everything through.
     */
    const { tx } = capturing([]);

    await expect(countUsage(tx, '202609', 'chat_message')).rejects.toThrow(/no row/);
  });
});
