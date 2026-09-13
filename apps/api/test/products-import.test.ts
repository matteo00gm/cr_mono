import { productsImportedResponse } from '@catalogorosso/api-client';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import {
  countImportOutcomes,
  type ImportProductsResult,
  type ProductsPort,
} from '../src/products.js';
import { MAX_IMPORT_ROWS } from '../src/surfaces/dashboard.js';
import { oneMembership, signedIn } from './support/auth.js';
import { productsPort } from './support/products.js';

/**
 * The bulk import route (P1-25).
 *
 * What the route owns: who may import, where the tenant comes from, what is
 * refused before anything is written, and what the answer says when an import
 * stops part-way. The batching itself is asserted against a real database in
 * `products-port.integration.test.ts`.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const IMPORT = '/v1/dashboard/products/import';

const ROW = {
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
};

const app = (products: Partial<ProductsPort>) =>
  createApp({
    auth: signedIn(),
    readMemberships: oneMembership(TENANT, 'EDITOR'),
    products: productsPort(products),
  });

const post = (built: ReturnType<typeof createApp>, body: unknown) =>
  built.request(IMPORT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const applied = (result: Partial<ImportProductsResult> = {}) =>
  vi.fn(() => Promise.resolve({ outcomes: [], stoppedAt: null, ...result }));

const messageOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { message: string } }).error.message;

describe('importing', () => {
  it('lets an EDITOR import, and answers with every outcome and the counts', async () => {
    const importRows = applied({
      outcomes: [
        { index: 0, outcome: 'created', productId: 'p-1' },
        { index: 1, outcome: 'updated', productId: 'p-2', reindexed: false, archived: true },
      ],
    });

    const response = await post(app({ importRows }), { rows: [ROW, { ...ROW, sku: 'ETN-2020' }] });

    expect(response.status).toBe(200);

    const body = productsImportedResponse.parse(await response.json());
    expect(body.counts).toEqual({
      created: 1,
      updated: 1,
      unchanged: 0,
      duplicateSku: 0,
      archived: 1,
    });
    expect(body.stoppedAt).toBeNull();
    expect(importRows).toHaveBeenCalledWith({
      tenantId: TENANT,
      rows: [ROW, { ...ROW, sku: 'ETN-2020' }],
    });
  });

  it('takes the tenant from the membership, never from a row', async () => {
    // P0-48. A row carrying another winery's id parses with the field stripped.
    const importRows = applied();

    await post(app({ importRows }), {
      rows: [{ ...ROW, tenantId: '22222222-2222-2222-2222-222222222222' }],
    });

    expect(importRows).toHaveBeenCalledWith({ tenantId: TENANT, rows: [ROW] });
  });
});

describe('what is refused before anything is written', () => {
  it.each([
    ['no body at all', 'not json'],
    ['a body without rows', { products: [ROW] }],
    ['an empty import', { rows: [] }],
    ['a body with anything else in it', { rows: [ROW], mode: 'replace' }],
  ])('refuses %s', async (_case, body) => {
    const importRows = applied();

    const response = await post(app({ importRows }), body);

    expect(response.status).toBe(422);
    expect(await messageOf(response)).toContain(String(MAX_IMPORT_ROWS));
    expect(importRows).not.toHaveBeenCalled();
  });

  it('refuses more rows than the cap, on the server as well as in the browser', async () => {
    const importRows = applied();

    const response = await post(app({ importRows }), {
      rows: Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => ({
        ...ROW,
        sku: `S-${String(index)}`,
      })),
    });

    expect(response.status).toBe(422);
    expect(importRows).not.toHaveBeenCalled();
  });

  it('refuses the whole import when a row breaks the contract, naming the row', async () => {
    const importRows = applied();

    const response = await post(app({ importRows }), {
      rows: [ROW, { ...ROW, sku: '' }, { ...ROW, sku: 'OK' }, { ...ROW, priceCents: -1 }],
    });

    expect(response.status).toBe(422);
    const message = await messageOf(response);
    expect(message).toContain('Row 2, 4 ');
    expect(message).toContain('nothing was imported');
    expect(importRows).not.toHaveBeenCalled();
  });

  it('names the first five broken rows and counts the rest', async () => {
    const broken = Array.from({ length: 7 }, () => ({ ...ROW, name: '' }));

    const response = await post(app({ importRows: applied() }), { rows: broken });

    expect(await messageOf(response)).toContain('Row 1, 2, 3, 4, 5 and 2 more');
  });
});

describe('an import that stops part-way', () => {
  it('says how far it got, numbered as a seller counts rows, and never why', async () => {
    const importRows = applied({
      outcomes: Array.from({ length: 400 }, (_, index) => ({
        index,
        outcome: 'created' as const,
        productId: `p-${String(index)}`,
      })),
      stoppedAt: {
        batch: 3,
        fromIndex: 400,
        toIndex: 599,
        cause: new Error('connect ECONNREFUSED postgres://app_rw:hunter2@db.internal/app'),
      },
    });

    const response = await post(app({ importRows }), { rows: [ROW] });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(productsImportedResponse.parse(JSON.parse(text)).stoppedAt).toEqual({
      batch: 3,
      fromRow: 401,
      toRow: 600,
    });
    // P0-55: a driver error can carry a connection string. It goes to the log, not here.
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ECONNREFUSED');
  });
});

describe('countImportOutcomes', () => {
  it('counts each kind, and archived matches whether updated or unchanged', () => {
    expect(
      countImportOutcomes([
        { index: 0, outcome: 'created', productId: 'a' },
        { index: 1, outcome: 'updated', productId: 'b', reindexed: true, archived: false },
        { index: 2, outcome: 'unchanged', productId: 'c', reindexed: false, archived: true },
        { index: 3, outcome: 'updated', productId: 'd', reindexed: false, archived: true },
        { index: 4, outcome: 'duplicate-sku', sku: 'X' },
        { index: 5, outcome: 'duplicate-sku', sku: 'X' },
      ]),
    ).toEqual({ created: 1, updated: 2, unchanged: 1, duplicateSku: 2, archived: 2 });
  });
});
