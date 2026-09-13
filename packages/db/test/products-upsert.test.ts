import { describe, expect, it, vi } from 'vitest';

import { productInsert, type ProductInsert } from '../src/contracts.js';
import type { ProductRow } from '../src/products.js';
import type { EmbeddingStatusWrite } from '../src/embedding-status.js';
import {
  planUpsert,
  previewUpsert,
  upsertProducts,
  WRITTEN_FIELDS,
  type UpsertRow,
} from '../src/products-upsert.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * Deciding what an import does (P1-24).
 *
 * The statements are asserted against a real database in
 * `products-upsert.integration.test.ts`. What is here is the decision each row
 * gets, which is where an import's cost and its honesty are settled: what counts
 * as a change, what re-queues an embedding, and what is refused.
 */

const VALUES: ProductInsert = {
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
};

/** Hashes only what a test says the model reads, so a price edit is invisible to it. */
const hashOf = (values: ProductInsert): string =>
  JSON.stringify([values.name, values.tastingNotes ?? null, values.grapeVarieties ?? null]);

const stored = (over: Partial<ProductRow> = {}): ProductRow => {
  const row: ProductRow = {
    id: 'p-1',
    tenantId: 't-1',
    sku: 'BAR-2019',
    externalVariantId: null,
    name: 'Barolo Bussia',
    producer: 'Poderi Colla',
    vintage: 2019,
    wineType: 'red',
    grapeVarieties: ['Nebbiolo'],
    region: null,
    denomination: null,
    styleTags: null,
    tastingNotes: 'Rosa appassita.',
    foodPairings: null,
    alcoholPct: '14.50',
    priceCents: 4500,
    currency: 'EUR',
    stockStatus: 'IN_STOCK',
    stockQty: 24,
    productUrl: null,
    imageUrl: null,
    status: 'ACTIVE',
    contentHash: '',
    embeddingState: 'INDEXED',
    embeddingError: null,
    embeddingAttempts: 1,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };

  return { ...row, contentHash: over.contentHash ?? hashOf(row) };
};

const row = (values: Partial<ProductInsert> = {}, index = 0): UpsertRow => ({
  index,
  values: { ...VALUES, ...values },
});

const existing = (...rows: ProductRow[]) => new Map(rows.map((product) => [product.sku, product]));

describe('WRITTEN_FIELDS', () => {
  it('is every column the insert contract accepts, so a new column is a decision', () => {
    expect([...WRITTEN_FIELDS].sort()).toEqual(Object.keys(productInsert.shape).sort());
  });
});

describe('planUpsert', () => {
  it('creates a wine whose SKU is not in the catalogue, hashed from its own values', () => {
    const [decision] = planUpsert([row()], existing(), hashOf);

    expect(decision).toEqual({
      kind: 'create',
      index: 0,
      values: VALUES,
      contentHash: hashOf(VALUES),
    });
  });

  it('calls a row that changes nothing unchanged, and queues nothing for it', () => {
    const [decision] = planUpsert(
      [row({ tastingNotes: 'Rosa appassita.' })],
      existing(stored()),
      hashOf,
    );

    expect(decision).toMatchObject({ kind: 'update', changed: false, reindexed: false });
  });

  it('calls a price change updated without re-embedding, because the model does not read it', () => {
    /*
     * The case a hash-only "unchanged" gets wrong: equal hash, different price.
     * The seller changed something, so it is an update; the text did not move,
     * so it costs nothing.
     */
    const [decision] = planUpsert([row({ priceCents: 4900 })], existing(stored()), hashOf);

    expect(decision).toMatchObject({ kind: 'update', changed: true, reindexed: false });
  });

  it('re-embeds a change the model reads', () => {
    const [decision] = planUpsert([row({ tastingNotes: 'Catrame.' })], existing(stored()), hashOf);

    expect(decision).toMatchObject({ kind: 'update', changed: true, reindexed: true });
  });

  it('re-embeds a row whose values match but whose stored hash is stale, and calls it unchanged', () => {
    const [decision] = planUpsert(
      [row()],
      existing(stored({ contentHash: 'from-an-older-text-version' })),
      hashOf,
    );

    expect(decision).toMatchObject({ kind: 'update', changed: false, reindexed: true });
  });

  it('leaves a field the row does not carry exactly as it was', () => {
    const [decision] = planUpsert([row({ priceCents: 4900 })], existing(stored()), hashOf);

    if (decision?.kind !== 'update') throw new Error('expected an update');
    expect(decision.values.tastingNotes).toBe('Rosa appassita.');
    expect(decision.values.producer).toBe('Poderi Colla');
    expect(decision.values.stockQty).toBe(24);
    expect(decision.values.priceCents).toBe(4900);
  });

  it('compares lists by their items, so the same grapes are not a change', () => {
    const same = planUpsert([row({ grapeVarieties: ['Nebbiolo'] })], existing(stored()), hashOf);
    const different = planUpsert(
      [row({ grapeVarieties: ['Nebbiolo', 'Barbera'] })],
      existing(stored()),
      hashOf,
    );
    const shorter = planUpsert([row({ grapeVarieties: [] })], existing(stored()), hashOf);

    expect(same[0]).toMatchObject({ changed: false });
    expect(different[0]).toMatchObject({ changed: true, reindexed: true });
    expect(shorter[0]).toMatchObject({ changed: true });
  });

  it('refuses every row that shares a SKU, rather than letting the last one win', () => {
    const decisions = planUpsert(
      [row({ name: 'Primo' }, 0), row({ sku: 'ETN-2020' }, 1), row({ name: 'Secondo' }, 2)],
      existing(),
      hashOf,
    );

    expect(decisions.map((decision) => decision.kind)).toEqual([
      'duplicate',
      'create',
      'duplicate',
    ]);
    expect(decisions[0]).toEqual({ kind: 'duplicate', index: 0, sku: 'BAR-2019' });
  });

  it('keeps each row’s index, so an outcome can be matched to its line', () => {
    const decisions = planUpsert([row({ sku: 'A' }, 7), row({ sku: 'B' }, 3)], existing(), hashOf);

    expect(decisions.map((decision) => decision.index)).toEqual([7, 3]);
  });
});

