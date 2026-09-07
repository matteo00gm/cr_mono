import { productCreatedResponse } from '@catalogorosso/api-client';
import type { ProductRow } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { CreateProductCommand, ProductsPort } from '../src/products.js';
import { fakeAuth, oneMembership, signedIn } from './support/auth.js';
import { productsPort, storedProduct } from './support/products.js';

/**
 * `POST /v1/dashboard/products` (P1-02).
 *
 * The surface: who may call it, what it does with a body, and what a refusal
 * looks like. That a product and its outbox row commit together is a property
 * of real Postgres and is asserted in
 * `packages/db/test/products.integration.test.ts` — a fake port that resolves
 * proves the call happened, which was never the thing in doubt.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const PATH = '/v1/dashboard/products';

const VALID = {
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
} as const;

const commands: CreateProductCommand[] = [];

const port = (overrides: Partial<ProductsPort> = {}): ProductsPort =>
  productsPort({
    create: (command) => {
      commands.push(command);
      return Promise.resolve({
        outcome: 'created',
        product: storedProduct(command.values as Partial<ProductRow>),
      });
    },
    ...overrides,
  });

const app = (role: 'OWNER' | 'EDITOR', products: Partial<ProductsPort> = {}) =>
  createApp({
    auth: signedIn(),
    readMemberships: oneMembership(TENANT, role),
    products: port(products),
  });

const post = (built: ReturnType<typeof createApp>, body: unknown) =>
  built.request(PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('creating a product', () => {
  it('answers 201 with the row as stored', async () => {
    commands.length = 0;

    const response = await post(app('EDITOR'), VALID);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    /*
     * The defaults the server filled in are in the response, which is the
     * reason it returns the row rather than an id: a client that had to
     * re-fetch to learn `embeddingState` would show a row disagreeing with the
     * database for one round trip.
     */
    expect(body).toMatchObject({ sku: 'BAR-2019', status: 'ACTIVE', embeddingState: 'PENDING' });
  });

  it('emits exactly the shape the published contract promises', async () => {
    /*
     * **The assertion P0-63 is actually for**, and it is stronger than it
     * looks: the fake returns `Date` objects because the database does, so
     * this checks that `c.json` produces the ISO strings the contract declares
     * — the one place where the server's shape and the client's compiled type
     * could disagree without anything failing.
     */
    const response = await post(app('EDITOR'), VALID);

    const parsed = productCreatedResponse.safeParse(await response.json());
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('publishes the declared keys and no others', async () => {
    /*
     * **This found a real leak.** The first version returned the row verbatim,
     * so `content_hash` and `tenant_id` shipped — neither is in the contract.
     * The hash is an internal cost control, and a client that could see it
     * would eventually branch on it, turning a change in how it is computed
     * into a breaking API change instead of a re-index.
     *
     * Asserted strictly, so the guarantee holds for the *next* column added to
     * the table rather than for these two.
     */
    const body = (await (await post(app('EDITOR'), VALID)).json()) as Record<string, unknown>;

    const strict = productCreatedResponse.strict().safeParse(body);
    expect(strict.error?.issues ?? []).toEqual([]);

    expect(body).not.toHaveProperty('contentHash');
    expect(body).not.toHaveProperty('tenantId');
  });

  it('takes the tenant from the membership, never from the body', async () => {
    commands.length = 0;

    await post(app('EDITOR'), { ...VALID, tenantId: '99999999-9999-9999-9999-999999999999' });

    /*
     * P0-48, asserted on the value that reached the port rather than on a mock
     * call count. The contract omits `tenant_id` at the type level, so this is
     * belt and braces — and worth having, because the type-level guarantee is
     * exactly the kind that a later `z.object({...productInsert.shape})` would
     * silently undo.
     */
    expect(commands[0]?.tenantId).toBe(TENANT);
    expect(commands[0]?.values).not.toHaveProperty('tenantId');
  });

  it('strips unknown columns rather than refusing them', async () => {
    commands.length = 0;

    await post(app('EDITOR'), { ...VALID, wineryNotes: 'a column from a spreadsheet' });

    /*
     * Deliberately not `.strict()`, unlike the member bodies. The paste and
     * file import paths (P1-14, P1-16) arrive carrying whatever columns a
     * seller's spreadsheet had, and rejecting those would make the import
     * unusable for its entire purpose.
     */
    expect(commands[0]?.values).not.toHaveProperty('wineryNotes');
    expect(commands).toHaveLength(1);
  });

  it('never lets a client set the id or the timestamps', async () => {
    commands.length = 0;

    await post(app('EDITOR'), {
      ...VALID,
      id: '00000000-0000-0000-0000-000000000000',
      createdAt: '1999-01-01T00:00:00.000Z',
    });

    expect(commands[0]?.values).not.toHaveProperty('id');
    expect(commands[0]?.values).not.toHaveProperty('createdAt');
  });
});

