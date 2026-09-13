import { describe, expect, it, vi } from 'vitest';

import {
  activeEmbeddingVersionFilter,
  CURRENT_EMBEDDING_VERSION,
  EMBEDDING_CHUNK,
  missingForEmbeddingVersion,
  readActiveEmbeddingVersion,
  readProductForEmbedding,
  switchEmbeddingVersion,
  upsertEmbedding,
  writeEmbeddingStatus,
} from '../src/embeddings.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The embedding statements, without a database (P1-37).
 *
 * Shapes and branches only, on the same terms as `products.write.test.ts`.
 * **What a fake cannot show is everything that makes these correct**: that a
 * transaction opened for the wrong tenant matches no product, that the vector
 * and the state commit together, and that the upsert replaces rather than
 * appends. Those are a policy, a transaction and a unique constraint, and they
 * live in `embeddings.integration.test.ts`.
 *
 * What belongs here is which columns each statement touches — the kind of
 * mistake that is invisible in review and expensive in production.
 */

const PRODUCT = '22222222-2222-4222-8222-222222222222';
const TENANT = '11111111-1111-4111-8111-111111111111';

interface Recorded {
  /** Whether the product read asked for a row lock. */
  locked: boolean;
  readonly inserted: { values: Record<string, unknown>; conflict: unknown }[];
  readonly updated: Record<string, unknown>[];
}

const fakeTx = (options: { product?: Record<string, unknown>; storedHash?: string } = {}) => {
  const recorded: Recorded = { locked: false, inserted: [], updated: [] };

  const select = vi.fn((fields: Record<string, unknown>) => ({
    from: () => ({
      where: () => {
        const isEmbeddingLookup = Object.keys(fields).length === 1 && 'contentHash' in fields;

        const chain = {
          for: () => {
            recorded.locked = true;
            return chain;
          },
          limit: () =>
            Promise.resolve(
              isEmbeddingLookup
                ? options.storedHash === undefined
                  ? []
                  : [{ contentHash: options.storedHash }]
                : options.product === undefined
                  ? []
                  : [options.product],
            ),
        };

        return chain;
      },
    }),
  }));

  const insert = vi.fn(() => ({
    values: (values: Record<string, unknown>) => ({
      onConflictDoUpdate: (conflict: unknown) => {
        recorded.inserted.push({ values, conflict });
        return Promise.resolve(undefined);
      },
    }),
  }));

  const update = vi.fn(() => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        recorded.updated.push(values);
        return Promise.resolve(undefined);
      },
    }),
  }));

  return { recorded, tx: { select, insert, update } as unknown as DbTransaction };
};

const PRODUCT_ROW = { id: PRODUCT, tenantId: TENANT, name: 'Barolo', embeddingState: 'PENDING' };

describe('readProductForEmbedding', () => {
  it('locks the product row it is about to act on', async () => {
    /*
     * Two deliveries of the same message can arrive at once — SQS is
     * at-least-once and the poller sends before it marks. Without the lock both
     * read `PENDING`, both call the provider, and both write: paid twice, and
     * racing on the state column.
     */
    const fake = fakeTx({ product: PRODUCT_ROW });

    await readProductForEmbedding(fake.tx, PRODUCT);

    expect(fake.recorded.locked).toBe(true);
  });

  it('returns undefined for a product this transaction cannot see', async () => {
    // Deleted, or belonging to another tenant — which RLS makes the same thing,
    // and which the worker reports as `gone` rather than as an error.
    const fake = fakeTx({});

    expect(await readProductForEmbedding(fake.tx, PRODUCT)).toBeUndefined();
  });

  it('reports a null embedded hash when nothing has been stored', async () => {
    /*
     * Null is what makes `shouldEmbed` true, and the distinction it draws is
     * "never embedded" against "unchanged". A wine that came back carrying a
     * hash it was never embedded under would be skipped for ever.
     */
    const fake = fakeTx({ product: PRODUCT_ROW });

    expect((await readProductForEmbedding(fake.tx, PRODUCT))?.embeddedHash).toBeNull();
  });

  it('reports the stored hash when there is one', async () => {
    const fake = fakeTx({ product: PRODUCT_ROW, storedHash: 'abc' });

    expect((await readProductForEmbedding(fake.tx, PRODUCT))?.embeddedHash).toBe('abc');
  });
});

