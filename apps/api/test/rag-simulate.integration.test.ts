import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type { EmbeddingProvider } from '@catalogorosso/core';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRagPort, type RagPort } from '../src/rag.js';

/**
 * The retrieval sandbox, against real Postgres (P2-37).
 *
 * **A fake ranking would prove nothing about a ranking**, and the whole claim
 * of this endpoint is that it runs the same path a visitor gets. So the rows
 * are real, the vectors are real `halfvec` values, and the only thing faked is
 * the provider — which is faked because the alternative is paying Bedrock for
 * every test run, not because the embedding step is uninteresting.
 *
 * **The provider is also the instrument.** Counting its calls is how "no
 * generation, and one embedding" stops being an assurance and becomes a test.
 */

let harness: TestDatabase | undefined;
let db: TestDatabase['db'];
let tenantId: string;
let otherTenantId: string;
let stocked: string;
let soldOut: string;
let dear: string;

const DIM = 1024;

/**
 * A vector with 1 on the first axis and a decreasing amount on its own.
 *
 * Distinct enough at half precision that the order is never a coin toss, which
 * matters because the assertions below are about *which* wine came first.
 */
const vectorFor = (index: number): number[] => {
  const values = Array.from({ length: DIM }, () => 0);

  values[0] = 1;
  values[index + 1] = (index + 1) * 0.5;

  return values;
};

/** The query vector: nearest to the wine seeded at index 0. */
const QUERY_VECTOR = vectorFor(0);

interface CountingProvider extends EmbeddingProvider {
  readonly calls: () => number;
  readonly texts: readonly string[];
}

const countingProvider = (): CountingProvider => {
  const texts: string[] = [];

  return {
    model: 'amazon.titan-embed-text-v2:0',
    dim: DIM,
    texts,
    calls: () => texts.length,
    embed: (input) => {
      texts.push(...input);

      return Promise.resolve(input.map(() => QUERY_VECTOR));
    },
  };
};

/**
 * Scopes the session to a tenant, the way `packages/db`'s suites do.
 *
 * Session-level rather than `withTenant`, because seeding has to outlive the
 * statement that seeds. The port under test still opens its own transaction and
 * sets `SET LOCAL` inside it, so nothing here is what makes its reads work.
 */
const useTenant = async (tenant: string): Promise<void> => {
  await db.execute(sql`select set_config('app.tenant_id', ${tenant}, false)`);
};

const addWine = async (
  tenant: string,
  {
    name,
    index,
    stock = 'IN_STOCK',
    priceCents = 2000,
    producer,
  }: {
    name: string;
    index: number;
    stock?: 'IN_STOCK' | 'OUT_OF_STOCK' | 'PREORDER';
    priceCents?: number;
    producer?: string;
  },
): Promise<string> => {
  await useTenant(tenant);

  const rows = await db.execute(sql`
    insert into products
      (tenant_id, sku, name, producer, wine_type, price_cents, currency, stock_status, status)
    values (
      ${tenant}::uuid, ${`sku-${randomUUID()}`}, ${name}, ${producer ?? null},
      'red', ${priceCents}, 'EUR', ${stock}::product_stock_status, 'ACTIVE'
    )
    returning id
  `);
  const productId = ([...rows][0] as { id: string }).id;

  await db.execute(sql`
    insert into product_embeddings
      (tenant_id, product_id, chunk_idx, content_hash, embedding, model, version)
    values (
      ${tenant}::uuid, ${productId}::uuid, 0, ${`hash-${productId}`},
      ${JSON.stringify(vectorFor(index))}::halfvec, 'amazon.titan-embed-text-v2:0', 1
    )
  `);

  return productId;
};

/**
 * Creates a tenant and leaves the session scoped to it.
 *
 * The id is generated here and the context set *before* the insert, because
 * `tenants` carries `WITH CHECK (id = app.tenant_id)` — the row has to satisfy
 * the policy it is creating the context for.
 */
const createTenant = async (slug: string): Promise<string> => {
  const id = randomUUID();

  await useTenant(id);
  await db.execute(sql`
    insert into tenants (id, name, slug, locale, currency)
    values (${id}::uuid, ${slug}, ${`${slug}-${id}`}, 'it', 'EUR')
  `);

  return id;
};

