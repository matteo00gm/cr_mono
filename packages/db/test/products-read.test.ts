import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LIMIT,
  decodeCursor,
  isSortField,
  listProducts,
  MAX_LIMIT,
} from '../src/products-read.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The catalogue read builder, without a database (P1-06, P1-08, P1-09).
 *
 * Branches and shapes only. **Whether keyset paging actually covers every row
 * exactly once cannot be asserted here** — the failure modes are a repeated row
 * and a skipped one at a page boundary, which need a real ordering over real
 * rows. That lives in `products-read.integration.test.ts`.
 *
 * What belongs here is the decision-making a container makes expensive to
 * reach: which mode a cursor selects, when the fallback fires, and that the
 * limit is clamped rather than trusted.
 */

interface Captured {
  readonly tx: DbTransaction;
  readonly queries: { limit: number }[];
  readonly rows: { value: unknown }[];
}

/**
 * A select builder that records the calls and returns whatever it was seeded
 * with, one page at a time.
 *
 * Deliberately shallow: it cannot tell a correct `WHERE` from an incorrect one,
 * and pretending otherwise by asserting on Drizzle's internal SQL objects would
 * be a test of Drizzle rather than of this module.
 */
const capturing = (...pages: unknown[][]): Captured => {
  const queries: { limit: number }[] = [];
  let call = 0;

  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: (limit: number) => {
            queries.push({ limit });
            const rows = pages[call] ?? [];
            call += 1;
            return Promise.resolve(rows);
          },
        }),
      }),
    }),
  }));

  return { queries, rows: [], tx: { select } as unknown as DbTransaction };
};

const product = (id: string) => ({ id, createdAt: new Date('2026-09-08T09:14:00.000Z') });

/** Built the way the module builds one: each part encoded, joined with a dot. */
const cursorFor = (value: string, id: string) =>
  [value, id].map((part) => Buffer.from(part, 'utf8').toString('base64url')).join('.');

describe('isSortField', () => {
  it.each(['createdAt', 'updatedAt', 'name', 'priceCents'])('admits %s', (field) => {
    expect(isSortField(field)).toBe(true);
  });

  it.each([
    ['a column that exists but is not sortable', 'contentHash'],
    ['a column that does not exist', 'nonsense'],
    ['something from the prototype', 'toString'],
    ['SQL', 'name; drop table products'],
  ])('refuses %s', (_case, field) => {
    /*
     * `toString` is the one worth having: a plain `field in SORTABLE` check
     * admits every inherited property, so an attacker could name one and reach
     * a value that is not a column at all.
     */
    expect(isSortField(field)).toBe(false);
  });
});

describe('decodeCursor', () => {
  it('round-trips what the module produced', async () => {
    const { tx } = capturing([product('a'), product('b')]);

    const page = await listProducts(tx, { limit: 1 });
    const cursor = page.nextCursor;
    if (cursor === null) throw new Error('expected a cursor');

    expect(decodeCursor(cursor)).toMatchObject({ id: 'a' });
  });

  it.each([
    ['not base64 at all', 'not-base64!!'],
    ['empty', ''],
    ['base64 of the wrong shape', Buffer.from('abc').toString('base64url')],
    ['a missing id', cursorFor('value', '')],
    ['too many parts', 'YWJj.ZGVm.Z2hp'],
  ])('refuses %s', (_case, cursor) => {
    /*
     * A cursor is client-supplied text: it arrives from an old bookmark or a
     * truncated URL. Refusing it here is what lets the caller fall back to the
     * first page rather than throwing — a 500 for a stale bookmark teaches a
     * seller their catalogue is broken.
     */
    expect(decodeCursor(cursor)).toBeUndefined();
  });
});

describe('the limit', () => {
  it('defaults rather than fetching everything', async () => {
    const { tx, queries } = capturing([]);

    await listProducts(tx);

    // One more than asked for, which is how `nextCursor` is decided.
    expect(queries[0]?.limit).toBe(DEFAULT_LIMIT + 1);
  });

  it('is clamped in the statement, not only at the route', async () => {
    const { tx, queries } = capturing([]);

    await listProducts(tx, { limit: 10_000 });

    expect(queries[0]?.limit).toBe(MAX_LIMIT + 1);
  });

  it('refuses to go below one', async () => {
    const { tx, queries } = capturing([]);

    await listProducts(tx, { limit: 0 });

    expect(queries[0]?.limit).toBe(2);
  });
});

describe('paging', () => {
  it('offers no cursor when the extra row did not come back', async () => {
    const { tx } = capturing([product('a'), product('b')]);

    const page = await listProducts(tx, { limit: 5 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('offers one when it did, and drops the extra row from the page', async () => {
    /*
     * The off-by-one a `>= limit` check gets wrong: a full page with nothing
     * after it must not offer "next", or a client fetches an empty page and
     * shows a spinner for it.
     */
    const { tx } = capturing([product('a'), product('b'), product('c')]);

    const page = await listProducts(tx, { limit: 2 });

    expect(page.items.map((row) => row.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('filters and ordering, as branches', () => {
  /**
   * These assert *that the branch runs*, not that the SQL is right.
   *
   * A fake cannot tell a correct `WHERE` from an incorrect one, and asserting
   * on Drizzle's internal expression objects would be a test of Drizzle. That
   * a boundary actually excludes the rows already shown is
   * `products-read.integration.test.ts`. What is worth having here is that no
   * branch throws and that each option is reachable — an ordering that crashed
   * for one sort column would otherwise be found by a seller.
   */
  it.each([
    ['createdAt', 'desc'],
    ['createdAt', 'asc'],
    ['name', 'asc'],
    ['priceCents', 'desc'],
    ['updatedAt', 'asc'],
  ] as const)('orders by %s %s', async (sort, direction) => {
    const { tx, queries } = capturing([product('a')]);

    await listProducts(tx, { sort, direction });

    expect(queries).toHaveLength(1);
  });

  it('applies a boundary in both directions', async () => {
    /*
     * The tie-break flips with the direction — `id <` for descending and `id >`
     * for ascending. Getting that backwards repeats the boundary row on every
     * page, which is invisible until somebody pages.
     */
    for (const direction of ['asc', 'desc'] as const) {
      const { tx, queries } = capturing([product('a')]);

      await listProducts(tx, {
        direction,
        sort: 'name',
        cursor: cursorFor('Barolo Bussia', 'some-id'),
      });

      expect(queries).toHaveLength(1);
    }
  });

  it('carries a cursor whose sort value contains spaces', () => {
    /*
     * **The reason the cursor encodes each part separately.** A `name` cursor
     * carries a wine's name, which contains spaces — and a single-encoding
     * scheme needs a separator that cannot occur in either part.
     */
    expect(decodeCursor(cursorFor('Barolo Bussia Riserva', 'id-1'))).toEqual({
      value: 'Barolo Bussia Riserva',
      id: 'id-1',
    });
  });

  it('shows archived rows when asked', async () => {
    const { tx, queries } = capturing([product('a')]);

    await listProducts(tx, { includeArchived: true });

    expect(queries).toHaveLength(1);
  });
});