/**
 * The statements, against a fake transaction.
 *
 * Shapes and branches only, on the same terms as the reindex tests beside this
 * one. What a fake cannot show — that RLS scopes the SKU lookup, that the rows
 * and their jobs commit together, that `FOR UPDATE` really waits — is in
 * `products-upsert.integration.test.ts`. What belongs here is which statement
 * runs for which decision, and what each one writes.
 */
describe('upsertProducts', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';

  interface Recorded {
    locked: boolean;
    selects: number;
    readonly inserts: Record<string, unknown>[][];
    readonly updates: Record<string, unknown>[];
  }

  const fakeTx = (
    found: readonly ProductRow[],
    createdIds: Readonly<Record<string, string>> = {},
  ) => {
    const recorded: Recorded = { locked: false, selects: 0, inserts: [], updates: [] };

    const select = vi.fn(() => {
      recorded.selects += 1;
      return {
        from: () => ({
          where: () => ({
            for: () => {
              recorded.locked = true;
              return Promise.resolve(found);
            },
          }),
        }),
      };
    });

    const insert = vi.fn(() => ({
      values: (values: Record<string, unknown>[]) => {
        recorded.inserts.push(values);
        return Object.assign(Promise.resolve(undefined), {
          returning: () =>
            Promise.resolve(
              values.flatMap((value) => {
                const id = createdIds[String(value.sku)];
                return id === undefined ? [] : [{ id, sku: value.sku }];
              }),
            ),
        });
      },
    }));

    const update = vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          recorded.updates.push(values);
          return Promise.resolve(undefined);
        },
      }),
    }));

    return { recorded, tx: { select, insert, update } as unknown as DbTransaction };
  };

  const edited = (current: EmbeddingStatusWrite): EmbeddingStatusWrite => ({
    state: 'STALE',
    error: null,
    attempts: current.attempts,
  });

  const run = (fake: ReturnType<typeof fakeTx>, rows: readonly UpsertRow[]) =>
    upsertProducts(fake.tx, { tenantId: TENANT, rows, hashOf, edited, reason: 'import' });

  it('reads nothing and writes nothing for an empty import', async () => {
    const fake = fakeTx([]);

    expect(await run(fake, [])).toEqual([]);
    expect(fake.recorded.selects).toBe(0);
    expect(fake.recorded.inserts).toEqual([]);
  });

  it('locks the rows it reads before deciding anything', async () => {
    const fake = fakeTx([stored()]);

    await run(fake, [row()]);

    expect(fake.recorded.locked).toBe(true);
  });

  it('inserts new wines in one statement and their jobs in another', async () => {
    const fake = fakeTx([], { A: 'id-a', B: 'id-b' });

    const outcomes = await run(fake, [row({ sku: 'A' }, 0), row({ sku: 'B' }, 1)]);

    expect(outcomes).toEqual([
      { index: 0, outcome: 'created', productId: 'id-a' },
      { index: 1, outcome: 'created', productId: 'id-b' },
    ]);
    expect(fake.recorded.inserts).toHaveLength(2);
    expect(fake.recorded.inserts[0]).toEqual([
      expect.objectContaining({ sku: 'A', tenantId: TENANT, embeddingState: 'PENDING' }),
      expect.objectContaining({ sku: 'B', tenantId: TENANT, embeddingState: 'PENDING' }),
    ]);
    expect(fake.recorded.inserts[1]).toEqual([
      expect.objectContaining({
        tenantId: TENANT,
        aggregateId: 'id-a',
        payload: { reason: 'import' },
      }),
      expect.objectContaining({
        tenantId: TENANT,
        aggregateId: 'id-b',
        payload: { reason: 'import' },
      }),
    ]);
  });

  it('moves a re-embedded wine along the edited edge and queues it', async () => {
    const fake = fakeTx([stored()]);

    const [outcome] = await run(fake, [row({ tastingNotes: 'Catrame.' })]);

    expect(outcome).toEqual({
      index: 0,
      outcome: 'updated',
      productId: 'p-1',
      reindexed: true,
      archived: false,
    });
    expect(fake.recorded.updates).toEqual([
      expect.objectContaining({
        tastingNotes: 'Catrame.',
        embeddingState: 'STALE',
        embeddingError: null,
      }),
    ]);
    expect(fake.recorded.inserts).toEqual([[expect.objectContaining({ aggregateId: 'p-1' })]]);
  });

  it('updates a price without touching the embedding state or the queue', async () => {
    const fake = fakeTx([stored()]);

    const [outcome] = await run(fake, [row({ priceCents: 4900 })]);

    expect(outcome).toMatchObject({ outcome: 'updated', reindexed: false });
    expect(fake.recorded.updates).toHaveLength(1);
    expect(fake.recorded.updates[0]).not.toHaveProperty('embeddingState');
    expect(fake.recorded.inserts).toEqual([]);
  });

  it('writes nothing at all for an unchanged row', async () => {
    const fake = fakeTx([stored()]);

    const [outcome] = await run(fake, [row({ tastingNotes: 'Rosa appassita.' })]);

    expect(outcome).toMatchObject({ outcome: 'unchanged', reindexed: false });
    expect(fake.recorded.updates).toEqual([]);
    expect(fake.recorded.inserts).toEqual([]);
  });

  it('flags a match on an archived wine', async () => {
    const fake = fakeTx([stored({ status: 'ARCHIVED' })]);

    const [outcome] = await run(fake, [row({ priceCents: 4100 })]);

    expect(outcome).toMatchObject({ outcome: 'updated', archived: true });
    expect(fake.recorded.updates[0]).not.toHaveProperty('status');
  });

  it('reports duplicates by SKU and writes neither', async () => {
    const fake = fakeTx([]);

    const outcomes = await run(fake, [row({}, 0), row({}, 1)]);

    expect(outcomes).toEqual([
      { index: 0, outcome: 'duplicate-sku', sku: 'BAR-2019' },
      { index: 1, outcome: 'duplicate-sku', sku: 'BAR-2019' },
    ]);
    expect(fake.recorded.inserts).toEqual([]);
  });

  it('refuses to report a created row the insert did not return', async () => {
    // Unreachable against Postgres; here so the guard is a statement rather than a hope.
    const fake = fakeTx([], {});

    await expect(run(fake, [row({ sku: 'A' })])).rejects.toThrow(/without an id/);
  });
});

