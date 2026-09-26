import { describe, expect, it, vi } from 'vitest';

import { endSessionsFor } from '../src/session-cutoffs.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * Ending the sessions a removed domain left behind, without a database (P4-06).
 *
 * Shapes only. **Whether the cutoff actually survives the delete, and whether
 * another winery can see it, are the properties that matter** — and neither can
 * be asserted against a fake, which returns whatever it was told to. Both live
 * in `domains.integration.test.ts`.
 */

const capturing = () => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);

    return Promise.resolve([]);
  });

  return { statements, tx: { execute } as unknown as DbTransaction };
};

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

describe('writing a cutoff', () => {
  it('takes its tenant from the GUC, never from an argument', async () => {
    const { statements, tx } = capturing();

    await endSessionsFor(tx, 'https://www.winery.com');

    expect(text(statements[0])).toMatch(/current_setting\('app\.tenant_id', true\)/u);
  });

  it('stamps it with the database clock, on both paths', async () => {
    /*
     * A clock the caller supplies is a clock the caller can move — and the
     * comparison it decides is "is this session over?".
     *
     * **Both** the insert and the conflict update, asserted separately: a
     * single `toMatch` passes while one of them is a literal, because the other
     * still contains `now()`.
     */
    const { statements, tx } = capturing();

    await endSessionsFor(tx, 'https://www.winery.com');

    const sql = text(statements[0]);
    const [values = '', onConflict = ''] = sql.split('ON CONFLICT');

    expect(values).toMatch(/now\(\)/u);
    expect(values).not.toMatch(/to_timestamp|'19\d\d|'20\d\d/u);
    expect(onConflict).toMatch(/valid_from = now\(\)/u);
  });

  it('moves an existing cutoff forward rather than adding a row', async () => {
    /*
     * A seller who removes an origin, re-verifies it and removes it again has
     * ended two sets of sessions, and only the later cutoff matters. Without
     * this the second removal would conflict and leave the *earlier* cutoff
     * standing — so the sessions from the second run would survive.
     */
    const { statements, tx } = capturing();

    await endSessionsFor(tx, 'https://www.winery.com');

    const sql = text(statements[0]);

    expect(sql).toMatch(/ON CONFLICT \(tenant_id, origin\) DO UPDATE/u);
    expect(sql).toMatch(/SET valid_from = now\(\)/u);
    expect(sql).not.toMatch(/DO NOTHING/u);
  });

  it('takes the caller transaction rather than opening its own', async () => {
    /* The cutoff and the removal it belongs to have to be one write: a removal
     * that committed without its cutoff leaves live sessions on an origin
     * nobody can see any more. */
    const { tx } = capturing();

    await expect(endSessionsFor(tx, 'https://www.winery.com')).resolves.toBeUndefined();
  });
});