/** Counts what a tenant can see of a table, which under RLS is its own rows. */
const countRows = async (tenant: string, table: string): Promise<number> => {
  await useTenant(tenant);

  const rows = await db.execute(sql`select count(*)::int as n from ${sql.raw(table)}`);

  return ([...rows][0] as { n: number }).n;
};

const port = (provider: EmbeddingProvider): RagPort => createRagPort({ provider });

beforeAll(async () => {
  harness = await startTestDatabase();

  // The port calls `withTenant` with the package's memoised client, which reads
  // this. Set before anything builds one.
  process.env.DATABASE_URL = harness.roleUrl('app_rw');
  db = harness.db;

  tenantId = await createTenant('sandbox');
  otherTenantId = await createTenant('neighbour');

  /*
   * **Only one wine answers the words, and that is what makes the order
   * deterministic.** Three wines all named "Barolo …" by the same producer tie
   * on `ts_rank_cd`, so the lexical branch ranks them by `product_id` — a
   * random UUID — and the fused sums come out equal. The first draft of this
   * suite did exactly that and passed locally while failing in CI, which is the
   * flake being asserted away here rather than re-run away.
   *
   * The other two still reach the ranking through the vector branch, which is
   * what the filter and cap cases below need them for.
   */
  stocked = await addWine(tenantId, {
    name: 'Barolo Monfortino',
    index: 0,
    producer: 'Giacomo Conterno',
  });
  soldOut = await addWine(tenantId, {
    name: 'Dolcetto Comune',
    index: 1,
    producer: 'Cantina Bassa',
    stock: 'OUT_OF_STOCK',
  });
  dear = await addWine(tenantId, {
    name: 'Nebbiolo Semplice',
    index: 2,
    producer: 'Cantina Alta',
    priceCents: 40_000,
  });

  await addWine(otherTenantId, {
    name: 'Barolo del Vicino',
    index: 0,
    producer: 'Giacomo Conterno',
  });
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('what a simulation reports', () => {
  it('ranks the catalogue and shows the numbers that ranked it', async () => {
    const result = await port(countingProvider()).simulate({
      tenantId,
      query: 'Barolo Giacomo Conterno',
    });

    const first = result.candidates[0];

    expect(result.candidates.length).toBeGreaterThan(1);
    expect(first?.productId).toBe(stocked);
    expect(first?.vectorRank).toBe(1);
    expect(first?.lexicalRank).not.toBeNull();
    expect(first?.rrfScore).toBeGreaterThan(0);
    expect(first?.name).toBe('Barolo Monfortino');

    /*
     * Strictly ahead, not merely first. A tie is what made an earlier version of
     * this suite flake: equal fused sums fall back to `product_id`, so the
     * assertion above became a coin toss on a random UUID and passed locally
     * while failing in CI. This fails on the tie itself rather than on whichever
     * side it landed.
     */
    expect(first?.rrfScore).toBeGreaterThan(result.candidates[1]?.rrfScore ?? 0);
  });

  it('reports a similarity rather than the distance the database computed', async () => {
    // One is identical and nought unrelated, which is the direction a merchant
    // reads. The nearest wine is the query vector itself, so it scores ~1.
    const result = await port(countingProvider()).simulate({
      tenantId,
      query: 'Barolo Giacomo Conterno',
    });

    expect(result.candidates[0]?.vectorScore).toBeCloseTo(1, 3);
  });

  it('scores how completely each wine is described', async () => {
    /*
     * The reason a wine ranks badly is often that nobody filled it in, and that
     * is a fix the merchant can make. Every wine here is name, producer and
     * price only, so every score is low and none is zero.
     */
    const result = await port(countingProvider()).simulate({
      tenantId,
      query: 'Barolo Giacomo Conterno',
    });

    expect(result.candidates[0]?.completeness.score).toBeGreaterThan(0);
    expect(result.candidates[0]?.completeness.missing).toContain('tastingNotes');
  });

  it('says which wines reached the prompt, and why the others did not', async () => {
    const result = await port(countingProvider()).simulate({
      tenantId,
      query: 'Barolo Giacomo Conterno',
      maxPriceCents: 3000,
    });

    const by = new Map(result.candidates.map((candidate) => [candidate.productId, candidate]));

    expect(by.get(stocked)?.included).toBe(true);
    expect(by.get(stocked)?.excludedBy).toBeNull();
    expect(by.get(soldOut)).toMatchObject({ included: false, excludedBy: 'stock' });
    expect(by.get(dear)).toMatchObject({ included: false, excludedBy: 'price' });
  });

  it('names the cap when the cap is what cut a wine', async () => {
    // The distinction the row is actually for: "retrieved at rank 11 and cut"
    // is a different fix from "sold out", and both are `included: false`.
    const result = await port(countingProvider()).simulate({
      tenantId,
      query: 'Barolo Giacomo Conterno',
      cap: 1,
    });

    const cut = result.candidates.filter((candidate) => candidate.excludedBy === 'cap');

    expect(cut.length).toBeGreaterThan(0);
    expect(result.candidates.filter((candidate) => candidate.included)).toHaveLength(1);
  });

  it('counts what survived filtering, before the cap', async () => {
    const result = await port(countingProvider()).simulate({
      tenantId,
      query: 'Barolo Giacomo Conterno',
      cap: 1,
    });

    expect(result.preCapCount).toBeGreaterThan(1);
  });

  it('reports a hash of the instructions, and nothing else about them', async () => {
    const result = await port(countingProvider()).simulate({ tenantId, query: 'barolo' });

    expect(result.systemPromptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(result)).not.toContain('cr-sommelier-istruzioni');
  });

  it('times the two steps separately, because they fail for different reasons', async () => {
    const result = await port(countingProvider()).simulate({ tenantId, query: 'barolo' });

    expect(result.timings.embedMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.searchMs).toBeGreaterThanOrEqual(0);
  });
});

describe('why nothing came back', () => {
  it('says the catalogue had no answer', async () => {
    const result = await port(countingProvider()).simulate({
      tenantId: otherTenantId,
      query: 'zibibbo passito',
      // A ceiling below every wine, so even the vector branch has nothing left.
      maxPriceCents: 1,
    });

    expect(result.zeroResultKind).toBe('filtered_out');
  });

  it('separates an empty catalogue from a filtered one', async () => {
    const empty = await createTenant('empty');

    const result = await port(countingProvider()).simulate({ tenantId: empty, query: 'barolo' });

    expect(result.candidates).toEqual([]);
    expect(result.zeroResultKind).toBe('no_matches');
  });

  it('flags a catalogue whose every answer is sold out', async () => {
    const gone = await createTenant('sold-out');

    await addWine(gone, { name: 'Barolo Esaurito', index: 0, stock: 'OUT_OF_STOCK' });

    const result = await port(countingProvider()).simulate({ tenantId: gone, query: 'barolo' });

    // §1.5: the wines come back so the widget can badge them, and the kind is
    // what tells a seller to restock rather than to write more descriptions.
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.zeroResultKind).toBe('out_of_stock_only');
  });
});

describe('what it must not do', () => {
  it('cannot reach another tenant, whoever asks', async () => {
    const result = await port(countingProvider()).simulate({
      tenantId: otherTenantId,
      query: 'Barolo Giacomo Conterno',
    });

    const ids = result.candidates.map((candidate) => candidate.productId);

    expect(ids).not.toContain(stocked);
    expect(ids).not.toContain(soldOut);
    expect(ids).not.toContain(dear);
  });

  it('writes no usage and no analytics, however often it is run', async () => {
    /*
     * The reason this endpoint exists. Reproducing a complaint through the live
     * widget inflates the counters a merchant bills against and fills the
     * analytics they are about to read with conversations nobody had.
     */
    const usageBefore = await countRows(tenantId, 'usage_events');
    const eventsBefore = await countRows(tenantId, 'widget_events');
    const conversationsBefore = await countRows(tenantId, 'conversations');

    const provider = countingProvider();

    for (let run = 0; run < 3; run += 1) {
      await port(provider).simulate({ tenantId, query: 'Barolo Giacomo Conterno' });
    }

    expect(await countRows(tenantId, 'usage_events')).toBe(usageBefore);
    expect(await countRows(tenantId, 'widget_events')).toBe(eventsBefore);
    expect(await countRows(tenantId, 'conversations')).toBe(conversationsBefore);
  });

  it('embeds once per run and asks no model to write anything', async () => {
    // Retrieval only: the row keeps generation behind an opt-in flag, and until
    // P2-31 can bill a call there is nothing to opt into. One embedding is the
    // entire provider cost of a simulation.
    const provider = countingProvider();

    await port(provider).simulate({ tenantId, query: 'Barolo Giacomo Conterno' });

    expect(provider.calls()).toBe(1);
    expect(provider.texts).toEqual(['Barolo Giacomo Conterno']);
  });
});
