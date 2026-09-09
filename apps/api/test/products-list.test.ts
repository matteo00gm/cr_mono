import { productListResponse } from '@catalogorosso/api-client';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { ListProductsCommand, ProductsPort } from '../src/products.js';
import { oneMembership, signedIn } from './support/auth.js';
import { productsPort, storedProduct } from './support/products.js';

/**
 * `GET /v1/dashboard/products` (P1-06).
 *
 * The surface: what a query parameter is allowed to be, and what happens when
 * it is not. **That pagination covers every row exactly once is a property of
 * real data and a real ordering**, and is asserted in
 * `packages/db/test/products-read.integration.test.ts` — a fake page cannot
 * demonstrate that a keyset boundary neither repeats nor skips.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const PATH = '/v1/dashboard/products';

const queries: ListProductsCommand[] = [];

const port = (overrides: Partial<ProductsPort> = {}): ProductsPort =>
  productsPort({
    list: (command) => {
      queries.push(command);
      return Promise.resolve({ items: [storedProduct()], nextCursor: null, matchedBy: 'column' });
    },
    ...overrides,
  });

const app = (role: 'OWNER' | 'EDITOR' = 'EDITOR', products: Partial<ProductsPort> = {}) =>
  createApp({
    auth: signedIn(),
    readMemberships: oneMembership(TENANT, role),
    products: port(products),
  });

const get = (built: ReturnType<typeof createApp>, query = '') => built.request(`${PATH}${query}`);

describe('listing the catalogue', () => {
  it('returns a page and a cursor', async () => {
    queries.length = 0;

    const response = await get(app());
    const body = (await response.json()) as { items: unknown[]; nextCursor: string | null };

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });

  it('emits the published shape and nothing more', async () => {
    const strict = productListResponse.strict().safeParse(await (await get(app())).json());

    expect(strict.error?.issues ?? []).toEqual([]);
  });

  it('projects each row, so no internal column rides along in a list', async () => {
    /*
     * The leak P1-02 fixed, checked on the plural path too — which is where it
     * would matter more, since a list is what a client caches.
     */
    const body = (await (await get(app())).json()) as { items: Record<string, unknown>[] };

    expect(body.items[0]).not.toHaveProperty('contentHash');
    expect(body.items[0]).not.toHaveProperty('tenantId');
  });

  it('takes the tenant from the membership', async () => {
    queries.length = 0;
    await get(app());

    expect(queries[0]?.tenantId).toBe(TENANT);
  });

  it('passes the cursor through untouched', async () => {
    queries.length = 0;
    await get(app(), '?cursor=abc123');

    expect(queries[0]?.cursor).toBe('abc123');
  });

  it('hides archived wines unless asked', async () => {
    queries.length = 0;

    await get(app());
    expect(queries[0]?.includeArchived).toBeUndefined();

    await get(app(), '?includeArchived=true');
    expect(queries[1]?.includeArchived).toBe(true);
  });
});

describe('the sort parameter, which is the one that names a column', () => {
  it.each(['createdAt', 'updatedAt', 'name', 'priceCents'])('accepts %s', async (sort) => {
    queries.length = 0;

    expect((await get(app(), `?sort=${sort}`)).status).toBe(200);
    expect(queries[0]?.sort).toBe(sort);
  });

  it.each([
    ['a column that exists but is not sortable', 'contentHash'],
    ['a column that does not exist', 'nonsense'],
    ['SQL', 'name; drop table products'],
    ['an expression', '(select 1)'],
  ])('refuses %s and reaches no query builder', async (_case, sort) => {
    queries.length = 0;

    const response = await get(app(), `?sort=${encodeURIComponent(sort)}`);

    /*
     * **Refused rather than ignored**, which is the half a fallback would get
     * wrong: silently sorting by `createdAt` leaves a caller convinced they are
     * sorting by something else, and the bug surfaces as "the grid is in the
     * wrong order" long after anybody would look here.
     *
     * The allowlist in `packages/db` maps names to *column objects*, so an
     * unknown name has nothing to reach even if this check were removed — which
     * is what makes the injection cases uninteresting rather than frightening.
     */
    expect(response.status).toBe(422);
    expect(queries).toEqual([]);
  });

  it('refuses an unknown direction', async () => {
    expect((await get(app(), '?direction=sideways')).status).toBe(422);
  });
});

describe('the limit', () => {
  it('is passed through when it is reasonable', async () => {
    queries.length = 0;
    await get(app(), '?limit=10');

    expect(queries[0]?.limit).toBe(10);
  });

  it('refuses one above the cap rather than silently clamping at the edge', async () => {
    /*
     * The clamp lives in `packages/db` and applies to whatever arrives, so this
     * is belt and braces — but a request for 5000 is a client bug worth telling
     * somebody about, where quietly returning 100 teaches them their limit
     * works.
     */
    expect((await get(app(), '?limit=5000')).status).toBe(422);
  });

  it.each(['0', '-1', '1.5', 'ten'])('refuses limit=%s', async (limit) => {
    expect((await get(app(), `?limit=${limit}`)).status).toBe(422);
  });
});

describe('who may call it', () => {
  it('lets a reader read, which is what catalog:read is for', async () => {
    expect((await get(app('EDITOR'))).status).toBe(200);
    expect((await get(app('OWNER'))).status).toBe(200);
  });
});

