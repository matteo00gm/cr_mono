import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { fusedSearch, lexicalSearch, vectorSearch } from '../src/retrieval.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Vector search against real pgvector (P2-18, §4.4).
 *
 * **The assertion is the result, not the plan.** Migration 0011 measured a
 * filtered HNSW search returning zero of eight rows for a small tenant beside a
 * large one, because the graph walk spends its candidate budget before the
 * tenant predicate is applied. So this suite never demands an index scan — it
 * demands the *exact* top-k, compared against the ordering the same vectors
 * give by hand. That catches under-return whatever plan Postgres chooses, and
 * under-return is what a seller would experience as "my wine is never
 * recommended".
 */

const DIMENSIONS = 1024;

/**
 * A wine whose distance from the query is known by construction.
 *
 * Each vector is the query's own axis plus a growing amount of another, so the
 * cosine ordering is unambiguous at half precision: separation between
 * neighbours is percentage points, not rounding.
 */
const vectorFor = (index: number): number[] => {
  const vector = Array.from({ length: DIMENSIONS }, () => 0);
  vector[0] = 1;
  vector[index + 1] = index * 0.5;

  return vector;
};

const QUERY = ((): number[] => {
  const vector = Array.from({ length: DIMENSIONS }, () => 0);
  vector[0] = 1;

  return vector;
})();

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

const addWine = async (
  tenant: string,
  {
    name,
    index,
    status = 'ACTIVE',
    version = 1,
    chunks = 1,
    producer,
    grapes,
    embed = true,
  }: {
    name: string;
    index: number;
    status?: 'ACTIVE' | 'ARCHIVED';
    version?: number;
    chunks?: number;
    producer?: string;
    grapes?: string[];
    /** False for a wine the vector branch cannot see, so fusion has one side only. */
    embed?: boolean;
  },
): Promise<string> => {
  await useTenant(db, tenant);

  const rows = await db.execute(sql`
    insert into products
      (tenant_id, sku, name, producer, grape_varieties, wine_type, price_cents, currency,
       stock_status, status)
    values (
      ${tenant}::uuid, ${`sku-${randomUUID()}`}, ${name}, ${producer ?? null},
      ${grapes === undefined ? null : `{${grapes.join(',')}}`}::text[],
      'red', 1000, 'EUR', 'IN_STOCK', ${status}::product_status
    )
    returning id
  `);
  const productId = ([...rows][0] as { id: string }).id;

  for (let chunk = 0; embed && chunk < chunks; chunk += 1) {
    await db.execute(sql`
      insert into product_embeddings
        (tenant_id, product_id, chunk_idx, content_hash, embedding, model, version)
      values (
        ${tenant}::uuid, ${productId}::uuid, ${chunk}, ${`hash-${String(chunk)}`},
        ${JSON.stringify(vectorFor(index))}::halfvec, 'amazon.titan-embed-text-v2:0', ${version}
      )
    `);
  }

  return productId;
};

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
  tenantId = await createTenant(db, 'retrieval');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

const search = (tenant: string, limit?: number) =>
  withTenant(
    tenant,
    (tx) => vectorSearch(tx, { vector: QUERY, ...(limit === undefined ? {} : { limit }) }),
    db,
  );

describe('vector search', () => {
  it('returns the exact nearest wines, in order, against a hand-computed ranking', async () => {
    const expected: string[] = [];

    // Index 0 is the query itself; each next wine leans further off its axis.
    for (let index = 0; index < 6; index += 1) {
      expected.push(await addWine(tenantId, { name: `wine ${String(index)}`, index }));
    }

    const found = await search(tenantId);

    expect(found.map((candidate) => candidate.productId)).toEqual(expected);
    expect(found[0]?.distance).toBeLessThan(found[5]?.distance ?? 0);
  });

  it('returns no more than it was asked for, keeping the nearest', async () => {
    const found = await search(tenantId, 3);

    expect(found).toHaveLength(3);
    expect(found.map((candidate) => candidate.distance)).toEqual(
      [...found].map((candidate) => candidate.distance).sort((a, b) => a - b),
    );
  });

  it('offers a wine once, however many chunks it is stored as', async () => {
    // Several chunks of one bottle must not occupy several of the forty places.
    const chunked = await addWine(tenantId, { name: 'chunked', index: 0, chunks: 3 });

    const found = await search(tenantId);

    expect(found.filter((candidate) => candidate.productId === chunked)).toHaveLength(1);
  });

  it('never returns a wine that was archived', async () => {
    // P1-05's assertion, arriving through the function retrieval actually uses.
    const archived = await addWine(tenantId, { name: 'archived', index: 0, status: 'ARCHIVED' });

    const found = await search(tenantId);

    expect(found.map((candidate) => candidate.productId)).not.toContain(archived);
  });

  it('never returns a wine on a generation the tenant has moved off', async () => {
    // P1-49: mixing two generations ranks one model's distances against another's.
    const stale = await addWine(tenantId, { name: 'previous generation', index: 0, version: 2 });

    const found = await search(tenantId);

    expect(found.map((candidate) => candidate.productId)).not.toContain(stale);
  });

  it("returns none of another winery's wines", async () => {
    const other = await createTenant(db, 'retrieval-other');
    const theirs = await addWine(other, { name: 'theirs', index: 0 });

    const mine = await search(tenantId);
    const found = await search(other);

    expect(mine.map((candidate) => candidate.productId)).not.toContain(theirs);
    expect(found.map((candidate) => candidate.productId)).toEqual([theirs]);
  });
});

