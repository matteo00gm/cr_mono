import { productArchivedResponse } from '@catalogorosso/api-client';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { ArchiveProductCommand, ProductsPort } from '../src/products.js';
import { oneMembership, signedIn } from './support/auth.js';
import { productsPort, storedProduct } from './support/products.js';

/**
 * `DELETE /v1/dashboard/products/:id` (P1-04).
 *
 * The surface. **The property that actually matters is not here**: that the
 * wine stops coming back from retrieval is P1-05's assertion, made through the
 * real retrieval path rather than by counting vector rows — an empty vectors
 * table and an unretrievable product are not the same statement.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PATH = `/v1/dashboard/products/${ID}`;

const ARCHIVED = storedProduct({ id: ID, status: 'ARCHIVED' });

const commands: ArchiveProductCommand[] = [];

const port = (overrides: Partial<ProductsPort> = {}): ProductsPort =>
  productsPort({
    archive: (command) => {
      commands.push(command);
      return Promise.resolve({ outcome: 'archived', product: ARCHIVED, vectorsRemoved: 1 });
    },
    ...overrides,
  });

const app = (role: 'OWNER' | 'EDITOR' = 'EDITOR', products: Partial<ProductsPort> = {}) =>
  createApp({
    auth: signedIn(),
    readMemberships: oneMembership(TENANT, role),
    products: port(products),
  });

const remove = (built: ReturnType<typeof createApp>, path = PATH) =>
  built.request(path, { method: 'DELETE' });

describe('removing a wine', () => {
  it('reports that it will no longer be recommended', async () => {
    commands.length = 0;

    const response = await remove(app());

    expect(response.status).toBe(200);
    /*
     * The claim the seller cares about, and a *different* claim from "the row
     * is gone" — the row is not gone. Saying it explicitly means the dashboard
     * does not have to infer it from a status code, which is the sort of
     * inference that goes stale the day the behaviour changes.
     */
    expect(await response.json()).toEqual({
      id: ID,
      status: 'ARCHIVED',
      noLongerRecommended: true,
      vectorsRemoved: 1,
    });
    expect(commands[0]).toEqual({ tenantId: TENANT, productId: ID });
  });

  it('emits the published shape and nothing more', async () => {
    const strict = productArchivedResponse.strict().safeParse(await (await remove(app())).json());

    expect(strict.error?.issues ?? []).toEqual([]);
  });

  it('reports zero vectors without treating it as a failure', async () => {
    /*
     * Zero is meaningful rather than suspicious: the wine had never been
     * indexed. Conflating that with a delete that failed to clean up would send
     * somebody looking for a bug that is not there.
     */
    const response = await remove(
      app('EDITOR', {
        archive: () =>
          Promise.resolve({ outcome: 'archived', product: ARCHIVED, vectorsRemoved: 0 }),
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      vectorsRemoved: 0,
    });
  });

  it('is not an error the second time', async () => {
    /*
     * The seller's intent — stop recommending this — is already satisfied, and
     * answering 409 to a repeated click would make the dashboard explain a
     * conflict that is not one.
     */
    expect((await remove(app())).status).toBe(200);
    expect((await remove(app())).status).toBe(200);
  });
});

describe('an id the caller may not have', () => {
  it('answers 404, not 403', async () => {
    const response = await remove(
      app('EDITOR', { archive: () => Promise.resolve({ outcome: 'not-found' }) }),
    );

    expect(response.status).toBe(404);
  });

  it('says the same thing for an id that is not a uuid', async () => {
    const response = await remove(
      app('EDITOR', { archive: () => Promise.resolve({ outcome: 'not-found' }) }),
      '/v1/dashboard/products/not-a-uuid',
    );

    expect(response.status).toBe(404);
  });
});

describe('who may call it', () => {
  it('lets an EDITOR remove a wine, which is catalogue work', async () => {
    expect((await remove(app('EDITOR'))).status).toBe(200);
  });

  it('refuses a caller with no session', async () => {
    commands.length = 0;

    const built = createApp({
      auth: signedIn('user_x'),
      readMemberships: () => Promise.resolve([]),
      products: port(),
    });

    expect((await remove(built)).status).toBe(403);
    expect(commands).toEqual([]);
  });
});
