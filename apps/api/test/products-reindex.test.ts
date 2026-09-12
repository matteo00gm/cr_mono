import { catalogueReindexedResponse, productReindexedResponse } from '@catalogorosso/api-client';
import { nextEmbeddingStatus, EMBEDDING_STATES, type EmbeddingState } from '@catalogorosso/core';
import { describe, expect, it } from 'vitest';

import { queuedEdges, type ProductsPort } from '../src/products.js';
import { createApp } from '../src/app.js';
import { oneMembership, signedIn } from './support/auth.js';
import { productsPort, storedProduct } from './support/products.js';

/**
 * `POST .../products/:id/reindex` and `POST .../products/reindex-all` (P1-39).
 *
 * The surface, plus the one piece of domain glue this layer owns: `queuedEdges`
 * is the state machine's `queued` edge flattened into a lookup so the bulk
 * statement can apply it to every row at once. A second, hand-written copy of a
 * transition table is exactly what P1-38 exists to prevent, so the agreement
 * between the two is asserted rather than assumed.
 *
 * **The capability guard is not asserted here**, and deliberately. There is no
 * read-only role — `catalog:write` is held by both OWNER and EDITOR — so a
 * request cannot demonstrate the guard by being refused. What proves these
 * routes are wired to it is `rbac-matrix.test.ts`, which enumerates endpoints
 * from the router and fails on one that is undeclared or guarded by the wrong
 * capability. A role-based test here would pass whether or not the guard
 * existed, which is worse than no test: it would be read as coverage.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ONE = `/v1/dashboard/products/${ID}/reindex`;
const ALL = '/v1/dashboard/products/reindex-all';

const app = (products: Partial<ProductsPort>) =>
  createApp({
    auth: signedIn(),
    readMemberships: oneMembership(TENANT, 'EDITOR'),
    products: productsPort(products),
  });

const post = (built: ReturnType<typeof createApp>, path: string) =>
  built.request(path, { method: 'POST' });

describe('reindexing one wine', () => {
  it('answers with the row as it now stands', async () => {
    /*
     * **The response carries the product, and that is the point of the shape.**
     * A reindex moves the embedding state, and P1-40's grid has to show the new
     * one immediately. Returning the row means the grid re-renders from the
     * server's answer instead of predicting the transition — the difference
     * between a column that is right and a column that agrees with itself.
     */
    const product = storedProduct({ id: ID, embeddingState: 'STALE' });

    const response = await post(
      app({ reindex: () => Promise.resolve({ outcome: 'queued', product }) }),
      ONE,
    );

    expect(response.status).toBe(202);

    const body = productReindexedResponse.parse(await response.json());

    expect(body.product.id).toBe(ID);
    expect(body.product.embeddingState).toBe('STALE');
    expect(body.queued).toBe(true);
  });

  it('takes the tenant from the membership and the id from the path', async () => {
    // P0-48. The tenant is never readable from a request, and this is the route
    // that would be tempting to write with one, since it has no body at all.
    const seen: { tenantId: string; productId: string }[] = [];

    await post(
      app({
        reindex: (command) => {
          seen.push(command);
          return Promise.resolve({ outcome: 'queued', product: storedProduct({ id: ID }) });
        },
      }),
      ONE,
    );

    expect(seen).toEqual([{ tenantId: TENANT, productId: ID }]);
  });

  it('answers 404 for a wine this winery cannot see', async () => {
    // §3.5: 404 and not 403. A 403 tells an attacker the id exists somewhere.
    const response = await post(
      app({ reindex: () => Promise.resolve({ outcome: 'not-found' }) }),
      ONE,
    );

    expect(response.status).toBe(404);
  });

  it('refuses an archived wine instead of accepting it quietly', async () => {
    /*
     * **The failure this prevents is a lie, not an error.** The worker discards
     * a job for an archived wine by design — re-embedding one would put it back
     * in front of visitors — so a 202 here would tell a seller their wine was
     * being reindexed when nothing was going to happen, and the state would sit
     * unchanged with no explanation.
     */
    const archived = storedProduct({ id: ID, status: 'ARCHIVED' });

    const response = await post(
      app({ reindex: () => Promise.resolve({ outcome: 'archived', product: archived }) }),
      ONE,
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('archived');
  });
});

