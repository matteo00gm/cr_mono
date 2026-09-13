import { contentHashOf, nextEmbeddingStatus } from '@catalogorosso/core';
import type { ProductInsert, UpsertOutcome, UpsertRequest } from '@catalogorosso/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createProductsPort, IMPORT_BATCH_SIZE } from '../src/products.js';

/**
 * How the port runs an import (P1-25), without a database.
 *
 * `products-port.integration.test.ts` proves the batches commit against real
 * Postgres. What is here is the orchestration around them — which rows go into
 * which batch, what is refused before any batch runs, what happens after one
 * fails — which is logic of its own and worth asserting without a container.
 * The two database calls are replaced; everything else is the real port.
 */

const db = vi.hoisted(() => ({
  withTenant:
    vi.fn<(tenantId: string, run: (tx: unknown) => Promise<unknown>) => Promise<unknown>>(),
  upsertProducts: vi.fn<(tx: unknown, request: UpsertRequest) => Promise<UpsertOutcome[]>>(),
}));

vi.mock('@catalogorosso/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withTenant: db.withTenant,
  upsertProducts: db.upsertProducts,
}));

const TENANT = '11111111-1111-1111-1111-111111111111';

const rows = (
  count: number,
  over: (index: number) => Partial<ProductInsert> = () => ({}),
): ProductInsert[] =>
  Array.from({ length: count }, (_, index) => ({
    sku: `S-${String(index)}`,
    name: `Vino ${String(index)}`,
    wineType: 'red',
    priceCents: 1000,
    currency: 'EUR',
    stockStatus: 'IN_STOCK' as const,
    ...over(index),
  }));

const created = (request: UpsertRequest): Promise<UpsertOutcome[]> =>
  Promise.resolve(
    request.rows.map((row) => ({
      index: row.index,
      outcome: 'created' as const,
      productId: `id-${String(row.index)}`,
    })),
  );

const sentBatches = (): UpsertRequest[] =>
  db.upsertProducts.mock.calls.map(([, request]) => request);

beforeEach(() => {
  db.withTenant.mockReset().mockImplementation((_tenant, run) => run({}));
  db.upsertProducts.mockReset().mockImplementation((_tx, request) => created(request));
});

describe('importRows', () => {
  it('applies rows in batches of 200, each in its own transaction for the tenant', async () => {
    const result = await createProductsPort().importRows({ tenantId: TENANT, rows: rows(450) });

    expect(IMPORT_BATCH_SIZE).toBe(200);
    expect(db.withTenant.mock.calls.map(([tenant]) => tenant)).toEqual([TENANT, TENANT, TENANT]);
    expect(sentBatches().map((request) => request.rows.length)).toEqual([200, 200, 50]);
    expect(result.stoppedAt).toBeNull();
    expect(result.outcomes.map((outcome) => outcome.index)).toEqual(
      rows(450).map((_, index) => index),
    );
  });

  it('hands the upsert the real hash, the edited edge, the tenant and the import reason', async () => {
    await createProductsPort().importRows({ tenantId: TENANT, rows: rows(1) });

    const [upsert] = sentBatches();
    const [values] = rows(1);
    if (upsert === undefined || values === undefined) throw new Error('expected one batch');

    expect(upsert.tenantId).toBe(TENANT);
    expect(upsert.reason).toBe('import');
    expect(upsert.hashOf(values)).toBe(contentHashOf(values));

    const indexed = { state: 'INDEXED' as const, error: null, attempts: 2 };
    expect(upsert.edited(indexed)).toEqual(
      nextEmbeddingStatus({ status: indexed, event: 'edited' }),
    );
  });

  it('refuses a SKU repeated across batches before any batch runs, keeping row order', async () => {
    const result = await createProductsPort().importRows({
      tenantId: TENANT,
      rows: rows(250, (index) => (index === 1 || index === 240 ? { sku: 'DUP' } : {})),
    });

    const sent = sentBatches().flatMap((request) => request.rows.map((row) => row.index));
    expect(sent).not.toContain(1);
    expect(sent).not.toContain(240);
    expect(
      result.outcomes
        .filter((outcome) => outcome.outcome === 'duplicate-sku')
        .map((outcome) => outcome.index),
    ).toEqual([1, 240]);
    expect(result.outcomes.map((outcome) => outcome.index)).toEqual(
      rows(250).map((_, index) => index),
    );
  });

  it('stops at a failing batch, says which rows it held, and runs nothing after it', async () => {
    const failure = new Error('the second batch broke');
    db.upsertProducts.mockImplementation((_tx, request) =>
      request.rows[0]?.index === 200 ? Promise.reject(failure) : created(request),
    );

    const result = await createProductsPort().importRows({ tenantId: TENANT, rows: rows(600) });

    expect(result.stoppedAt).toEqual({ batch: 2, fromIndex: 200, toIndex: 399, cause: failure });
    expect(result.outcomes).toHaveLength(200);
    expect(db.upsertProducts).toHaveBeenCalledTimes(2);
  });

  it('names a failing batch by the rows it really held, after duplicates were taken out', async () => {
    // Two refused rows at the start shift every batch by two: the second batch holds indexes 202 to 401, not 200 to 399.
    const failure = new Error('broke');
    db.upsertProducts.mockImplementation((_tx, request) =>
      request.rows[0]?.index === 202 ? Promise.reject(failure) : created(request),
    );

    const result = await createProductsPort().importRows({
      tenantId: TENANT,
      rows: rows(450, (index) => (index < 2 ? { sku: 'DUP' } : {})),
    });

    expect(result.stoppedAt).toMatchObject({ batch: 2, fromIndex: 202, toIndex: 401 });
    // The refusals are still reported, beside the batch that did apply.
    expect(result.outcomes.filter((outcome) => outcome.outcome === 'duplicate-sku')).toHaveLength(
      2,
    );
    expect(result.outcomes).toHaveLength(202);
  });

  it('opens no transaction for an import that is only duplicates', async () => {
    const result = await createProductsPort().importRows({
      tenantId: TENANT,
      rows: rows(2, () => ({ sku: 'DUP' })),
    });

    expect(db.withTenant).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcomes: [
        { index: 0, outcome: 'duplicate-sku', sku: 'DUP' },
        { index: 1, outcome: 'duplicate-sku', sku: 'DUP' },
      ],
      stoppedAt: null,
    });
  });
});