describe('lexical search', () => {
  const ask = (tenant: string, query: string) =>
    withTenant(tenant, (tx) => lexicalSearch(tx, { query }), db);

  it('finds a wine by its producer', async () => {
    const wine = await addWine(tenantId, {
      name: 'Barolo Bussia',
      index: 0,
      producer: 'Poderi Colla',
    });

    const found = await ask(tenantId, 'Poderi Colla');

    expect(found.map((candidate) => candidate.productId)).toContain(wine);
    expect(found.every((candidate) => candidate.matched === 'text')).toBe(true);
  });

  it('finds a wine by grape, which the text column deliberately does not carry', async () => {
    // P1-07 left `grape_varieties` out of `search_tsv`, and a wine made from
    // Nebbiolo does not say so in its own description.
    const wine = await addWine(tenantId, {
      name: 'Langhe Rosso',
      index: 0,
      grapes: ['Nebbiolo', 'Barbera'],
    });

    const found = await ask(tenantId, 'nebbiolo');

    expect(found.map((candidate) => candidate.productId)).toContain(wine);
  });

  it('falls back to similarity for a misspelled producer', async () => {
    // A misspelled producer is a large share of real questions, and the case
    // where a guess beats nothing.
    const wine = await addWine(tenantId, {
      name: 'Dolcetto',
      index: 0,
      producer: 'Marchesi Antinori',
    });

    const found = await ask(tenantId, 'Marchesi Antinnori');

    expect(found.map((candidate) => candidate.productId)).toContain(wine);
    expect(found.every((candidate) => candidate.matched === 'similar')).toBe(true);
  });

  it('ranks a wine matched by its words above one matched only by grape', async () => {
    /*
     * **The order is the whole signal.** The lexical branch hands RRF a rank,
     * not a score, so a branch ordered by anything else feeds fusion noise —
     * and nothing fails, because rows still come back.
     */
    const byWords = await addWine(tenantId, {
      name: 'Nebbiolo delle Langhe',
      index: 0,
      producer: 'Rinaldi',
    });
    const byGrapeOnly = await addWine(tenantId, {
      name: 'Vino Anonimo',
      index: 0,
      grapes: ['Nebbiolo'],
    });

    const found = await ask(tenantId, 'nebbiolo');
    const ids = found.map((candidate) => candidate.productId);

    expect(ids).toContain(byWords);
    expect(ids).toContain(byGrapeOnly);
    expect(ids.indexOf(byWords)).toBeLessThan(ids.indexOf(byGrapeOnly));
  });

  it('does not guess when the words already matched something', async () => {
    await addWine(tenantId, { name: 'Chianti Classico', index: 0, producer: 'Fontodi' });

    const found = await ask(tenantId, 'Fontodi');

    expect(found).not.toHaveLength(0);
    expect(found.every((candidate) => candidate.matched === 'text')).toBe(true);
  });

  it('survives the punctuation a visitor types', async () => {
    // `to_tsquery` raises a syntax error on all of these; the request would fail.
    for (const query of ['"barolo" & !nebbiolo', 'rosso | bianco', 'a <-> b', '???', 'vino!!']) {
      await expect(ask(tenantId, query)).resolves.toBeInstanceOf(Array);
    }
  });

  it('offers no wine that was archived', async () => {
    const archived = await addWine(tenantId, {
      name: 'Vino Ritirato',
      index: 0,
      producer: 'Cantina Chiusa',
      status: 'ARCHIVED',
    });

    const found = await ask(tenantId, 'Cantina Chiusa');

    expect(found.map((candidate) => candidate.productId)).not.toContain(archived);
  });

  it("offers none of another winery's wines", async () => {
    const other = await createTenant(db, 'lexical-other');
    const theirs = await addWine(other, {
      name: 'Loro Rosso',
      index: 0,
      producer: 'Cantina Altrui',
    });

    const mine = await ask(tenantId, 'Cantina Altrui');
    const found = await ask(other, 'Cantina Altrui');

    expect(mine.map((candidate) => candidate.productId)).not.toContain(theirs);
    expect(found.map((candidate) => candidate.productId)).toEqual([theirs]);
  });
});

