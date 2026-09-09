import { productUpdatedResponse } from '@catalogorosso/api-client';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { ProductsPort, UpdateProductCommand } from '../src/products.js';
import { fakeAuth, oneMembership, signedIn } from './support/auth.js';
import { productsPort, storedProduct } from './support/products.js';

/**
 * `PATCH /v1/dashboard/products/:id` (P1-03).
 *
 * The surface. That a patch which changes nothing the model reads enqueues
 * nothing is a property of a real transaction comparing against a stored hash,
 * and is asserted in `packages/db/test/products.write.integration.test.ts`.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PATH = `/v1/dashboard/products/${ID}`;

const ROW = storedProduct({ id: ID, embeddingState: 'INDEXED' });

const commands: UpdateProductCommand[] = [];

const port = (overrides: Partial<ProductsPort> = {}): ProductsPort =>
  productsPort({
    update: (command) => {
      commands.push(command);
      return Promise.resolve({ outcome: 'updated', product: ROW, reindexed: false });
    },
    ...overrides,
  });

const app = (role: 'OWNER' | 'EDITOR' = 'EDITOR', products: Partial<ProductsPort> = {}) =>
  createApp({
    auth: signedIn(),
    readMemberships: oneMembership(TENANT, role),
    products: port(products),
  });

const patch = (built: ReturnType<typeof createApp>, body: unknown, path = PATH) =>
  built.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('patching a product', () => {
  it('accepts a partial body and passes only what was sent', async () => {
    commands.length = 0;

    const response = await patch(app(), { priceCents: 4900 });

    expect(response.status).toBe(200);
    /*
     * Only the field that was sent. A patch that arrived carrying every column
     * as `undefined` would blank the row — and the damage would show in the
     * *hash* first, since a merged row full of undefined hashes to something
     * that looks like a change, so every patch would re-embed.
     */
    expect(commands[0]?.values).toEqual({ priceCents: 4900 });
    expect(commands[0]?.productId).toBe(ID);
  });

  it('takes the tenant from the membership, never from the body', async () => {
    commands.length = 0;

    await patch(app(), { priceCents: 1, tenantId: '99999999-9999-9999-9999-999999999999' });

    expect(commands[0]?.tenantId).toBe(TENANT);
    expect(commands[0]?.values).not.toHaveProperty('tenantId');
  });

  it('never lets a client move a product to another winery or rewrite its id', async () => {
    commands.length = 0;

    await patch(app(), { id: '00000000-0000-0000-0000-000000000000', updatedAt: '1999-01-01' });

    expect(commands[0]?.values).toEqual({});
  });

  it('emits the published shape and nothing more', async () => {
    const response = await patch(app(), { priceCents: 4900 });

    const strict = productUpdatedResponse.strict().safeParse(await response.json());
    expect(strict.error?.issues ?? []).toEqual([]);
  });

  it('reports the embedding state rather than a separate reindexed flag', async () => {
    /*
     * `STALE` means findable under its previous description while the new one
     * is built; `PENDING` means never indexed at all. The state carries the
     * answer, so a second field saying the same thing would be a second thing
     * to keep true.
     */
    const response = await patch(
      app('EDITOR', {
        update: () =>
          Promise.resolve({
            outcome: 'updated',
            product: { ...ROW, embeddingState: 'STALE' },
            reindexed: true,
          }),
      }),
      { tastingNotes: 'Completely different notes.' },
    );

    const body = (await response.json()) as { embeddingState: string };
    expect(body.embeddingState).toBe('STALE');
    expect(body).not.toHaveProperty('reindexed');
  });
});

describe('an id the caller may not have', () => {
  it('answers 404, not 403', async () => {
    /*
     * **§3.5, and the test the row insists on** — because the natural
     * implementation compares the row's tenant to the caller's and returns 403,
     * which tells an attacker the resource exists. Here the read is scoped by
     * RLS, so another winery's id simply matches nothing.
     */
    const response = await patch(
      app('EDITOR', { update: () => Promise.resolve({ outcome: 'not-found' }) }),
      { priceCents: 1 },
    );

    expect(response.status).toBe(404);
  });

  it('says the same thing for an id that is not a uuid at all', async () => {
    const response = await patch(
      app('EDITOR', { update: () => Promise.resolve({ outcome: 'not-found' }) }),
      { priceCents: 1 },
      '/v1/dashboard/products/not-a-uuid',
    );

    expect(response.status).toBe(404);
  });

  it('does not distinguish it from an id that never existed', async () => {
    const missing = await patch(
      app('EDITOR', { update: () => Promise.resolve({ outcome: 'not-found' }) }),
      { priceCents: 1 },
    );
    const foreign = await patch(
      app('EDITOR', { update: () => Promise.resolve({ outcome: 'not-found' }) }),
      { priceCents: 1 },
      '/v1/dashboard/products/22222222-2222-2222-2222-222222222222',
    );

    /*
     * Everything but the request id, which is per-request by design. The
     * disclosure is in the code and the message: if those differed, the status
     * being equal would not help.
     */
    const body = async (r: Response) => {
      const { error } = (await r.json()) as { error: { code: string; message: string } };
      return { code: error.code, message: error.message };
    };

    expect(await body(missing)).toEqual(await body(foreign));
    expect(missing.status).toBe(foreign.status);
  });
});

describe('a SKU that collides', () => {
  it('answers 409 without naming the constraint', async () => {
    const response = await patch(
      app('EDITOR', { update: () => Promise.resolve({ outcome: 'duplicate-sku' }) }),
      { sku: 'TAKEN' },
    );

    expect(response.status).toBe(409);

    const text = (await response.text()).toLowerCase();
    for (const leak of ['products_tenant_sku_unique', 'constraint', '23505']) {
      expect(text).not.toContain(leak);
    }
  });
});

describe('a body the contract refuses', () => {
  it.each([
    ['a negative price', { priceCents: -1 }],
    ['a fractional price', { priceCents: 45.5 }],
    ['an unknown stock status', { stockStatus: 'MAYBE' }],
    ['an empty name', { name: '' }],
  ])('refuses %s and touches nothing', async (_case, body) => {
    commands.length = 0;

    expect((await patch(app(), body)).status).toBe(422);
    expect(commands).toEqual([]);
  });

  it('accepts an empty patch, which is a no-op rather than an error', async () => {
    /*
     * An empty object is a request to change nothing, and the honest answer is
     * the row unchanged. Refusing it would make the obvious client
     * implementation — send the diff — fail on the case where the user changed
     * their mind.
     */
    expect((await patch(app(), {})).status).toBe(200);
  });
});

describe('who may call it', () => {
  it('refuses a caller who belongs to no winery, before the handler runs', async () => {
    commands.length = 0;

    const built = createApp({
      auth: signedIn('user_nobody'),
      readMemberships: () => Promise.resolve([]),
      products: port(),
    });

    /*
     * **403 here, and that is not in tension with the 404s above.** This caller
     * is authenticated and belongs to no winery at all — a fact about their own
     * account, which telling them costs nothing and helps them. §3.5's 404 is
     * for a *resource* in a winery they are not a member of, where the status
     * itself would confirm the resource exists (P0-47 draws the same line).
     */
    expect((await patch(built, { priceCents: 1 })).status).toBe(403);
    expect(commands).toEqual([]);
  });

  it('refuses a caller with no session at all', async () => {
    commands.length = 0;

    const built = createApp({
      auth: fakeAuth(),
      readMemberships: oneMembership(TENANT, 'OWNER'),
      products: port(),
    });

    expect((await patch(built, { priceCents: 1 })).status).toBe(401);
    expect(commands).toEqual([]);
  });
});