describe('searching', () => {
  it('passes the phrase through and reports an exact match as exact', async () => {
    queries.length = 0;

    const response = await get(
      app('EDITOR', {
        list: (command) => {
          queries.push(command);
          return Promise.resolve({
            items: [storedProduct()],
            nextCursor: null,
            matchedBy: 'text',
          });
        },
      }),
      '?q=barolo',
    );

    expect(queries[0]?.q).toBe('barolo');
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      matchedBy: 'exact',
    });
  });

  it('says when the results are only similar', async () => {
    /*
     * **The reason this field exists.** A fallback presented as an exact match
     * leads a seller to conclude their catalogue contains something it does not
     * — and the wrong conclusion is the one the interface encouraged.
     */
    const response = await get(
      app('EDITOR', {
        list: () =>
          Promise.resolve({ items: [storedProduct()], nextCursor: null, matchedBy: 'similar' }),
      }),
      '?q=poderi%20cola',
    );

    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      matchedBy: 'similar',
    });
  });

  it('reports no match mode when there was no search', async () => {
    /*
     * `column` is the absence of a search rather than a third kind of match, so
     * it reports as null: a client should not have to know that listing and
     * searching share an implementation.
     */
    const body = (await (await get(app())).json()) as { matchedBy: unknown };

    expect(body.matchedBy).toBeNull();
  });

  it('trims a phrase and refuses an empty one', async () => {
    queries.length = 0;

    await get(app(), '?q=%20%20barolo%20%20');
    expect(queries[0]?.q).toBe('barolo');

    expect((await get(app(), '?q=%20%20')).status).toBe(422);
  });

  it('refuses a phrase long enough to be an attack on the parser', async () => {
    /*
     * Not injectable — it is a bound parameter to `websearch_to_tsquery` — but
     * both the parse and the trigram comparison are work proportional to its
     * length, so a 10,000-character "search" is a cheap way to make the
     * database do something expensive.
     */
    expect((await get(app(), `?q=${'a'.repeat(5000)}`)).status).toBe(422);
  });

  it.each([
    ['quotes', 'Barolo "Bussia"'],
    ['boolean operators', 'barolo & bussia | nebbiolo'],
    ['a negation', '!barolo'],
    ['an unbalanced paren', 'barolo ('],
  ])('accepts %s, which to_tsquery would have thrown on', async (_case, q) => {
    /*
     * The reason the query uses `websearch_to_tsquery`. `to_tsquery` raises on
     * all of these, so a visitor typing a quotation mark would get a 500 — a
     * failure that looks like a bug in the catalogue rather than in the parser.
     */
    expect((await get(app(), `?q=${encodeURIComponent(q)}`)).status).toBe(200);
  });
});

describe('filters', () => {
  it('passes each one through', async () => {
    queries.length = 0;

    await get(
      app(),
      '?stockStatus=IN_STOCK&wineType=red&embeddingState=INDEXED&priceMin=1000&priceMax=5000',
    );

    expect(queries[0]).toMatchObject({
      stockStatus: 'IN_STOCK',
      wineType: 'red',
      embeddingState: 'INDEXED',
      priceMin: 1000,
      priceMax: 5000,
    });
  });

  it('narrows a search as well as a list', async () => {
    /*
     * **The row's real requirement**, and the reason the filters compose into
     * the shared builder rather than getting their own query path. A second
     * path would work for the list and quietly not for the search, and the bug
     * would be "filters do nothing when you type in the box" — reported by a
     * seller, months later.
     */
    queries.length = 0;

    await get(app(), '?q=barolo&stockStatus=OUT_OF_STOCK');

    expect(queries[0]).toMatchObject({ q: 'barolo', stockStatus: 'OUT_OF_STOCK' });
  });

  it.each([
    ['an unknown stock status', 'stockStatus=MAYBE'],
    ['an unknown embedding state', 'embeddingState=THINKING'],
    ['a negative price floor', 'priceMin=-1'],
    ['a fractional price ceiling', 'priceMax=19.99'],
    ['a non-numeric price', 'priceMin=cheap'],
    ['an empty wine type', 'wineType='],
  ])('refuses %s rather than ignoring it', async (_case, query) => {
    /*
     * Refused, not dropped. A filter that is silently ignored shows a seller
     * more wines than they asked for and lets them conclude the catalogue holds
     * something it does not — the same failure `matchedBy` exists to prevent,
     * arrived at from the other direction.
     */
    queries.length = 0;

    expect((await get(app(), `?${query}`)).status).toBe(422);
    expect(queries).toEqual([]);
  });

  it('accepts a wine type the schema has never heard of', async () => {
    /*
     * `wine_type` is `text` rather than an enum (P0-26) because the taxonomy
     * grows sideways. Enumerating it in the API would reintroduce exactly that
     * coupling one layer up, and the failure would be a filter that rejects a
     * wine type the catalogue already contains.
     */
    queries.length = 0;

    expect((await get(app(), '?wineType=pét-nat')).status).toBe(200);
    expect(queries[0]?.wineType).toBe('pét-nat');
  });

  it('accepts one bound without inventing the other', async () => {
    queries.length = 0;

    await get(app(), '?priceMax=2000');

    expect(queries[0]?.priceMax).toBe(2000);
    expect(queries[0]?.priceMin).toBeUndefined();
  });
});

describe('the grape filter, which is not a convenience', () => {
  it('passes a grape through', async () => {
    queries.length = 0;

    await get(app(), '?grape=Nebbiolo');

    expect(queries[0]?.grape).toBe('Nebbiolo');
  });

  it('is the only way to ask for a grape, because search cannot', async () => {
    /*
     * **Free-text search cannot find by grape.** `array_to_string` is `STABLE`,
     * so the array could not be folded into the generated tsvector (P1-07) —
     * which makes this filter the answer to "find me a nebbiolo" rather than a
     * refinement of one.
     */
    queries.length = 0;

    await get(app(), '?q=barolo&grape=Nebbiolo');

    expect(queries[0]).toMatchObject({ q: 'barolo', grape: 'Nebbiolo' });
  });

  it('refuses an empty grape rather than matching everything', async () => {
    expect((await get(app(), '?grape=')).status).toBe(422);
  });
});