describe('fused retrieval (P2-20)', () => {
  const QUESTION = 'Barolo Giacomo Conterno';

  let fusedTenant: string;
  let both: string;
  let vectorOnly: string;
  let lexicalOnly: string;

  const fuse = (tenant: string, query = QUESTION) =>
    withTenant(tenant, (tx) => fusedSearch(tx, { vector: QUERY, query }), db);

  beforeAll(async () => {
    // A tenant of its own, so the wines seeded above cannot crowd the ranking.
    fusedTenant = await createTenant(db, 'fusion');

    /*
     * The wine both branches find is deliberately the *second* nearest, so the
     * sum is what puts it first. Were it nearest as well, dropping either term
     * of the score would leave the order unchanged and the test would prove
     * nothing about fusion.
     */
    both = await addWine(fusedTenant, {
      name: 'Barolo Monfortino',
      index: 1,
      producer: 'Giacomo Conterno',
    });
    vectorOnly = await addWine(fusedTenant, { name: 'Vino Silenzioso', index: 0 });
    lexicalOnly = await addWine(fusedTenant, {
      name: 'Barolo Cannubi',
      index: 0,
      producer: 'Giacomo Conterno',
      embed: false,
    });
  }, 120_000);

  it('ranks a wine both branches found above one only a single branch found', async () => {
    const found = await fuse(fusedTenant);
    const score = (id: string) => found.find((candidate) => candidate.productId === id)?.score ?? 0;

    expect(found[0]?.productId).toBe(both);
    expect(score(both)).toBeGreaterThan(score(vectorOnly));
    expect(score(both)).toBeGreaterThan(score(lexicalOnly));
  });

  it('keeps a wine that only one branch found, with the other side left empty', async () => {
    // The FULL OUTER JOIN, which is why neither branch needs a special case.
    const found = await fuse(fusedTenant);
    const at = (id: string) => found.find((candidate) => candidate.productId === id);

    expect(at(vectorOnly)?.lexicalRank).toBeNull();
    expect(at(vectorOnly)?.vectorRank).not.toBeNull();
    expect(at(lexicalOnly)?.vectorRank).toBeNull();
    expect(at(lexicalOnly)?.lexicalRank).not.toBeNull();

    // Each still scores: a branch that misses contributes nothing, not a zero total.
    expect(at(vectorOnly)?.score ?? 0).toBeGreaterThan(0);
    expect(at(lexicalOnly)?.score ?? 0).toBeGreaterThan(0);
  });

  it('never returns a wine on a generation the tenant moved off', async () => {
    // The fused query carries P1-49's filter too, and its own copy of it would
    // be the copy that goes missing.
    const stale = await addWine(fusedTenant, {
      name: 'Barolo Vecchia Generazione',
      index: 0,
      producer: 'Giacomo Conterno',
      version: 2,
    });

    const found = await fuse(fusedTenant);
    const at = found.find((candidate) => candidate.productId === stale);

    // Its words still match, so it may appear — but never through the vector branch.
    expect(at?.vectorRank ?? null).toBeNull();
  });

  it('answers the same way twice for the same question', async () => {
    // Fusion feeds a model; an unstable order would make every answer unrepeatable.
    const [first, second] = [await fuse(fusedTenant), await fuse(fusedTenant)];

    expect(second).toEqual(first);
  });

  it('returns nothing when neither branch found anything', async () => {
    const barren = await createTenant(db, 'fusion-empty');

    await expect(fuse(barren)).resolves.toEqual([]);
  });

  it('never returns an archived wine, through the function retrieval uses (P1-05)', async () => {
    const archived = await addWine(fusedTenant, {
      name: 'Barolo Ritirato',
      index: 0,
      producer: 'Giacomo Conterno',
      status: 'ARCHIVED',
    });

    const found = await fuse(fusedTenant);

    expect(found.map((candidate) => candidate.productId)).not.toContain(archived);
  });

  it('reaches the trigram fallback when the words match nothing', async () => {
    const misspelled = await addWine(fusedTenant, {
      name: 'Dolcetto Comune',
      index: 3,
      producer: 'Marchesi Antinori',
    });

    const found = await fuse(fusedTenant, 'Marchesi Antinnori');
    const at = found.find((candidate) => candidate.productId === misspelled);

    expect(at?.lexicalRank).not.toBeNull();
  });

  it('completes on a pool of one connection, which two transactions could not', async () => {
    /*
     * **The regression the row's correction exists to prevent.** This client is
     * `max: 1`. A retrieval that opened a second transaction would hold the only
     * connection while waiting for one that only it could release, and this test
     * would hang rather than fail — which is why the single statement is also
     * asserted in the unit suite, where it can be counted.
     */
    await expect(fuse(fusedTenant)).resolves.not.toHaveLength(0);
  });
});
