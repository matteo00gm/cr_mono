import { completenessOf, COMPLETENESS_FIELDS, rangeOfBand } from '@catalogorosso/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';
import process from 'node:process';
import {
  completenessExpression,
  insertProduct,
  listProducts,
  withTenant,
  type Database,
  type ProductInsert,
} from '@catalogorosso/db';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';

/**
 * The completeness filter, against real Postgres (P1-09, deferred to P1-12).
 *
 * **The assertion that matters is that the two scores agree.** `completenessOf`
 * runs in TypeScript and decides what a seller sees beside each wine;
 * `completenessExpression` runs in SQL and decides which wines they see at all.
 * They are different implementations of one definition, which is exactly the
 * arrangement `completeness.ts` opens by warning about — so this drives both
 * over the same rows and compares.
 *
 * A fake cannot do it: the point is what Postgres computes.
 *
 * **It lives in `apps/api` because that is the only place both halves exist.**
 * `packages/core` holds the weights, `packages/db` holds the columns, and `db`
 * cannot import `core` — `core` already depends on it, so the reverse is a
 * cycle the boundary rules refuse. The layer that joins them at runtime is the
 * layer that can test the join.
 */

let harness: TestDatabase | undefined;
let db: Database;
let tenantId: string;

const WEIGHTS = COMPLETENESS_FIELDS.map(([field, weight]) => ({ field, weight }));

const BASE = {
  wineType: 'red',
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK' as const,
};

/** A wine with nothing but the columns it cannot be missing. */
const bare = (sku: string) => ({ ...BASE, sku, name: `Bare ${sku}` }) as ProductInsert;

/** Everything the score reads. */
const full = (sku: string) =>
  ({
    ...BASE,
    sku,
    name: `Full ${sku}`,
    producer: 'Poderi Colla',
    vintage: 2019,
    grapeVarieties: ['Nebbiolo'],
    region: 'Piemonte',
    denomination: 'Barolo DOCG',
    styleTags: ['strutturato'],
    tastingNotes: 'Rosa appassita, catrame e ciliegia sotto spirito.',
    foodPairings: ['brasato'],
    alcoholPct: '14.50',
  }) as ProductInsert;

/** The two heavy fields only — lands in the middle band. */
const middling = (sku: string) =>
  ({
    ...BASE,
    sku,
    name: `Middling ${sku}`,
    tastingNotes: 'Ciliegia e viola.',
    foodPairings: ['pasta al ragù'],
  }) as ProductInsert;

const seed = async (values: ProductInsert) => {
  const created = await withTenant(
    tenantId,
    (tx) => insertProduct(tx, { tenantId, values, contentHash: `h-${values.sku}` }),
    db,
  );

  if (created.outcome !== 'created') throw new Error(`seed failed for ${values.sku}`);
  return created.product;
};

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');
  db = harness.db;
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

/**
 * A tenant, created as admin.
 *
 * `createTenant` lives in `packages/db`'s own test support and is not published,
 * so this suite makes its own — two statements, and the alternative is exporting
 * test helpers from a package for one consumer.
 */
beforeEach(async () => {
  tenantId = randomUUID();

  await harness?.adminDb.execute(sql`
    insert into tenants (id, name, slug)
    values (${tenantId}::uuid, 'completeness', ${`completeness-${tenantId}`})
  `);
});

/** Scopes the shared session, the way `withTenant` does inside a transaction. */
const useTenant = async (tenant: string): Promise<void> => {
  await db.execute(sql`select set_config('app.tenant_id', ${tenant}, false)`);
};

