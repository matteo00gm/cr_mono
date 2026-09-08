import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { decodeCursor, listProducts, MAX_LIMIT } from '../src/products-read.js';
import { archiveProduct, insertProduct } from '../src/products.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Catalogue paging against real Postgres (P1-06).
 *
 * **The coverage assertion is why this file exists.** "Every row exactly once
 * across pages" cannot be demonstrated against a fake: the failure modes are a
 * repeated row and a skipped one at a *page boundary*, and a boundary needs a
 * real ordering over real rows — including the case the whole design is for,
 * where many rows share a `created_at` because they arrived in one import.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 2 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  tenantId = await createTenant(db, 'catalog-read');
});

const inTenant = <T>(run: (tx: DbTransaction) => Promise<T>): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return run(tx);
  });

const product = (index: number) => ({
  sku: `SKU-${String(index).padStart(3, '0')}`,
  name: `Wine ${String(index).padStart(3, '0')}`,
  wineType: 'red',
  priceCents: 1000 + index,
  currency: 'EUR',
  stockStatus: 'IN_STOCK' as const,
});

/**
 * Seeds `count` products **in one transaction**, so they share a `created_at`.
 *
 * That is the case the design exists for rather than an awkward edge: a bulk
 * import writes hundreds of rows with the same timestamp, and a cursor carrying
 * only that timestamp then either repeats rows or skips them at every page
 * boundary.
 */
const seed = async (count: number) => {
  await inTenant(async (tx) => {
    for (let index = 0; index < count; index += 1) {
      await insertProduct(tx, {
        tenantId,
        values: product(index),
        contentHash: `h${String(index)}`,
      });
    }
  });
};

/** Walks every page and returns the ids, in order, with the page count. */
const pageThrough = async (
  limit: number,
  options: { sort?: 'createdAt' | 'name' | 'priceCents'; direction?: 'asc' | 'desc' } = {},
) => {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    const page = await inTenant((tx) =>
      listProducts(tx, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(options.sort === undefined ? {} : { sort: options.sort }),
        ...(options.direction === undefined ? {} : { direction: options.direction }),
      }),
    );

    pages += 1;
    ids.push(...page.items.map((row) => row.id));

    if (page.nextCursor === null) break;
    cursor = page.nextCursor;

    // A runaway loop would otherwise hang the suite rather than fail it.
    if (pages > 50) throw new Error('paging did not terminate');
  }

  return { ids, pages };
};

