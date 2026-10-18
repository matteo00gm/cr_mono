import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { fusedSearch, vectorSearch, VECTOR_CANDIDATE_LIMIT } from '../src/retrieval.js';
import { withTenant, type DbTransaction } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';

/**
 * Retrieval headroom (P7-05): no cliff just past the ceiling.
 *
 * §5.0 caps this product at about ten wineries. "At most ten" is a plan, not a
 * guarantee, so this seeds three times that — thirty wineries of two thousand
 * wines each, sixty thousand vectors — and asks whether one winery's retrieval
 * got slower or worse than it was with two.
 *
 * **On demand, not in CI** (`pnpm test:headroom`): seeding sixty thousand
 * vectors takes minutes, and a latency figure from a shared runner is noise.
 * The figures it prints are recorded in the plan with the date and the machine.
 *
 * **The statement a chat turn runs**: the fused search (P2-20), in its own
 * `withTenant` transaction, as `app_rw` under RLS, for every kind of question —
 * words that match, a grape, a misspelling that only the trigram fallback
 * finds, and a question whose words match nothing.
 *
 * **Timed by the database, asserted on the database's time.** The first run
 * timed the call from the client and read a doubling that a second run on the
 * same machine did not reproduce: a laptop's Docker VM swings by that much on
 * its own, and every call pays ~7 ms of round trips that have nothing to do
 * with how many wineries there are. What grows with the corpus is planning and
 * execution, so that is what `EXPLAIN (ANALYZE, TIMING OFF)` measures and the
 * assertion holds; the wall time is printed beside it.
 *
 * **And what a seller would notice besides time**: the vector branch must
 * still return the exact nearest wines. A filtered HNSW scan loses rows as the
 * index fills with other wineries' vectors (P2-18's measurement), so a plan
 * change at this size is the failure to look for, and it does not show up as
 * latency.
 */

const PRODUCTS_PER_WINERY = 2_000;
const BASELINE_WINERIES = 2;
const CEILING_WINERIES = 30;
const WARMUP = 3;
const ROUNDS = 40;

/**
 * The budget, and what "degrade meaningfully" means.
 *
 * A turn is seconds of a model writing (P7-02 alarms at twenty), and retrieval
 * comes before the model's first word, so it adds to every answer. A hundred
 * milliseconds is two to three per cent of a turn: a figure a visitor cannot
 * notice and a database at this size has no reason to need. Twice the
 * baseline, with five milliseconds of slack so a small baseline is not held to
 * double itself, is the line past which the cause is the corpus rather than
 * the noise.
 */
const BUDGET_MS = 100;
const DEGRADATION = 2;
const SLACK_MS = 5;

const QUESTIONS = [
  'un rosso strutturato per la bistecca',
  'nebbiolo',
  'nebiolo invecchiato',
  'bianco fresco per il pesce',
  'cantina rossi',
  'tenuta biancchi',
  'qualcosa da regalare sotto i trenta euro',
  'barbera',
];

let container: StartedPostgreSqlContainer | undefined;
const clients: DbClient[] = [];
let runtime: Database;
let admin: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  const connect = (url: string): Database => {
    const client = createDbClient(url, { max: 1 });
    clients.push(client);

    return client.db;
  };

  runtime = connect(started.roleUrl('app_rw'));
  admin = connect(started.adminUrl);
}, 180_000);

afterAll(async () => {
  for (const client of clients) await client.close();
  await container?.stop();
}, 60_000);

/**
 * A winery with two thousand wines and a vector for each, generated in the
 * database: one statement for the wines and one for their vectors, rather than
 * sixty thousand round trips carrying a thousand floats each.
 *
 * The `lateral` with `p.id` in it is what makes each wine's vector its own —
 * an uncorrelated subquery is evaluated once, and every wine would share it.
 */
