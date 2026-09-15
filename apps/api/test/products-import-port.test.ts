import { contentHashOf, nextEmbeddingStatus, type AuditEntry } from '@catalogorosso/core';
import type {
  DbTransaction,
  ImportRunClaim,
  ImportRunRequest,
  PreviewOutcome,
  PreviewRequest,
  ProductInsert,
  UpsertOutcome,
  UpsertRequest,
} from '@catalogorosso/db';
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
  previewUpsert: vi.fn<(tx: unknown, request: PreviewRequest) => Promise<PreviewOutcome[]>>(),
  withTenant:
    vi.fn<(tenantId: string, run: (tx: unknown) => Promise<unknown>) => Promise<unknown>>(),
  upsertProducts: vi.fn<(tx: unknown, request: UpsertRequest) => Promise<UpsertOutcome[]>>(),
  claimImportRun: vi.fn<(tx: unknown, request: ImportRunRequest) => Promise<ImportRunClaim>>(),
  completeImportRun:
    vi.fn<(tx: unknown, run: { runId: string; result: unknown }) => Promise<void>>(),
}));

vi.mock('@catalogorosso/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withTenant: db.withTenant,
  upsertProducts: db.upsertProducts,
  claimImportRun: db.claimImportRun,
  completeImportRun: db.completeImportRun,
  previewUpsert: db.previewUpsert,
}));

const TENANT = '11111111-1111-1111-1111-111111111111';

/** A deadline no import reaches, for the cases that are not about time. */
const NO_DEADLINE = Number.POSITIVE_INFINITY;

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
  db.claimImportRun.mockReset().mockResolvedValue({ outcome: 'claimed', runId: 'run-1' });
  db.completeImportRun.mockReset().mockResolvedValue(undefined);
  db.previewUpsert
    .mockReset()
    .mockImplementation((_tx, request) =>
      Promise.resolve(
        request.rows.map((row) => ({ index: row.index, outcome: 'created' as const })),
      ),
    );
});