describe('upsertEmbedding', () => {
  const store = async (fake: ReturnType<typeof fakeTx>) =>
    upsertEmbedding(fake.tx, {
      tenantId: TENANT,
      productId: PRODUCT,
      contentHash: 'h',
      embedding: [0.1, 0.2],
      model: 'amazon.titan-embed-text-v2:0',
    });

  it('writes into the chunk this pipeline owns', async () => {
    const fake = fakeTx();

    await store(fake);

    expect(fake.recorded.inserted[0]?.values).toMatchObject({
      chunkIdx: EMBEDDING_CHUNK,
      contentHash: 'h',
      model: 'amazon.titan-embed-text-v2:0',
      version: CURRENT_EMBEDDING_VERSION,
    });
  });

  it('writes the generation it is given, which is what dual-write needs (P1-49)', async () => {
    const fake = fakeTx();

    await upsertEmbedding(fake.tx, {
      tenantId: TENANT,
      productId: PRODUCT,
      contentHash: 'h2',
      embedding: [0.1],
      model: 'next-model',
      version: 2,
    });

    expect(fake.recorded.inserted[0]?.values).toMatchObject({ version: 2 });
  });

  it('writes generation 1 today, the one every stored vector already is', () => {
    // The column default in migration 0041; moving this without the runbook
    // would file new vectors under a generation no tenant reads.
    expect(CURRENT_EMBEDDING_VERSION).toBe(1);
  });

  it('targets the unique constraint rather than conflicting blindly', async () => {
    /*
     * A bare conflict target would swallow the next unique index somebody adds
     * and report a silent success — the same argument `insertProduct` makes
     * about `DO NOTHING`. Four columns, because that is the constraint — the
     * version joined it in P1-49.
     */
    const fake = fakeTx();

    await store(fake);

    const conflict = fake.recorded.inserted[0]?.conflict as { target?: unknown[] };

    expect(conflict.target).toHaveLength(4);
  });

  it('replaces the hash and the model alongside the vector', async () => {
    /*
     * All three or none. A vector updated while its hash stayed behind is a row
     * that reads as current and is not — and `shouldEmbed` would then skip the
     * wine that most needs re-embedding.
     */
    const fake = fakeTx();

    await store(fake);

    const set = (fake.recorded.inserted[0]?.conflict as { set: Record<string, unknown> }).set;

    expect(Object.keys(set).sort()).toEqual(['contentHash', 'createdAt', 'embedding', 'model']);
  });
});

describe('writeEmbeddingStatus', () => {
  it('moves the three columns that describe the pipeline together', async () => {
    /*
     * They are one fact. A `FAILED` row carrying last week's error, or an
     * `INDEXED` one still carrying any, tells an operator something untrue —
     * and P1-50's triage reads exactly these.
     */
    const fake = fakeTx();

    await writeEmbeddingStatus(fake.tx, PRODUCT, {
      state: 'FAILED',
      error: 'ThrottlingException',
      attempts: 2,
    });

    expect(fake.recorded.updated[0]).toEqual({
      embeddingState: 'FAILED',
      embeddingError: 'ThrottlingException',
      embeddingAttempts: 2,
    });
  });

  it('does not name updated_at, which the database owns anyway', async () => {
    /*
     * P0-22's `BEFORE UPDATE` trigger sets it unconditionally, so naming it
     * here would be a statement that looks like it decides something and does
     * not. The integration suite asserts what actually happens to the column.
     */
    const fake = fakeTx();

    await writeEmbeddingStatus(fake.tx, PRODUCT, { state: 'INDEXED', error: null, attempts: 0 });

    expect(fake.recorded.updated[0]).not.toHaveProperty('updatedAt');
  });
});

/** A transaction whose `execute` answers each call with the next result, in order. */
const executing = (...results: unknown[][]) => {
  const execute = vi.fn(() => Promise.resolve(results.shift() ?? []));
  return { execute, tx: { execute } as unknown as DbTransaction };
};

describe('the active generation (P1-49)', () => {
  it('reads the pointer as a number', async () => {
    const fake = executing([{ embedding_version: 2 }]);

    expect(await readActiveEmbeddingVersion(fake.tx, TENANT)).toBe(2);
  });

  it('refuses rather than defaulting when the tenant is not visible', async () => {
    await expect(readActiveEmbeddingVersion(executing([]).tx, TENANT)).rejects.toThrow(
      /not visible/,
    );
  });

  it('counts the missing wines, and none when the count comes back empty', async () => {
    expect(
      await missingForEmbeddingVersion(executing([{ missing: 3 }]).tx, {
        tenantId: TENANT,
        version: 2,
      }),
    ).toBe(3);
    expect(
      await missingForEmbeddingVersion(executing([]).tx, { tenantId: TENANT, version: 2 }),
    ).toBe(0);
  });
});

describe('switchEmbeddingVersion (P1-49)', () => {
  it.each([0, -1, 1.5])('refuses %s before touching the database', async (version) => {
    const fake = executing();

    await expect(switchEmbeddingVersion(fake.tx, { tenantId: TENANT, version })).rejects.toThrow(
      RangeError,
    );
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('refuses a cutover with even one wine missing, and writes nothing', async () => {
    const fake = executing([{ embedding_version: 1 }], [{ missing: 1 }]);

    expect(await switchEmbeddingVersion(fake.tx, { tenantId: TENANT, version: 2 })).toEqual({
      outcome: 'incomplete',
      version: 2,
      missing: 1,
    });
    expect(fake.execute).toHaveBeenCalledTimes(2);
  });

  it('moves the pointer when nothing is missing, and says from where', async () => {
    const fake = executing([{ embedding_version: 1 }], [{ missing: 0 }], []);

    expect(await switchEmbeddingVersion(fake.tx, { tenantId: TENANT, version: 2 })).toEqual({
      outcome: 'switched',
      from: 1,
      to: 2,
    });
    expect(fake.execute).toHaveBeenCalledTimes(3);
  });

  it('refuses when the tenant it was asked to move is not visible', async () => {
    await expect(
      switchEmbeddingVersion(executing([]).tx, { tenantId: TENANT, version: 2 }),
    ).rejects.toThrow(/not visible/);
  });
});

describe('activeEmbeddingVersionFilter (P1-49)', () => {
  it.each(['e', 'product_embeddings'])('accepts the alias %s', (alias) => {
    expect(() => activeEmbeddingVersionFilter(alias)).not.toThrow();
  });

  it.each(['e; drop table tenants', 'E', '"e"', ''])(
    'refuses %j, which is not an alias',
    (alias) => {
      expect(() => activeEmbeddingVersionFilter(alias)).toThrow(/not a table alias/);
    },
  );
});
