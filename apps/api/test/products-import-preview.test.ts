import { importPreviewResponse } from '@catalogorosso/api-client';
import { MAX_IMPORT_BODY_BYTES } from '@catalogorosso/core';
import type { PreviewOutcome } from '@catalogorosso/db';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { PreviewImportCommand, ProductsPort } from '../src/products.js';
import { oneMembership, signedIn } from './support/auth.js';
import { productsPort } from './support/products.js';

/**
 * The import preview route (P1-23).
 *
 * What the route owns: where the tenant comes from, what it refuses before the
 * catalogue is read — the same refusals as the import — and the counts it adds.
 * The classification itself is `planUpsert`'s, asserted in `packages/db`, and
 * that preview and import agree is asserted against real Postgres in
 * `products-port.integration.test.ts`.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const PREVIEW = '/v1/dashboard/products/import/preview';

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
  built.request(PREVIEW, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const previewing = (outcomes: readonly PreviewOutcome[] = []) =>
  vi.fn<(command: PreviewImportCommand) => Promise<readonly PreviewOutcome[]>>(() =>
    Promise.resolve(outcomes),
  );

const messageOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { message: string } }).error.message;

describe('previewing an import', () => {
  it('answers with every outcome and the counts, for the membership tenant, with no key', async () => {
    const previewRows = previewing([
      { index: 0, outcome: 'created' },
      { index: 1, outcome: 'updated', productId: 'p-2', reindexed: true, archived: false },
      { index: 2, outcome: 'unchanged', productId: 'p-3', reindexed: false, archived: true },
    ]);

    const response = await post(app({ previewRows }), {
      rows: [
        ROW,
        { ...ROW, sku: 'B' },
        { ...ROW, sku: 'C', tenantId: '22222222-2222-2222-2222-222222222222' },
      ],
    });

    expect(response.status).toBe(200);
    expect(importPreviewResponse.parse(await response.json()).counts).toEqual({
      created: 1,
      updated: 1,
      unchanged: 1,
      duplicateSku: 0,
      archived: 1,
    });
    // P0-48: the row's tenant is stripped by the contract; the membership's is used.
    expect(previewRows).toHaveBeenCalledWith({
      tenantId: TENANT,
      rows: [ROW, { ...ROW, sku: 'B' }, { ...ROW, sku: 'C' }],
    });
  });

  it.each([
    ['a source, which a preview does not take', { rows: [ROW], source: { entryPoint: 'paste' } }],
    ['no rows at all', { rows: [] }],
    ['a body that is not JSON', 'not json'],
  ])('refuses %s before reading the catalogue', async (_case, body) => {
    const previewRows = previewing();

    const response = await post(app({ previewRows }), body);

    expect(response.status).toBe(422);
    expect(await messageOf(response)).toContain('{ "rows": [...] }');
    expect(previewRows).not.toHaveBeenCalled();
  });

  it('refuses a broken row, naming it as the import would', async () => {
    const previewRows = previewing();

    const response = await post(app({ previewRows }), { rows: [ROW, { ...ROW, sku: '' }] });

    expect(response.status).toBe(422);
    expect(await messageOf(response)).toContain('Row 2 ');
    expect(previewRows).not.toHaveBeenCalled();
  });

  it('refuses a body over the request cap, as the import would', async () => {
    const previewRows = previewing();

    const response = await post(app({ previewRows }), {
      rows: [{ ...ROW, tastingNotes: 'x'.repeat(MAX_IMPORT_BODY_BYTES) }],
    });

    expect(response.status).toBe(422);
    expect(await messageOf(response)).toContain('at most 5 MB');
    expect(previewRows).not.toHaveBeenCalled();
  });
});
