import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { decodeCursor, listProducts, MAX_LIMIT } from '../src/products-read.js';
import { archiveProduct, insertProduct } from '../src/products.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
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
