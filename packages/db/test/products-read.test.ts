import { describe, expect, it, vi } from 'vitest';

import {
  CURSOR_DECODERS,
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
const cursorFor = (mode: string, value: string, id: string) =>
  [mode, value, id].map((part) => Buffer.from(part, 'utf8').toString('base64url')).join('.');
const ranked = (id: string, rank: number) => ({ product: product(id), rank });

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

    expect(decodeCursor(cursor)).toMatchObject({ mode: 'column', id: 'a' });
  });

  it.each([
    ['not base64 at all', 'not-base64!!'],
    ['empty', ''],
    ['base64 of the wrong shape', Buffer.from('abc').toString('base64url')],
    ['a mode nothing produces', cursorFor('sideways', 'x', 'id')],
    ['a missing id', cursorFor('column', 'value', '')],
    ['too few parts', 'YWJj.ZGVm'],
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

describe('searching', () => {
  it('reports a text match as text', async () => {
    const { tx } = capturing([ranked('a', 0.9)]);

    expect((await listProducts(tx, { q: 'barolo' })).matchedBy).toBe('text');
  });

  it('falls back to similarity when the text query found nothing', async () => {
    const { tx, queries } = capturing([], [ranked('a', 0.4)]);

    const page = await listProducts(tx, { q: 'poderi cola' });

    expect(page.matchedBy).toBe('similar');
    expect(page.items.map((row) => row.id)).toEqual(['a']);
    // Two statements: the text attempt, then the fallback.
    expect(queries).toHaveLength(2);
  });

  it('does not fall back when the text query found something', async () => {
    const { tx, queries } = capturing([ranked('a', 0.9)]);

    await listProducts(tx, { q: 'barolo' });

    expect(queries).toHaveLength(1);
  });

  it('does not fall back on a later page, even when it comes back empty', async () => {
    /*
     * **The half the mode-in-the-cursor design is really for.** A later page
     * that ran out of text matches has simply ended; retrying it as a
     * similarity search would append a second, differently-ranked result set to
     * the end of the first and repeat rows it had already shown.
     */
    const cursor = cursorFor('text', '0.5', 'some-id');
    const { tx, queries } = capturing([]);

    const page = await listProducts(tx, { q: 'barolo', cursor });

    expect(page.items).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it('stays in the fallback when the cursor says it was in one', async () => {
    const cursor = cursorFor('similar', '0.4', 'some-id');
    const { tx } = capturing([ranked('b', 0.3)]);

    expect((await listProducts(tx, { q: 'poderi cola', cursor })).matchedBy).toBe('similar');
  });

  it('treats a whitespace-only phrase as no search at all', async () => {
    /*
     * Otherwise a search box the user cleared runs a text query for nothing,
     * finds nothing, falls back to a similarity query for nothing, and reports
     * an empty catalogue.
     */
    const { tx, queries } = capturing([product('a')]);

    const page = await listProducts(tx, { q: '   ' });

    expect(page.matchedBy).toBe('column');
    expect(queries).toHaveLength(1);
  });
});

describe('ordering and the boundary', () => {
  /**
   * These assert *that the branch runs*, not that the SQL is right. A fake
   * cannot tell a correct `WHERE` from an incorrect one, and asserting on
   * Drizzle's internal expression objects would be a test of Drizzle. That a
   * boundary actually excludes the rows already shown is
   * `products-read.integration.test.ts`.
   */
  it.each([
    ['createdAt', 'desc'],
    ['createdAt', 'asc'],
    ['name', 'asc'],
    ['priceCents', 'desc'],
    ['updatedAt', 'asc'],
  ] as const)('orders by %s %s', async (sort, direction) => {
    const { tx } = capturing([product('a')]);

    const page = await listProducts(tx, { sort, direction });

    expect(page.matchedBy).toBe('column');
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
        cursor: cursorFor('column', 'Barolo Bussia', 'some-id'),
      });

      expect(queries).toHaveLength(1);
    }
  });

  it('carries a cursor whose sort value contains spaces', () => {
    /*
     * **The reason the cursor encodes each part separately.** A `name` cursor
     * carries a wine's name, which contains spaces — and a single-encoding
     * scheme needs a separator that cannot occur in any part. The first version
     * used a NUL byte, which worked and made the source a binary file to
     * `grep`.
     */
    expect(decodeCursor(cursorFor('column', 'Barolo Bussia Riserva', 'id-1'))).toEqual({
      mode: 'column',
      value: 'Barolo Bussia Riserva',
      id: 'id-1',
    });
  });

  it('applies a boundary to a ranked page', async () => {
    const { tx, queries } = capturing([ranked('a', 0.4)]);

    await listProducts(tx, { q: 'barolo', cursor: cursorFor('text', '0.9', 'some-id') });

    expect(queries).toHaveLength(1);
  });
});

describe('the search cursor', () => {
  it('is produced when there is another page of matches', async () => {
    /*
     * The rank has to travel in the cursor: paging by relevance needs the
     * boundary to be the rank of the last row shown, and asking the client to
     * recompute it would mean publishing the ranking function as part of the
     * API.
     */
    const { tx } = capturing([ranked('a', 0.9), ranked('b', 0.4)]);

    const page = await listProducts(tx, { q: 'barolo', limit: 1 });

    expect(page.items.map((row) => row.id)).toEqual(['a']);
    expect(decodeCursor(page.nextCursor ?? '')).toEqual({
      mode: 'text',
      value: '0.9',
      id: 'a',
    });
  });

  it('says similar when the fallback produced it', async () => {
    const { tx } = capturing([], [ranked('a', 0.5), ranked('b', 0.3)]);

    const page = await listProducts(tx, { q: 'poderi cola', limit: 1 });

    expect(decodeCursor(page.nextCursor ?? '')).toMatchObject({ mode: 'similar' });
  });

  it('builds a page with no conditions at all when archived rows are wanted', async () => {
    /*
     * The only combination that leaves the condition list empty — and a `where`
     * built from an empty list is `where ()`, which is a syntax error rather
     * than "everything".
     */
    const { tx, queries } = capturing([product('a')]);

    await listProducts(tx, { includeArchived: true });

    expect(queries).toHaveLength(1);
  });
});

describe('the cursor value, decoded back to the column type', () => {
  /**
   * **A cursor is text and a column is not.** Drizzle maps a bound parameter
   * through the column's own `mapToDriverValue`, so a string handed to a
   * `timestamp` comparison reaches `value.toISOString()` and throws — page two
   * of the *default* sort was a 500 until the integration suite found it.
   *
   * A fake transaction cannot see that, because it never maps driver values.
   * What is assertable here is the half that is ours: each sortable column's
   * cursor value comes back as the kind of thing that column compares against,
   * and the table is keyed by `SortField` so a new sortable column is a compile
   * error until somebody says which.
   */
  it('decodes a timestamp cursor to a Date', () => {
    expect(CURSOR_DECODERS.createdAt('2026-09-08T09:14:00.000Z')).toBeInstanceOf(Date);
    expect(CURSOR_DECODERS.updatedAt('2026-09-08T09:14:00.000Z')).toBeInstanceOf(Date);
  });

  it('decodes a numeric cursor to a number, not a numeric string', () => {
    expect(CURSOR_DECODERS.priceCents('4500')).toBe(4500);
  });

  it('leaves a text cursor alone', () => {
    expect(CURSOR_DECODERS.name('Barolo Bussia')).toBe('Barolo Bussia');
  });

  it('round-trips a timestamp exactly, so the boundary lands on the right row', () => {
    /*
     * A boundary a millisecond off either repeats the last row of the previous
     * page or skips the first of the next — and both are invisible until
     * somebody counts.
     */
    const at = new Date('2026-09-08T09:14:00.123Z');
    const decoded = CURSOR_DECODERS.createdAt(at.toISOString());

    expect((decoded as Date).getTime()).toBe(at.getTime());
  });

  it('runs the boundary without throwing for every sortable column', async () => {
    for (const sort of ['createdAt', 'updatedAt', 'name', 'priceCents'] as const) {
      const { tx, queries } = capturing([product('a')]);

      await listProducts(tx, {
        sort,
        cursor: cursorFor('column', '2026-09-08T09:14:00.000Z', 'id-1'),
      });

      expect(queries).toHaveLength(1);
    }
  });
});