describe('previewUpsert (P1-23)', () => {
  /** A transaction that answers its one read with `found` and throws on any write. */
  const readOnly = (found: ProductRow[]) => {
    const where = vi.fn(() => Promise.resolve(found));
    const refuse = () => {
      throw new Error('a preview must not write');
    };
    const tx = {
      select: () => ({ from: () => ({ where }) }),
      insert: refuse,
      update: refuse,
      delete: refuse,
    } as unknown as DbTransaction;

    return { tx, where };
  };

  it('classifies every kind of row as the import would, writing nothing', async () => {
    const { tx, where } = readOnly([
      stored(),
      stored({ id: 'p-2', sku: 'ETN-2020' }),
      stored({ id: 'p-3', sku: 'OLD-1', status: 'ARCHIVED' }),
    ]);

    const outcomes = await previewUpsert(tx, {
      rows: [
        row({ sku: 'NEW-1' }, 0),
        row({ priceCents: 4800 }, 1),
        row({ sku: 'ETN-2020' }, 2),
        row({ sku: 'OLD-1' }, 3),
        row({ sku: 'DUP' }, 4),
        row({ sku: 'DUP' }, 5),
        row({ sku: 'ETN-2020', name: 'Etna Rosso' }, 6),
      ],
      hashOf,
    });

    expect(where).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      { index: 0, outcome: 'created' },
      { index: 1, outcome: 'updated', productId: 'p-1', reindexed: false, archived: false },
      { index: 2, outcome: 'duplicate-sku', sku: 'ETN-2020' },
      { index: 3, outcome: 'unchanged', productId: 'p-3', reindexed: false, archived: true },
      { index: 4, outcome: 'duplicate-sku', sku: 'DUP' },
      { index: 5, outcome: 'duplicate-sku', sku: 'DUP' },
      { index: 6, outcome: 'duplicate-sku', sku: 'ETN-2020' },
    ]);
  });

  it('predicts a re-embedding by the same hash the import uses', async () => {
    const { tx } = readOnly([stored()]);

    const [outcome] = await previewUpsert(tx, { rows: [row({ name: 'Barolo Riserva' })], hashOf });

    expect(outcome).toEqual({
      index: 0,
      outcome: 'updated',
      productId: 'p-1',
      reindexed: true,
      archived: false,
    });
  });

  it('reads nothing for no rows', async () => {
    const { tx, where } = readOnly([]);

    expect(await previewUpsert(tx, { rows: [], hashOf })).toEqual([]);
    expect(where).not.toHaveBeenCalled();
  });
});