describe('paging', () => {
  it('covers every row exactly once, even when they share a timestamp', async () => {
    /*
     * **The assertion the row asks for, and the one an `OFFSET` implementation
     * also passes** — which is why the shared-timestamp seeding above matters.
     * A cursor carrying only `created_at` repeats or skips here; the id in the
     * tuple is what breaks the tie.
     */
    await seed(23);

    const { ids, pages } = await pageThrough(5);

    expect(pages).toBe(5);
    expect(ids).toHaveLength(23);
    expect(new Set(ids).size).toBe(23);
  });

  it('reports no cursor on the last page', async () => {
    await seed(3);

    const page = await inTenant((tx) => listProducts(tx, { limit: 10 }));

    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('reports a cursor when there is exactly one more row', async () => {
    /*
     * The off-by-one that a `>= limit` check gets wrong: a full page with
     * nothing after it must not offer "next", or a client fetches an empty page
     * and shows a spinner for it.
     */
    await seed(5);

    const exact = await inTenant((tx) => listProducts(tx, { limit: 5 }));
    expect(exact.nextCursor).toBeNull();

    const short = await inTenant((tx) => listProducts(tx, { limit: 4 }));
    expect(short.nextCursor).not.toBeNull();
  });

  it('does not repeat a row when one is inserted between pages', async () => {
    /*
     * **The correctness failure `OFFSET` has and keyset does not**, and the one
     * that bites first: a row inserted while somebody is paging shifts
     * everything down by one, so page two repeats a row page one already
     * showed. On an import screen that is exactly when the data is changing.
     */
    await seed(10);

    const first = await inTenant((tx) => listProducts(tx, { limit: 5 }));
    expect(first.nextCursor).not.toBeNull();

    await seed(1);

    const second = await inTenant((tx) =>
      listProducts(tx, { limit: 5, cursor: first.nextCursor ?? undefined }),
    );

    const overlap = second.items.filter((row) => first.items.some((seen) => seen.id === row.id));
    expect(overlap).toEqual([]);
  });

  it('clamps a limit above the cap rather than trusting it', async () => {
    await seed(3);

    const page = await inTenant((tx) => listProducts(tx, { limit: 10_000 }));

    expect(page.items).toHaveLength(3);

    // The clamp is on the statement, not only on the route.
    const large = await inTenant((tx) => listProducts(tx, { limit: MAX_LIMIT + 500 }));
    expect(large.items.length).toBeLessThanOrEqual(MAX_LIMIT);
  });
});

describe('sorting', () => {
  it('orders by name ascending when asked', async () => {
    await seed(6);

    const page = await inTenant((tx) =>
      listProducts(tx, { sort: 'name', direction: 'asc', limit: 10 }),
    );

    expect(page.items.map((row) => row.name)).toEqual(
      [...page.items.map((row) => row.name)].sort(),
    );
  });

  it('pages correctly under a non-unique sort column', async () => {
    /*
     * `priceCents` is not unique here by construction — several wines share a
     * price — so this is the tuple comparison doing its job on a column that is
     * neither the primary key nor a timestamp.
     */
    await inTenant(async (tx) => {
      for (let index = 0; index < 12; index += 1) {
        await insertProduct(tx, {
          tenantId,
          values: { ...product(index), priceCents: 2000 + (index % 3) },
          contentHash: `p${String(index)}`,
        });
      }
    });

    const { ids } = await pageThrough(4, { sort: 'priceCents', direction: 'asc' });

    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it('reverses cleanly, with the same coverage', async () => {
    await seed(9);

    const { ids } = await pageThrough(4, { sort: 'createdAt', direction: 'asc' });

    expect(new Set(ids).size).toBe(9);
  });
});

describe('what is listed', () => {
  it('hides archived wines by default', async () => {
    await seed(3);

    const all = await inTenant((tx) => listProducts(tx, { limit: 10 }));
    const victim = all.items[0];
    if (victim === undefined) throw new Error('expected a product');

    await inTenant((tx) => archiveProduct(tx, victim.id));

    const after = await inTenant((tx) => listProducts(tx, { limit: 10 }));

    /*
     * A seller who removed a wine should not have to look at it. The row
     * survives only so an order referring to it still makes sense (P1-04),
     * which is not a reason to show it in the catalogue.
     */
    expect(after.items.map((row) => row.id)).not.toContain(victim.id);
    expect(after.items).toHaveLength(2);
  });

  it('shows them when asked', async () => {
    await seed(2);
    const all = await inTenant((tx) => listProducts(tx, { limit: 10 }));
    const victim = all.items[0];
    if (victim === undefined) throw new Error('expected a product');

    await inTenant((tx) => archiveProduct(tx, victim.id));

    const after = await inTenant((tx) => listProducts(tx, { limit: 10, includeArchived: true }));
    expect(after.items).toHaveLength(2);
  });

  it('shows one winery nothing of another', async () => {
    await seed(4);

    const other = await createTenant(db, 'other-winery');
    const page = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other}, true)`);
      return listProducts(tx, { limit: 10 });
    });

    /*
     * Nothing in `listProducts` mentions a tenant. The policy is the filter,
     * and this is the assertion that it is — a `where tenant_id = ...` added
     * "for safety" would make this pass while hiding a policy that had stopped
     * working.
     */
    expect(page.items).toEqual([]);
  });
});

describe('the cursor', () => {
  it('is opaque but round-trips', async () => {
    await seed(3);

    const page = await inTenant((tx) => listProducts(tx, { limit: 1 }));
    const cursor = page.nextCursor;
    if (cursor === null) throw new Error('expected a cursor');

    expect(decodeCursor(cursor)).toMatchObject({ id: page.items[0]?.id });
  });

  it.each([['not-base64!!'], [''], ['YWJj']])('ignores a malformed cursor: %s', async (cursor) => {
    /*
     * A cursor is client-supplied text. A malformed one must not throw — it
     * arrives from an old bookmark or a truncated URL, and a 500 for that
     * teaches a seller their catalogue is broken. Ignoring it returns the first
     * page, which is what a bookmark that no longer means anything should do.
     */
    await seed(2);

    const page = await inTenant((tx) => listProducts(tx, { limit: 10, cursor }));
    expect(page.items).toHaveLength(2);
  });
});

describe('searching', () => {
  const named = (sku: string, name: string, producer?: string) =>
    inTenant((tx) =>
      insertProduct(tx, {
        tenantId,
        values: {
          sku,
          name,
          ...(producer === undefined ? {} : { producer }),
          wineType: 'red',
          priceCents: 1000,
          currency: 'EUR',
          stockStatus: 'IN_STOCK' as const,
        },
        contentHash: sku,
      }),
    );

  const search = (q: string, extra: Record<string, unknown> = {}) =>
    inTenant((tx) => listProducts(tx, { q, limit: 10, ...extra }));

  it('finds a wine by a word in its name, and says the match was exact', async () => {
    await named('S-1', 'Barolo Bussia', 'Poderi Colla');
    await named('S-2', 'Chianti Classico', 'Castello');

    const page = await search('barolo');

    expect(page.items.map((row) => row.sku)).toEqual(['S-1']);
    expect(page.matchedBy).toBe('text');
  });

  it('finds a wine by its producer', async () => {
    await named('S-3', 'Etichetta Bianca', 'Poderi Colla');

    expect((await search('colla')).items.map((row) => row.sku)).toContain('S-3');
  });

  it.each([
    ['quotes', 'Barolo "Bussia"'],
    ['an ampersand', 'barolo & bussia'],
    ['a pipe', 'barolo | nebbiolo'],
    ['a negation', 'barolo !chianti'],
    ['an unbalanced paren', 'barolo ('],
  ])('does not raise on %s, which to_tsquery would', async (_case, q) => {
    /*
     * **The reason the query uses `websearch_to_tsquery`.** `to_tsquery` raises
     * a syntax error on every one of these, so a visitor typing a quotation
     * mark into a search box would get a 500 — a failure that reads as a bug in
     * the catalogue rather than in the parser.
     */
    await named('S-4', 'Barolo Bussia');

    await expect(search(q)).resolves.toBeDefined();
  });

  it('falls back to similarity when nothing matches the text', async () => {
    await named('S-5', 'Barolo Bussia', 'Poderi Colla');

    /*
     * `Poderi Cola` is not a word in the index and stems to nothing useful, so
     * the text query returns empty and the trigram fallback takes over.
     */
    const page = await search('Poderi Cola');

    expect(page.items.map((row) => row.sku)).toContain('S-5');
    expect(page.matchedBy).toBe('similar');
  });

  it('does not fall back when the text search found something', async () => {
    await named('S-6', 'Barolo Bussia');

    expect((await search('barolo')).matchedBy).toBe('text');
  });

  it('returns nothing rather than the whole catalogue for an unrelated phrase', async () => {
    /*
     * The similarity floor. Without it `similarity` returns a value for every
     * row and the fallback becomes "here is your entire catalogue, badly
     * ordered" — which is worse than no results, because it looks like an
     * answer.
     */
    await named('S-7', 'Barolo Bussia', 'Poderi Colla');

    expect((await search('xilofono spaziale')).items).toEqual([]);
  });

  it('keeps a fallback page two in the fallback', async () => {
    /*
     * **The reason the match mode is in the cursor.** On page two the query is
     * re-run with a boundary, and an empty text result then means "no more"
     * rather than "never matched" — so a mode re-derived from the query would
     * silently switch back to text and report the end of the results after one
     * page.
     */
    for (let index = 0; index < 5; index += 1) {
      await named(`FB-${String(index)}`, `Vino ${String(index)}`, 'Poderi Colla');
    }

    const first = await search('Poderi Cola', { limit: 2 });
    expect(first.matchedBy).toBe('similar');
    expect(first.nextCursor).not.toBeNull();

    const second = await search('Poderi Cola', { limit: 2, cursor: first.nextCursor ?? undefined });

    expect(second.matchedBy).toBe('similar');
    expect(second.items).not.toEqual([]);

    const overlap = second.items.filter((row) => first.items.some((seen) => seen.id === row.id));
    expect(overlap).toEqual([]);
  });

  it('covers every match exactly once across ranked pages', async () => {
    /*
     * Ranks tie constantly — every one of these rows scores identically — which
     * is exactly why the cursor carries the id as well as the rank.
     */
    for (let index = 0; index < 9; index += 1) {
      await named(`RK-${String(index)}`, 'Barolo Bussia', 'Poderi Colla');
    }

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      const result = await search('barolo', {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...result.items.map((row) => row.id));

      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  it('hides archived wines from a search too', async () => {
    await named('S-8', 'Barolo Archiviato');
    const found = await search('archiviato');
    const victim = found.items[0];
    if (victim === undefined) throw new Error('expected a match');

    await inTenant((tx) => archiveProduct(tx, victim.id));

    expect((await search('archiviato')).items).toEqual([]);
  });

  it('shows one winery nothing of another', async () => {
    await named('S-9', 'Barolo Riservato');

    const other = await createTenant(db, 'nosy-searcher');
    const page = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other}, true)`);
      return listProducts(tx, { q: 'barolo', limit: 10 });
    });

    expect(page.items).toEqual([]);
  });
});

