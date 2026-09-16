import { describe, expect, it, vi } from 'vitest';

import { vectorSearch, VECTOR_CANDIDATE_LIMIT } from '../src/retrieval.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The vector search statement, without a database (P2-18).
 *
 * Four things in this SQL fail silently when they are wrong, which is why they
 * are pinned here as text rather than only exercised against Postgres: the cast,
 * the tenant predicate, the version filter and the per-product de-duplication.
 * Each produces rows either way — just the wrong ones, or the same wine several
 * times.
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

const capturing = (rows: unknown[] = []) => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve(rows);
  });

  return { statements, tx: { execute } as unknown as DbTransaction };
};

const vector = Array.from({ length: 1024 }, () => 0.1);

describe('the vector search statement', () => {
  it('casts the query vector as halfvec, which is what the column and index are', async () => {
    /*
     * **`::vector` would still run.** The column is `halfvec(1024)` and the
     * index is `halfvec_cosine_ops`; comparing against a `vector` is a
     * different type, so the index cannot serve it and Postgres quietly falls
     * back to a scan. Nothing errors, and retrieval gets slower as a catalogue
     * grows — the failure migration 0011 warns about in its own comment.
     */
    const { statements, tx } = capturing();

    await vectorSearch(tx, { vector });

    expect(text(statements[0])).toContain('::halfvec');
    expect(text(statements[0])).not.toContain('::vector');
  });

  it('writes the tenant predicate out, even though the policy enforces it', async () => {
    // Belt and braces (§4.4), and the planner gets a predicate rather than
    // inferring one from a policy.
    const { statements, tx } = capturing();

    await vectorSearch(tx, { vector });

    expect(text(statements[0])).toContain("current_setting('app.tenant_id'");
  });

  it('reads only the generation the tenant is on, and only wines still listed', async () => {
    /*
     * P1-49: a tenant mid-migration has two generations of vectors. Without the
     * filter every wine appears twice and one model's distances are ranked
     * against another's — which is not an error, only a worse answer.
     */
    const { statements, tx } = capturing();

    await vectorSearch(tx, { vector });

    const statement = text(statements[0]);

    expect(statement).toContain('embedding_version');
    expect(statement).toContain("p.status = 'ACTIVE'");
  });

  it('offers each wine once, however many chunks it is stored as', async () => {
    const { statements, tx } = capturing();

    await vectorSearch(tx, { vector });

    expect(text(statements[0])).toContain('distinct on (e.product_id)');
  });

  it('asks for the row count it was given, forty by default', async () => {
    const { statements, tx } = capturing();

    await vectorSearch(tx, { vector });
    await vectorSearch(tx, { vector, limit: 5 });

    // Bound, not written into the SQL, so P1-46 can sweep it.
    expect(text(statements[0])).toContain('limit');
    expect(VECTOR_CANDIDATE_LIMIT).toBe(40);
  });

  it('reads a distance back as a number, whatever the driver decoded it as', async () => {
    /*
     * postgres-js returns some numeric types as strings, and `'0.9' < 0.5` is
     * false in JavaScript. A ranking compared as strings is wrong in a way that
     * looks like a bad model.
     */
    const { tx } = capturing([{ product_id: 'p1', distance: '0.25' }]);

    await expect(vectorSearch(tx, { vector })).resolves.toEqual([
      { productId: 'p1', distance: 0.25 },
    ]);
  });
});
