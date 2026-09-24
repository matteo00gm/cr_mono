import { describe, expect, it, vi } from 'vitest';

import {
  fusedSearch,
  lexicalSearch,
  LEXICAL_CANDIDATE_LIMIT,
  RRF_K,
  vectorSearch,
  VECTOR_CANDIDATE_LIMIT,
} from '../src/retrieval.js';
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

/** Answers each statement in turn, so a fallback can be told from a first attempt. */
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

describe('the lexical search statement', () => {
  const query = 'nebbiolo di Poderi Colla';

  it('parses what a visitor typed, rather than a query grammar they do not know', async () => {
    /*
     * `to_tsquery` raises a syntax error on quotes, `and`, a stray `!` or an
     * emoji — all of which visitors type — and the chat request would fail.
     * `websearch_to_tsquery` reads the same input the way a search box does and
     * never throws.
     */
    const { statements, tx } = capturing([{ product_id: 'p1', rank_score: 1 }]);

    await lexicalSearch(tx, { query });

    expect(text(statements[0])).toContain("websearch_to_tsquery('italian'");
    expect(text(statements[0])).not.toContain('to_tsquery($');
  });

  it('matches a grape through the array the text column deliberately omits', async () => {
    // P1-07 left `grape_varieties` out of `search_tsv`: a wine made from
    // Nebbiolo does not say so in its description, and the row asks lexical
    // search to find by grape.
    const { statements, tx } = capturing([{ product_id: 'p1', rank_score: 1 }]);

    await lexicalSearch(tx, { query });

    expect(text(statements[0])).toContain('unnest(p.grape_varieties)');
    expect(text(statements[0])).toContain('lower(g)');
  });

  it('writes the tenant predicate out and offers only wines still listed', async () => {
    const { statements, tx } = capturing([{ product_id: 'p1', rank_score: 1 }]);

    await lexicalSearch(tx, { query });

    const statement = text(statements[0]);

    expect(statement).toContain("current_setting('app.tenant_id'");
    expect(statement).toContain("p.status = 'ACTIVE'");
  });

  it('asks the trigram fallback only when the words matched nothing', async () => {
    /*
     * `%` is a similarity threshold, so on a query that already matched it
     * would add wines that merely look like the words. A guess is better than
     * nothing, and worse than an answer.
     */
    const matched = capturing([{ product_id: 'p1', rank_score: 2 }]);
    const nothing = capturing([], [{ product_id: 'p2', rank_score: 0.4 }]);

    const found = await lexicalSearch(matched.tx, { query });
    const guessed = await lexicalSearch(nothing.tx, { query });

    expect(matched.statements).toHaveLength(1);
    expect(found).toEqual([{ productId: 'p1', rank: 2, matched: 'text' }]);

    expect(nothing.statements).toHaveLength(2);
    expect(text(nothing.statements[1])).toContain('similarity(');
    expect(guessed).toEqual([{ productId: 'p2', rank: 0.4, matched: 'similar' }]);
  });

  it('reads a rank back as a number, whatever the driver decoded it as', async () => {
    const { tx } = capturing([{ product_id: 'p1', rank_score: '0.75' }]);

    await expect(lexicalSearch(tx, { query })).resolves.toEqual([
      { productId: 'p1', rank: 0.75, matched: 'text' },
    ]);
  });

  it('offers forty wines by default, as the vector branch does', () => {
    expect(LEXICAL_CANDIDATE_LIMIT).toBe(40);
  });
});

describe('the fused statement', () => {
  const query = 'Barolo Giacomo Conterno';

  it('is one statement, which is the regression the correction exists to prevent', async () => {
    /*
     * **Counted here because only a unit test can count it.** Two queries under
     * `Promise.all` would look parallel and serialise on the one connection;
     * made genuinely parallel they would need two transactions per chat request
     * against a pool of one or two, and at a pool of one they deadlock. The
     * integration suite proves a retrieval completes on one connection; this
     * proves there is only ever one statement to complete.
     */
    const { statements, tx } = capturing([]);

    await fusedSearch(tx, { vector, query });

    expect(statements).toHaveLength(1);
  });

  it('scores by reciprocal rank, with the constant bound rather than written in', async () => {
    const { statements, tx } = capturing([]);

    await fusedSearch(tx, { vector, query });

    const statement = text(statements[0]);

    expect(statement).toContain('coalesce(1.0 / (');
    // Bound, so P1-46 can sweep it without editing SQL.
    expect(statement).not.toContain('60');
    expect(RRF_K).toBe(60);
  });

  it('joins the branches so a wine either one found keeps its place', async () => {
    const { statements, tx } = capturing([]);

    await fusedSearch(tx, { vector, query });

    expect(text(statements[0])).toContain('full outer join lex using (product_id)');
  });

  it('offers the trigram fallback only when the words matched nothing', async () => {
    const { statements, tx } = capturing([]);

    await fusedSearch(tx, { vector, query });

    expect(text(statements[0])).toContain('not exists (select 1 from words)');
  });

  it('reads ranks back as numbers, and a branch that missed as null', async () => {
    const { tx } = capturing([
      {
        product_id: 'p1',
        vector_rank: '1',
        lexical_rank: null,
        stock_status: 'IN_STOCK',
        // `integer` arrives as a number, `bigint` and `numeric` as strings.
        price_cents: 2400,
        score: '0.0163',
      },
    ]);

    await expect(fusedSearch(tx, { vector, query })).resolves.toEqual([
      {
        productId: 'p1',
        score: 0.0163,
        vectorRank: 1,
        lexicalRank: null,
        stockStatus: 'IN_STOCK',
        priceCents: 2400,
      },
    ]);
  });

  it('carries what P2-21 filters on, from the tenant the setting names', async () => {
    /*
     * The join is scoped explicitly as well as by RLS. A candidate is only ever
     * a product one of the branches found, so the join cannot widen the set —
     * but a predicate written once in each branch and nowhere here is how the
     * one place that lacks it becomes the place a wine crosses a tenant.
     */
    const { statements, tx } = capturing([]);

    await fusedSearch(tx, { vector, query });

    const statement = text(statements[0]);

    expect(statement).toContain('p.stock_status');
    expect(statement).toContain('p.price_cents');
    expect(statement).toContain('join products p on p.id = product_id and p.tenant_id =');
    expect(statement).toContain("current_setting('app.tenant_id'");
  });
});