describe('the two scores', () => {
  it('agree on every wine, which is the whole point of the split', async () => {
    /*
     * **`packages/core` owns the weights, `packages/db` owns the columns, and
     * nothing checks that the second implements the first except this.** A
     * presence rule that differs — an empty array counted as filled in, say —
     * would show a seller 60 in the grid and exclude the same wine from a
     * 40-74 filter, with both numbers looking reasonable.
     */
    const rows = [bare('BARE'), middling('MID'), full('FULL')];
    for (const values of rows) await seed(values);

    await useTenant(tenantId);

    const computed = await db.execute(sql`
      select sku, ${completenessExpression(WEIGHTS)}::int as score from products order by sku
    `);

    const inSql = new Map(
      [...computed].map((row) => {
        const r = row as { sku: string; score: number };
        return [r.sku, r.score];
      }),
    );

    const page = await withTenant(tenantId, (tx) => listProducts(tx, {}), db);

    for (const product of page.items) {
      expect(inSql.get(product.sku), `${product.sku} is scored by both`).toBe(
        completenessOf(product).score,
      );
    }

    // And the fixtures actually span the scale, or the agreement above is the
    // agreement of three identical numbers.
    expect(new Set(inSql.values()).size).toBe(3);
    expect(inSql.get('BARE')).toBe(0);
    expect(inSql.get('FULL')).toBe(100);
  });

  it('treat an empty array and an empty string as absent, exactly as the function does', async () => {
    /*
     * The presence rules are written twice — once in `isPresent`, once per
     * column in SQL — because an empty array and a blank string are absent in
     * different syntax. This is the case that separates a careless `IS NOT
     * NULL` from the rule the score actually uses.
     */
    const product = await seed({
      ...BASE,
      sku: 'EMPTY',
      name: 'Empty',
      tastingNotes: '   ',
      foodPairings: [],
      region: '',
    });

    await useTenant(tenantId);

    const rows = await db.execute(sql`
      select ${completenessExpression(WEIGHTS)}::int as score
      from products where id = ${product.id}::uuid
    `);

    expect(([...rows][0] as { score: number } | undefined)?.score).toBe(0);
    expect(completenessOf(product).score).toBe(0);
  });
});

describe('filtering by band', () => {
  beforeEach(async () => {
    await seed(bare('BARE'));
    await seed(middling('MID'));
    await seed(full('FULL'));
  });

  const skusIn = async (band: 'sparse' | 'partial' | 'rich'): Promise<string[]> => {
    const page = await withTenant(
      tenantId,
      (tx) => listProducts(tx, { completeness: { ...rangeOfBand(band), weights: WEIGHTS } }),
      db,
    );

    return page.items.map((item) => item.sku).sort();
  };

  it('returns the wines a seller would call unfinished', async () => {
    expect(await skusIn('sparse')).toEqual(['BARE']);
  });

  it('returns the middle band without the ends', async () => {
    expect(await skusIn('partial')).toEqual(['MID']);
  });

  it('returns the finished ones', async () => {
    expect(await skusIn('rich')).toEqual(['FULL']);
  });

  it('puts every wine in exactly one band', async () => {
    /*
     * The property, rather than three separate counts: a boundary that was
     * exclusive on one side and inclusive on the other would drop a wine out of
     * the catalogue entirely, and no single-band assertion would notice.
     */
    const all = [
      ...(await skusIn('sparse')),
      ...(await skusIn('partial')),
      ...(await skusIn('rich')),
    ];

    expect(all.sort()).toEqual(['BARE', 'FULL', 'MID']);
  });

  it('composes with the other filters rather than replacing them', async () => {
    /*
     * P1-09's actual requirement. A filter that worked alone and not beside a
     * search would be reported as "completeness does nothing when you type in
     * the box", months later.
     */
    const page = await withTenant(
      tenantId,
      (tx) =>
        listProducts(tx, {
          completeness: { ...rangeOfBand('rich'), weights: WEIGHTS },
          grape: 'Nebbiolo',
        }),
      db,
    );

    expect(page.items.map((item) => item.sku)).toEqual(['FULL']);

    const none = await withTenant(
      tenantId,
      (tx) =>
        listProducts(tx, {
          completeness: { ...rangeOfBand('sparse'), weights: WEIGHTS },
          grape: 'Nebbiolo',
        }),
      db,
    );

    expect(none.items).toEqual([]);
  });

  it('narrows a search as well as a list', async () => {
    // The composition that a second query path would have broken quietly.
    const page = await withTenant(
      tenantId,
      (tx) =>
        listProducts(tx, {
          q: 'Full',
          completeness: { ...rangeOfBand('rich'), weights: WEIGHTS },
        }),
      db,
    );

    expect(page.items.map((item) => item.sku)).toEqual(['FULL']);
  });
});

describe('a weight list the caller got wrong', () => {
  it('refuses a field with no column rather than scoring it as absent', async () => {
    /*
     * **Silently skipping it would lower every wine's score by that weight**,
     * and the catalogue would re-band itself with nothing failing. Thrown so a
     * field added to `COMPLETENESS_FIELDS` without a column here is a loud
     * error at the first request rather than a quiet drift.
     */
    await seed(full('FULL'));

    await expect(
      withTenant(
        tenantId,
        (tx) =>
          listProducts(tx, {
            completeness: { min: 0, max: 100, weights: [{ field: 'imaginary', weight: 10 }] },
          }),
        db,
      ),
    ).rejects.toThrow(/no column/);
  });

  it('refuses weights that sum to nothing', () => {
    // Every wine would score the same, so the filter would be a no-op that
    // looked like a filter.
    expect(() => completenessExpression([])).toThrow(/sum to zero/);
  });
});
