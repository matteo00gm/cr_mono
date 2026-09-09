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
      return Promise.resolve({ items: [storedProduct()], nextCursor: null });
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