describe('reindexing the catalogue', () => {
  it('answers with a batch id and how many were queued', async () => {
    const response = await post(
      app({
        reindexAll: () => Promise.resolve({ outcome: 'queued', batchId: 'batch-1', queued: 1284 }),
      }),
      ALL,
    );

    expect(response.status).toBe(202);
    expect(catalogueReindexedResponse.parse(await response.json())).toEqual({
      batchId: 'batch-1',
      queued: 1284,
    });
  });

  it('generates a batch id rather than taking one from the caller', async () => {
    /*
     * The id identifies *this run* on every outbox row it writes. A caller-supplied
     * one would let two runs claim the same id, which is the one thing the field
     * is for — telling one run's rows from another's when reading the queue.
     */
    const seen: string[] = [];

    const built = app({
      reindexAll: (command) => {
        seen.push(command.batchId);
        return Promise.resolve({ outcome: 'queued', batchId: command.batchId, queued: 0 });
      },
    });

    await post(built, ALL);
    await post(built, ALL);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a second run while the first is still draining, and says how many are left', async () => {
    /*
     * **409 with a number, because "no" on its own is the unhelpful half.** Two
     * batches in the queue index nothing twice; they double the work before
     * either finishes. A seller told only that it was refused has no way to
     * tell a stuck run from a long one.
     */
    const response = await post(
      app({ reindexAll: () => Promise.resolve({ outcome: 'in-flight', queued: 412 }) }),
      ALL,
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('412');
  });

  it('is not shadowed by the :id route', async () => {
    /*
     * **Hono matches in registration order** (P0-54), so a literal registered
     * after a parameter that could match it never runs. These two differ in
     * segment count today, which makes this test look redundant — it is not:
     * the day somebody adds `POST /products/:id`, this is what fails instead of
     * the bulk route quietly becoming a reindex of a wine called "reindex-all".
     */
    const reached: string[] = [];

    const built = app({
      reindexAll: () => {
        reached.push('all');
        return Promise.resolve({ outcome: 'queued', batchId: 'b', queued: 0 });
      },
      reindex: (command) => {
        reached.push(`one:${command.productId}`);
        return Promise.resolve({ outcome: 'queued', product: storedProduct({ id: ID }) });
      },
    });

    await post(built, ALL);

    expect(reached).toEqual(['all']);
  });
});

describe('the queued edge, flattened', () => {
  it('agrees with the state machine for every state', () => {
    /*
     * **The guard that makes the bulk statement safe.** `reindexCatalogue`
     * applies this map as SQL, so a state whose edge is wrong here is a wrong
     * `embedding_state` written to every row that had it — and the row itself
     * says nothing about how it got there. Derived from `nextEmbeddingStatus`
     * rather than written out, and asserted anyway, because a new state added
     * to `EMBEDDING_STATES` would keep this compiling either way.
     */
    for (const state of EMBEDDING_STATES) {
      expect(queuedEdges[state]).toBe(
        nextEmbeddingStatus({ status: { state, error: null, attempts: 0 }, event: 'queued' }).state,
      );
    }
  });

  it('covers every state and nothing else', () => {
    expect(Object.keys(queuedEdges).sort()).toEqual([...EMBEDDING_STATES].sort());
  });

  it('keeps an indexed wine findable rather than marking it never-indexed', () => {
    /*
     * The distinction P1-40's grid shows a seller, spelled out here because it
     * is the one an implementer would collapse. `STALE` means "findable under
     * its previous description while the new one is built"; `PENDING` means
     * "cannot be recommended yet". Telling somebody their catalogue had gone
     * dark during a reindex would be false and alarming in equal measure.
     */
    const indexed: EmbeddingState = 'INDEXED';

    expect(queuedEdges[indexed]).toBe('STALE');
    expect(queuedEdges.FAILED).toBe('PENDING');
  });
});