const seedWinery = async (label: string): Promise<string> => {
  const id = randomUUID();

  await admin.execute(sql`
    INSERT INTO tenants (id, name, slug) VALUES (${id}::uuid, ${label}, ${`${label}-${id}`})
  `);
  await admin.execute(sql`
    INSERT INTO products (tenant_id, sku, name, producer, wine_type, grape_varieties,
                          tasting_notes, price_cents, currency, stock_status)
    SELECT ${id}::uuid, 'sku-' || i, 'Vino ' || i,
           (ARRAY['Cantina Rossi','Tenuta Bianchi','Podere Verdi','Fattoria Neri'])[1 + i % 4],
           (ARRAY['red','white','rose','sparkling'])[1 + i % 4],
           ARRAY[(ARRAY['Nebbiolo','Sangiovese','Barbera','Vermentino','Glera','Aglianico'])[1 + i % 6]],
           (ARRAY['strutturato e tannico','fresco e minerale','fruttato','invecchiato in legno'])[1 + i % 4],
           1000 + (i % 50) * 100, 'EUR', 'IN_STOCK'
    FROM generate_series(1, ${PRODUCTS_PER_WINERY}) AS i
  `);
  await admin.execute(sql`
    INSERT INTO product_embeddings (tenant_id, product_id, chunk_idx, content_hash, embedding, model, version)
    SELECT p.tenant_id, p.id, 0, 'h', v.embedding, 'amazon.titan-embed-text-v2:0', t.embedding_version
    FROM products p
    JOIN tenants t ON t.id = p.tenant_id
    CROSS JOIN LATERAL (
      SELECT array_agg((random() * 2 - 1)::real)::vector(1024)::halfvec(1024) AS embedding
      FROM generate_series(1, 1024) WHERE p.id IS NOT NULL
    ) v
    WHERE p.tenant_id = ${id}::uuid
  `);

  return id;
};

const randomVector = (): number[] => Array.from({ length: 1024 }, () => Math.random() * 2 - 1);

const percentile = (samples: readonly number[], p: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
};

const round = (ms: number): number => Math.round(ms * 10) / 10;