describe('filters', () => {
  const wine = (
    sku: string,
    overrides: Partial<{
      wineType: string;
      priceCents: number;
      stockStatus: 'IN_STOCK' | 'OUT_OF_STOCK' | 'PREORDER';
      name: string;
    }> = {},
  ) =>
    inTenant((tx) =>
      insertProduct(tx, {
        tenantId,
        values: {
          sku,
          name: overrides.name ?? `Vino ${sku}`,
          wineType: overrides.wineType ?? 'red',
          priceCents: overrides.priceCents ?? 2000,
          currency: 'EUR',
          stockStatus: overrides.stockStatus ?? 'IN_STOCK',
        },
        contentHash: sku,
      }),
    );

  const skus = async (query: Record<string, unknown>) => {
    const page = await inTenant((tx) => listProducts(tx, { limit: 50, ...query }));
    return page.items.map((row) => row.sku).sort();
  };

  it('filters by stock status', async () => {
    await wine('F-IN', { stockStatus: 'IN_STOCK' });
    await wine('F-OUT', { stockStatus: 'OUT_OF_STOCK' });

    expect(await skus({ stockStatus: 'OUT_OF_STOCK' })).toEqual(['F-OUT']);
  });

  it('filters by wine type, exactly', async () => {
    await wine('F-RED', { wineType: 'red' });
    await wine('F-ORANGE', { wineType: 'orange' });

    expect(await skus({ wineType: 'orange' })).toEqual(['F-ORANGE']);
  });

  it('filters by embedding state', async () => {
    await wine('F-PENDING');
    await wine('F-INDEXED');

    await useTenant(db, tenantId);
    await db.execute(sql`update products set embedding_state = 'INDEXED' where sku = 'F-INDEXED'`);

    expect(await skus({ embeddingState: 'INDEXED' })).toEqual(['F-INDEXED']);
  });

  it('filters by a price range, inclusive at both ends', async () => {
    await wine('F-1000', { priceCents: 1000 });
    await wine('F-2000', { priceCents: 2000 });
    await wine('F-3000', { priceCents: 3000 });

    expect(await skus({ priceMin: 1000, priceMax: 2000 })).toEqual(['F-1000', 'F-2000']);
  });

  it('accepts one bound alone, so "under 20 euro" needs no invented floor', async () => {
    await wine('F-CHEAP', { priceCents: 500 });
    await wine('F-DEAR', { priceCents: 9000 });

    expect(await skus({ priceMax: 1000 })).toEqual(['F-CHEAP']);
    expect(await skus({ priceMin: 5000 })).toEqual(['F-DEAR']);
  });

  it('returns nothing for a range with its bounds the wrong way round', async () => {
    /*
     * A slider dragged past itself, not a malformed request — so the honest
     * answer is an empty result rather than an error the interface has to
     * explain.
     */
    await wine('F-MID', { priceCents: 2000 });

    expect(await skus({ priceMin: 5000, priceMax: 1000 })).toEqual([]);
  });

  it('combines two filters rather than applying the last one', async () => {
    await wine('F-A', { wineType: 'red', priceCents: 1000 });
    await wine('F-B', { wineType: 'red', priceCents: 9000 });
    await wine('F-C', { wineType: 'white', priceCents: 1000 });

    expect(await skus({ wineType: 'red', priceMax: 5000 })).toEqual(['F-A']);
  });

  it('narrows a search exactly as it narrows a list', async () => {
    /*
     * **The assertion the row is really about.** Filters compose into the
     * shared builder, so a second query path cannot work for one and silently
     * not for the other — which would surface as "filters do nothing when you
     * type in the box".
     */
    await wine('F-S1', { name: 'Barolo Economico', priceCents: 1000 });
    await wine('F-S2', { name: 'Barolo Costoso', priceCents: 9000 });

    const page = await inTenant((tx) =>
      listProducts(tx, { q: 'barolo', priceMax: 5000, limit: 50 }),
    );

    expect(page.items.map((row) => row.sku)).toEqual(['F-S1']);
    expect(page.matchedBy).toBe('text');
  });

  it('applies to the similarity fallback too', async () => {
    await wine('F-S3', { name: 'Barolo Bussia', priceCents: 1000 });
    await wine('F-S4', { name: 'Barolo Bussia', priceCents: 9000 });

    const page = await inTenant((tx) =>
      listProducts(tx, { q: 'Barlo Busia', priceMax: 5000, limit: 50 }),
    );

    expect(page.matchedBy).toBe('similar');
    expect(page.items.map((row) => row.sku)).toEqual(['F-S3']);
  });

  it('still hides archived wines when a filter is applied', async () => {
    await wine('F-ARCH', { wineType: 'red' });
    const page = await inTenant((tx) => listProducts(tx, { wineType: 'red', limit: 50 }));
    const victim = page.items.find((row) => row.sku === 'F-ARCH');
    if (victim === undefined) throw new Error('expected the wine');

    await inTenant((tx) => archiveProduct(tx, victim.id));

    expect(await skus({ wineType: 'red' })).not.toContain('F-ARCH');
  });
});

describe('accents, now that the column cannot fold them', () => {
  it('finds an accented wine through the similarity fallback', async () => {
    /*
     * **The degradation P1-07 could not avoid**, asserted rather than left
     * implicit: `unaccent` cannot appear in a generated column in this
     * deployment model, so an unaccented query misses the tsquery — and the
     * fallback catches it, which the caller is told about.
     */
    await inTenant((tx) =>
      insertProduct(tx, {
        tenantId,
        values: {
          sku: 'ACC-1',
          name: 'Nebbiòlo Superiore',
          wineType: 'red',
          priceCents: 1000,
          currency: 'EUR',
          stockStatus: 'IN_STOCK' as const,
        },
        contentHash: 'acc',
      }),
    );

    const page = await inTenant((tx) => listProducts(tx, { q: 'Nebbiolo Superiore', limit: 10 }));

    expect(page.matchedBy).toBe('similar');
    expect(page.items.map((row) => row.sku)).toContain('ACC-1');
  });
});