describe('importRows', () => {
  it('applies rows in batches of 200, each in its own transaction for the tenant', async () => {
    const result = await createProductsPort().importRows({
      tenantId: TENANT,
      deadline: NO_DEADLINE,
      rows: rows(450),
    });

    expect(IMPORT_BATCH_SIZE).toBe(200);
    expect(db.withTenant.mock.calls.map(([tenant]) => tenant)).toEqual([TENANT, TENANT, TENANT]);
    expect(sentBatches().map((request) => request.rows.length)).toEqual([200, 200, 50]);
    expect(result.stoppedAt).toBeNull();
    expect(result.outcomes.map((outcome) => outcome.index)).toEqual(
      rows(450).map((_, index) => index),
    );
  });

  it('hands the upsert the real hash, the edited edge, the tenant and the import reason', async () => {
    await createProductsPort().importRows({
      tenantId: TENANT,
      deadline: NO_DEADLINE,
      rows: rows(1),
    });

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
      deadline: NO_DEADLINE,
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

    const result = await createProductsPort().importRows({
      tenantId: TENANT,
      deadline: NO_DEADLINE,
      rows: rows(600),
    });

    expect(result.stoppedAt).toEqual({
      batch: 2,
      fromIndex: 200,
      toIndex: 399,
      reason: 'failed',
      cause: failure,
    });
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
      deadline: NO_DEADLINE,
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
      deadline: NO_DEADLINE,
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

describe('the time budget (review fix)', () => {
  /*
   * The function is killed at ten seconds whether or not a batch is mid-commit,
   * and an import cut off there stores no report. These cases move a fake clock
   * only when a batch runs, so "slow" is exact rather than slept.
   */

  /** A port whose clock advances by the next of `durations` each time a batch runs. */
  const clocked = (...durations: number[]) => {
    let clock = 0;
    db.upsertProducts.mockImplementation((_tx, request) => {
      clock += durations.shift() ?? durations.at(-1) ?? 0;
      return created(request);
    });
    return createProductsPort({ now: () => clock });
  };

  it('stops before a batch that would not finish in time, and says which rows it would have held', async () => {
    // Two batches of two seconds end at 4s; a third as slow would end at 6s, past 5s.
    const result = await clocked(2_000, 2_000, 2_000).importRows({
      tenantId: TENANT,
      deadline: 5_000,
      rows: rows(1_000),
    });

    expect(db.upsertProducts).toHaveBeenCalledTimes(2);
    expect(result.stoppedAt).toEqual({
      batch: 3,
      fromIndex: 400,
      toIndex: 599,
      reason: 'time-budget',
      cause: undefined,
    });
    expect(result.outcomes).toHaveLength(400);
  });

  it('runs a batch that finishes exactly at the deadline', async () => {
    const result = await clocked(1_000, 1_000, 1_000).importRows({
      tenantId: TENANT,
      deadline: 3_000,
      rows: rows(600),
    });

    expect(db.upsertProducts).toHaveBeenCalledTimes(3);
    expect(result.stoppedAt).toBeNull();
  });

  it('always runs the first batch, so a request makes progress however late it starts', async () => {
    const result = await clocked(2_000).importRows({
      tenantId: TENANT,
      deadline: -1,
      rows: rows(450),
    });

    expect(db.upsertProducts).toHaveBeenCalledTimes(1);
    expect(result.stoppedAt).toMatchObject({ batch: 2, fromIndex: 200, reason: 'time-budget' });
  });

  it('budgets by the slowest batch so far, not the last one', async () => {
    // 3s then 0.5s: the next could take 3s again, so starting at 3.5s would end at 6.5s.
    const result = await clocked(3_000, 500, 500).importRows({
      tenantId: TENANT,
      deadline: 6_000,
      rows: rows(800),
    });

    expect(db.upsertProducts).toHaveBeenCalledTimes(2);
    expect(result.stoppedAt).toMatchObject({ batch: 3, reason: 'time-budget' });
  });
});

describe('the import attempt (P1-26)', () => {
  it('claims in a transaction for the tenant, passing the key and the hash through', async () => {
    const tx = { opened: 'for the claim' };
    db.withTenant.mockImplementation((_tenant, run) => run(tx));

    const claim = await createProductsPort().claimImport({
      tenantId: TENANT,
      idempotencyKey: 'k-1',
      requestHash: 'h-1',
    });

    expect(claim).toEqual({ outcome: 'claimed', runId: 'run-1' });
    expect(db.withTenant.mock.calls.map(([tenant]) => tenant)).toEqual([TENANT]);
    expect(db.claimImportRun).toHaveBeenCalledWith(tx, {
      tenantId: TENANT,
      idempotencyKey: 'k-1',
      requestHash: 'h-1',
    });
  });

  it('stores the answer in a transaction of its own for the tenant', async () => {
    const tx = { opened: 'for the completion' };
    db.withTenant.mockImplementation((_tenant, run) => run(tx));
    const result = { counts: { created: 1 } };

    await createProductsPort().completeImport({
      audit: null,
      tenantId: TENANT,
      runId: 'run-1',
      result,
    });

    expect(db.withTenant.mock.calls.map(([tenant]) => tenant)).toEqual([TENANT]);
    expect(db.completeImportRun).toHaveBeenCalledWith(tx, { runId: 'run-1', result });
  });
});

describe('the audit entry (P1-28)', () => {
  const ENTRY = {
    idempotencyKey: 'k-1',
    entryPoint: 'file' as const,
    filename: 'listino.csv',
    counts: { created: 2, updated: 1, unchanged: 0, duplicateSku: 0, archived: 0 },
  };

  /** An audit writer that records what it was given, and a completion that says when it ran. */
  const recording = () => {
    const order: string[] = [];
    const recorded: { tx: unknown; entry: AuditEntry }[] = [];

    db.completeImportRun.mockImplementation(() => {
      order.push('stored');
      return Promise.resolve();
    });

    const record = (tx: DbTransaction, entry: AuditEntry): Promise<void> => {
      order.push('audited');
      recorded.push({ tx, entry });
      return Promise.resolve();
    };

    return { order, recorded, record };
  };

  it('writes one entry in the transaction that stores the result, after storing it', async () => {
    const tx = { opened: 'for the completion' };
    db.withTenant.mockImplementation((_tenant, run) => run(tx));
    const { order, recorded, record } = recording();

    await createProductsPort({ audit: record }).completeImport({
      tenantId: TENANT,
      runId: 'run-1',
      result: {},
      audit: ENTRY,
    });

    expect(order).toEqual(['stored', 'audited']);
    expect(db.withTenant).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual([
      {
        tx,
        entry: {
          action: 'catalog.imported',
          target: 'k-1',
          metadata: {
            created: 2,
            updated: 1,
            unchanged: 0,
            duplicateSku: 0,
            archived: 0,
            entryPoint: 'file',
            filename: 'listino.csv',
          },
        },
      },
    ]);
  });

  it('leaves the file name out when there was none', async () => {
    const { recorded, record } = recording();

    await createProductsPort({ audit: record }).completeImport({
      tenantId: TENANT,
      runId: 'run-1',
      result: {},
      audit: { ...ENTRY, entryPoint: 'paste', filename: undefined },
    });

    expect(recorded[0]?.entry.metadata).not.toHaveProperty('filename');
  });

  it('writes nothing when the route says nothing reached the catalogue', async () => {
    const { order, recorded, record } = recording();

    await createProductsPort({ audit: record }).completeImport({
      tenantId: TENANT,
      runId: 'run-1',
      result: {},
      audit: null,
    });

    expect(order).toEqual(['stored']);
    expect(recorded).toEqual([]);
  });
});

describe('previewRows (P1-23)', () => {
  it('reads once for the tenant with the real hash, refusing duplicates first, in row order', async () => {
    const outcomes = await createProductsPort().previewRows({
      tenantId: TENANT,
      rows: rows(450, (index) => (index === 3 || index === 400 ? { sku: 'DUP' } : {})),
    });

    expect(db.withTenant.mock.calls.map(([tenant]) => tenant)).toEqual([TENANT]);
    expect(db.upsertProducts).not.toHaveBeenCalled();

    const [request] = db.previewUpsert.mock.calls.map(([, sent]) => sent);
    const [values] = rows(1);
    if (request === undefined || values === undefined) throw new Error('expected one preview');

    expect(request.rows).toHaveLength(448);
    expect(request.hashOf(values)).toBe(contentHashOf(values));
    expect(outcomes.map((outcome) => outcome.index)).toEqual(rows(450).map((_, index) => index));
    expect(
      outcomes
        .filter((outcome) => outcome.outcome === 'duplicate-sku')
        .map((outcome) => outcome.index),
    ).toEqual([3, 400]);
  });

  it('opens no transaction for a preview that is only duplicates', async () => {
    const outcomes = await createProductsPort().previewRows({
      tenantId: TENANT,
      rows: rows(2, () => ({ sku: 'DUP' })),
    });

    expect(db.withTenant).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      { index: 0, outcome: 'duplicate-sku', sku: 'DUP' },
      { index: 1, outcome: 'duplicate-sku', sku: 'DUP' },
    ]);
  });
});