interface PlanNode {
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

interface Explained {
  readonly 'Planning Time': number;
  readonly 'Execution Time': number;
  readonly Plan: PlanNode;
}

const indexesIn = (node: PlanNode): string[] => [
  ...(node['Index Name'] === undefined ? [] : [node['Index Name']]),
  ...(node.Plans ?? []).flatMap(indexesIn),
];

/**
 * The fused search, once through `EXPLAIN` and once for real, in the winery's
 * own scope: the database's time for it, the indexes its plan used, and the
 * client's time for the whole transaction.
 *
 * The statement is caught on its way to the driver, so what is explained is
 * exactly what `fusedSearch` sends — not a copy of it kept here.
 */
const sample = async (tenantId: string, query: string) => {
  const vector = randomVector();
  const explained = await withTenant(
    tenantId,
    async (tx) => {
      let plan: Explained | undefined;
      const explaining = {
        execute: async (statement: SQL) => {
          const rows = [
            ...(await tx.execute(sql`EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${statement}`)),
          ];
          const raw = rows[0]?.['QUERY PLAN'];
          const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Explained[];

          plan = parsed[0];

          return [];
        },
      } as unknown as DbTransaction;

      await fusedSearch(explaining, { vector, query });

      if (plan === undefined) throw new Error('fusedSearch issued no statement');

      return {
        database: plan['Planning Time'] + plan['Execution Time'],
        indexes: indexesIn(plan.Plan),
      };
    },
    runtime,
  );

  const started = performance.now();
  const rows = await withTenant(tenantId, (tx) => fusedSearch(tx, { vector, query }), runtime);
  const wall = performance.now() - started;

  expect(rows.length, query).toBeGreaterThan(0);

  return { ...explained, wall };
};

interface Measured {
  readonly database: { readonly p50: number; readonly p95: number };
  readonly wall: { readonly p50: number; readonly p95: number };
  /** The database's p95 for each question. */
  readonly byQuestion: Record<string, number>;
  /** Every index any plan used: a plan that changed at size shows up here. */
  readonly indexes: readonly string[];
}

/** Every question, round after round, so a slow minute on the machine falls on all of them alike. */
const measure = async (tenantId: string): Promise<Measured> => {
  const database: number[] = [];
  const wall: number[] = [];
  const perQuestion = new Map<string, number[]>();
  const indexes = new Set<string>();

  for (let r = 0; r < WARMUP + ROUNDS; r += 1) {
    for (const question of QUESTIONS) {
      const taken = await sample(tenantId, question);

      if (r < WARMUP) continue;

      database.push(taken.database);
      wall.push(taken.wall);

      perQuestion.set(question, [...(perQuestion.get(question) ?? []), taken.database]);
      for (const index of taken.indexes) indexes.add(index);
    }
  }

  return {
    database: { p50: round(percentile(database, 50)), p95: round(percentile(database, 95)) },
    wall: { p50: round(percentile(wall, 50)), p95: round(percentile(wall, 95)) },
    byQuestion: Object.fromEntries(
      [...perQuestion].map(([question, times]) => [question, round(percentile(times, 95))]),
    ),
    indexes: [...indexes].sort(),
  };
};

/** The nearest wines by brute force: every vector of the winery, sorted, with no index allowed. */
const exactNearest = async (tenantId: string, vector: readonly number[]): Promise<string[]> =>
  admin.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_indexscan = off`);
    await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);

    const rows = await tx.execute(sql`
      SELECT product_id FROM product_embeddings
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY embedding <=> ${JSON.stringify(vector)}::halfvec, product_id
      LIMIT ${VECTOR_CANDIDATE_LIMIT}
    `);

    return [...rows].map((row) => (row as { product_id: string }).product_id);
  });

describe('retrieval at three times the ceiling', () => {
  it(
    `stays inside ${String(BUDGET_MS)} ms at p95, within ${String(DEGRADATION)}× of two wineries, and exact`,
    async () => {
      const wineries: string[] = [];

      for (let n = 0; n < BASELINE_WINERIES; n += 1) {
        wineries.push(await seedWinery(`base-${String(n)}`));
      }
      await admin.execute(sql`VACUUM ANALYZE tenants, products, product_embeddings`);

      const measured = wineries[0] ?? '';
      const baseline = await measure(measured);
      const seeding = performance.now();

      for (let n = BASELINE_WINERIES; n < CEILING_WINERIES; n += 1) {
        wineries.push(await seedWinery(`more-${String(n)}`));
      }
      await admin.execute(sql`VACUUM ANALYZE tenants, products, product_embeddings`);

      const seeded = performance.now() - seeding;
      const ceiling = await measure(measured);

      /* Exact at the ceiling: the vector branch's forty are the forty nearest, for a sample of questions. */
      for (let i = 0; i < 10; i += 1) {
        const vector = randomVector();
        const found = await withTenant(
          measured,
          (tx) => vectorSearch(tx, { vector, limit: VECTOR_CANDIDATE_LIMIT }),
          runtime,
        );

        expect(found.map(({ productId }) => productId)).toEqual(
          await exactNearest(measured, vector),
        );
      }

      const sizes = await admin.execute(sql`
        SELECT count(*)::int AS vectors,
               current_setting('shared_buffers') AS shared_buffers,
               pg_size_pretty(pg_total_relation_size('product_embeddings')) AS embeddings_total
        FROM product_embeddings
      `);
      const corpus = [...sizes][0] as { vectors: number };

      process.stdout.write(
        `\nretrieval headroom ${JSON.stringify(
          { corpus, seededSeconds: Math.round(seeded / 1000), baseline, ceiling },
          null,
          2,
        )}\n`,
      );

      expect(corpus.vectors).toBe(CEILING_WINERIES * PRODUCTS_PER_WINERY);
      expect(ceiling.database.p95).toBeLessThan(BUDGET_MS);
      expect(ceiling.database.p95).toBeLessThan(baseline.database.p95 * DEGRADATION + SLACK_MS);
    },
    45 * 60_000,
  );
});