describe('a body the contract refuses', () => {
  it.each([
    ['no body at all', undefined],
    ['an empty object', {}],
    ['a missing price', { sku: 'X', name: 'X', wineType: 'red', currency: 'EUR' }],
    ['a negative price', { ...VALID, priceCents: -1 }],
    ['a fractional price', { ...VALID, priceCents: 45.5 }],
    ['an unknown stock status', { ...VALID, stockStatus: 'MAYBE' }],
    ['an empty sku', { ...VALID, sku: '' }],
  ])('refuses %s', async (_case, body) => {
    commands.length = 0;

    const response = await post(app('EDITOR'), body);

    expect(response.status).toBe(422);
    // Nothing reached the database, which is the half a status code omits.
    expect(commands).toEqual([]);
  });

  it('refuses a negative price rather than storing a discount nobody asked for', async () => {
    /*
     * Called out separately because the table has a CHECK for it too. Both are
     * wanted: the contract keeps it out of a transaction, and the constraint
     * keeps it out of the table whichever path forgets — and the import path is
     * the one that would produce it, from a mis-parsed cell.
     */
    expect((await post(app('EDITOR'), { ...VALID, priceCents: -100 })).status).toBe(422);
  });
});

describe('who may call it', () => {
  it('lets an EDITOR write the catalogue, which is the point of the role', async () => {
    expect((await post(app('EDITOR'), VALID)).status).toBe(201);
  });

  it('lets an OWNER write it too', async () => {
    expect((await post(app('OWNER'), VALID)).status).toBe(201);
  });

  it('refuses an unauthenticated caller before anything is parsed', async () => {
    commands.length = 0;

    const built = createApp({
      auth: fakeAuth(),
      readMemberships: oneMembership(TENANT, 'OWNER'),
      products: port(),
    });

    expect((await post(built, VALID)).status).toBe(401);
    expect(commands).toEqual([]);
  });
});

describe('a SKU that is already taken', () => {
  it('answers 409 and names the SKU', async () => {
    const response = await post(
      app('EDITOR', { create: () => Promise.resolve({ outcome: 'duplicate-sku' }) }),
      VALID,
    );

    expect(response.status).toBe(409);

    /*
     * The SKU is echoed, and that is a disclosure decision rather than a
     * convenience. A SKU is the seller's own identifier and the uniqueness is
     * scoped to their winery, so telling them it is taken says nothing about
     * anybody else's catalogue — unlike a cross-tenant id, which is 404 (§3.5).
     */
    expect(JSON.stringify(await response.json())).toContain('BAR-2019');
  });

  it('does not leak the constraint name or the SQL', async () => {
    const response = await post(
      app('EDITOR', { create: () => Promise.resolve({ outcome: 'duplicate-sku' }) }),
      VALID,
    );

    /*
     * A `DomainError`'s message reaches the caller verbatim (P0-55), so what it
     * says is the API contract. `products_tenant_sku_unique` is a fact about
     * our schema and a starting point for somebody mapping it.
     */
    const text = (await response.text()).toLowerCase();
    for (const leak of ['products_tenant_sku_unique', 'constraint', 'insert into', '23505']) {
      expect(text).not.toContain(leak);
    }
  });
});
