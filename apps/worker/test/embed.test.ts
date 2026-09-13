import type { EmbeddingProvider } from '@catalogorosso/core';
import { describe, expect, it, vi } from 'vitest';

import { embedProduct, handler, type SqsEvent } from '../src/embed.js';
import type { EmbeddingMessage } from '../src/outbox-poller.js';

/**
 * The embedding consumer (P1-37).
 *
 * The provider and the database are both injected, so none of this needs AWS,
 * Bedrock or a container. **What it cannot show is that the vector and the
 * state commit together**, or that a message naming the wrong tenant matches no
 * row — a fake transaction rolls back nothing and enforces no policy. Both are
 * in `packages/db/test/embeddings.integration.test.ts`.
 *
 * What belongs here is the decision tree: what gets embedded, what does not,
 * and what a batch reports when one message in it fails.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';

const message = (over: Partial<EmbeddingMessage> = {}): EmbeddingMessage => ({
  outboxId: 1,
  tenantId: TENANT,
  productId: PRODUCT,
  reason: 'created',
  ...over,
});

const ROW = {
  id: PRODUCT,
  tenantId: TENANT,
  status: 'ACTIVE',
  embeddingState: 'PENDING' as 'PENDING' | 'INDEXED' | 'FAILED' | 'STALE',
  embeddingError: null as string | null,
  embeddingAttempts: 0,
  embeddedHash: null as string | null,
  name: 'Barolo Bussia',
  producer: 'Poderi Colla',
  vintage: 2019,
  wineType: 'red',
  grapeVarieties: ['Nebbiolo'],
  region: 'Piemonte',
  denomination: 'DOCG',
  styleTags: ['strutturato'],
  tastingNotes: 'Rosa appassita, catrame e ciliegia sotto spirito.',
  foodPairings: ['brasato'],
  alcoholPct: '14.50',
  priceCents: 4500,
};

const vector = (fill = 0.5) => Array.from({ length: 1024 }, () => fill);

const provider = (embed = vi.fn(() => Promise.resolve([vector()]))): EmbeddingProvider => ({
  model: 'amazon.titan-embed-text-v2:0',
  dim: 1024,
  embed,
});

interface Written {
  readonly statuses: { state: string; error: string | null; attempts: number }[];
  readonly vectors: { contentHash: string; model: string }[];
}

/**
 * A `Database` whose transaction serves one product row and records the writes.
 *
 * `rows: []` stands for a product that is not visible in this tenant — which is
 * what a message naming the wrong tenant produces once RLS has had its say.
 */
const fakeDb = (
  options: { row?: typeof ROW | undefined; failWrite?: boolean; failVector?: boolean } = {
    row: ROW,
  },
) => {
  const written: Written = { statuses: [], vectors: [] };
  const row = options.row;

  const tx = {
    /*
     * Keyed on the *selected fields*, not on the table. Both statements read a
     * table that has a `content_hash` column, so telling them apart by table
     * picked the wrong one — and the symptom was every product reading as
     * `gone`, which is a plausible outcome rather than an obvious bug.
     */
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const isEmbeddingLookup = Object.keys(fields).length === 1 && 'contentHash' in fields;

          const chain = {
            for: () => chain,
            limit: () =>
              Promise.resolve(
                isEmbeddingLookup
                  ? row?.embeddedHash == null
                    ? []
                    : [{ contentHash: row.embeddedHash }]
                  : row === undefined
                    ? []
                    : [row],
              ),
          };

          return chain;
        },
      }),
    }),

    insert: () => ({
      values: (values: { contentHash: string; model: string }) => ({
        onConflictDoUpdate: () => {
          if (options.failVector === true) {
            // A database refusal named like a provider error, which must not read as one.
            return Promise.reject(
              Object.assign(new Error('connection lost'), { name: 'ValidationException' }),
            );
          }

          written.vectors.push({ contentHash: values.contentHash, model: values.model });
          return Promise.resolve(undefined);
        },
      }),
    }),

    update: () => ({
      set: (values: {
        embeddingState: string;
        embeddingError: string | null;
        embeddingAttempts: number;
      }) => ({
        where: () => {
          if (options.failWrite === true) {
            return Promise.reject(Object.assign(new Error('down'), { name: 'ConnectionError' }));
          }

          written.statuses.push({
            state: values.embeddingState,
            error: values.embeddingError,
            attempts: values.embeddingAttempts,
          });

          return Promise.resolve(undefined);
        },
      }),
    }),

    execute: () => Promise.resolve([]),
  };

  const database = {
    transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };

  return { written, database: database as never };
};

describe('the ordinary path', () => {
  it('embeds the wine, stores the vector and records INDEXED', async () => {
    const embed = vi.fn(() => Promise.resolve([vector()]));
    const fake = fakeDb();

    const result = await embedProduct(message(), {
      provider: provider(embed),
      database: fake.database,
    });

    expect(result).toEqual({ outcome: 'indexed', productId: PRODUCT });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(fake.written.vectors).toHaveLength(1);
    expect(fake.written.statuses).toEqual([{ state: 'INDEXED', error: null, attempts: 0 }]);
  });

  it('embeds the text the builder produces, not the row', async () => {
    /*
     * The seam P1-33 exists for. Handing the provider a JSON blob of the row
     * would embed column names and nulls, and retrieval would degrade in a way
     * no test of *this* file would notice — the vector would still be 1024
     * numbers and the state would still say INDEXED.
     */
    const embed = vi.fn(() => Promise.resolve([vector()]));

    await embedProduct(message(), { provider: provider(embed), database: fakeDb().database });

    const [texts] = embed.mock.calls[0] as unknown as [readonly string[]];

    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Barolo Bussia');
    expect(texts[0]).toContain('brasato');
    expect(texts[0]).not.toContain('embeddingState');
  });

  it('stores the hash of what it embedded, beside the vector', async () => {
    /*
     * **Not `products.content_hash`.** That column is written at *edit* time,
     * so it already matches on a freshly created wine — feeding it to
     * `shouldEmbed` would make the worker skip the entire catalogue and report
     * success doing it. The hash stored here answers a different question:
     * what was this vector actually built from.
     */
    const fake = fakeDb();

    await embedProduct(message(), { provider: provider(), database: fake.database });

    expect(fake.written.vectors[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.written.vectors[0]?.model).toBe('amazon.titan-embed-text-v2:0');
  });
});

describe('what it declines to embed', () => {
  it('skips a wine whose stored vector is already current', async () => {
    /*
     * SQS is at-least-once and the poller sends before it marks, so duplicates
     * are by design. The provider call is the part that costs.
     */
    const embed = vi.fn(() => Promise.resolve([vector()]));
    const fake = fakeDb();

    // First pass to learn the hash this row produces, then replay it as stored.
    await embedProduct(message(), { provider: provider(embed), database: fake.database });
    const hash = fake.written.vectors[0]?.contentHash ?? '';

    const second = fakeDb({ row: { ...ROW, embeddedHash: hash, embeddingState: 'INDEXED' } });
    const secondEmbed = vi.fn(() => Promise.resolve([vector()]));

    const result = await embedProduct(message(), {
      provider: provider(secondEmbed),
      database: second.database,
    });

    expect(result).toEqual({ outcome: 'unchanged', productId: PRODUCT });
    expect(secondEmbed).not.toHaveBeenCalled();
    expect(second.written.vectors).toEqual([]);
    expect(second.written.statuses).toEqual([]);
  });

  it('corrects a state that disagrees with the vector, without paying again', async () => {
    /*
     * A row whose vector is current but whose state still says PENDING is
     * exactly the disagreement P1-38 exists to prevent — and it is reachable,
     * because a crash between the two writes on an earlier delivery leaves it.
     * One UPDATE, no provider call.
     */
    const fake = fakeDb();
    await embedProduct(message(), { provider: provider(), database: fake.database });
    const hash = fake.written.vectors[0]?.contentHash ?? '';

    const stale = fakeDb({ row: { ...ROW, embeddedHash: hash, embeddingState: 'PENDING' } });
    const embed = vi.fn(() => Promise.resolve([vector()]));

    await embedProduct(message(), { provider: provider(embed), database: stale.database });

    expect(embed).not.toHaveBeenCalled();
    expect(stale.written.statuses).toEqual([{ state: 'INDEXED', error: null, attempts: 0 }]);
  });

  it('reports a product that is not there as gone, and does not throw', async () => {
    /*
     * Deleted, or named by a message for another tenant — which RLS turns into
     * the same thing. Throwing would retry three times and park a job for a
     * wine that no longer exists in the DLQ, where it would read as a provider
     * failure.
     */
    const fake = fakeDb({ row: undefined });

    const result = await embedProduct(message(), {
      provider: provider(),
      database: fake.database,
    });

    expect(result).toEqual({ outcome: 'gone', productId: PRODUCT });
    expect(fake.written.statuses).toEqual([]);
  });

  it('refuses to re-embed an archived wine', async () => {
    /*
     * **P1-04 deletes an archived wine's vectors on purpose**, so re-embedding
     * one puts it back in front of visitors — the one thing archiving means to
     * stop, done by a background job the seller cannot see.
     */
    const embed = vi.fn(() => Promise.resolve([vector()]));
    const fake = fakeDb({ row: { ...ROW, status: 'ARCHIVED' } });

    const result = await embedProduct(message(), {
      provider: provider(embed),
      database: fake.database,
    });

    expect(result).toEqual({ outcome: 'archived', productId: PRODUCT });
    expect(embed).not.toHaveBeenCalled();
    expect(fake.written.vectors).toEqual([]);
  });
});

describe('failure', () => {
  it('records a transient failure and rethrows it, so SQS retries', async () => {
    /*
     * **Both halves, and they pull in opposite directions.** The write is what
     * P1-50's triage reads; the throw is what makes SQS redeliver. Only the
     * first loses the retry, only the second leaves a wine at PENDING with no
     * reason recorded anywhere.
     */
    const embed = vi.fn(() =>
      Promise.reject(Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' })),
    );
    const fake = fakeDb();

    await expect(
      embedProduct(message(), { provider: provider(embed), database: fake.database }),
    ).rejects.toThrow('rate exceeded');

    expect(fake.written.statuses).toEqual([
      { state: 'FAILED', error: 'service-unavailable', attempts: 1 },
    ]);
  });

  it('still rethrows the original error when recording the failure also fails', async () => {
    /*
     * A database refusing writes is a plausible *cause* of the original
     * failure. Letting the bookkeeping throw would replace the real reason with
     * "could not record the reason", and the DLQ would fill with the wrong
     * story.
     */
    const embed = vi.fn(() =>
      Promise.reject(Object.assign(new Error('boom'), { name: 'ModelTimeoutException' })),
    );
    const lines: string[] = [];

    await expect(
      embedProduct(message(), {
        provider: provider(embed),
        database: fakeDb({ row: ROW, failWrite: true }).database,
        log: (line) => lines.push(line),
      }),
    ).rejects.toThrow('boom');

    expect(lines.map((line) => JSON.parse(line) as { event: string })).toEqual([
      { event: 'embedding.status_write_failed', productId: PRODUCT, reason: 'ConnectionError' },
    ]);
  });
});

describe('its defaults', () => {
  it('refuses a provider that returned no vector at all', async () => {
    /*
     * `assertBatchAligned` inside the provider makes this unreachable through
     * the Titan adapter — which is exactly why it is worth having: a provider
     * that skipped that check would otherwise write `undefined` into a NOT NULL
     * vector column, and the error would name the column rather than the cause.
     */
    const embed = vi.fn(() => Promise.resolve([]));
    const fake = fakeDb();

    await expect(
      embedProduct(message(), { provider: provider(embed), database: fake.database }),
    ).rejects.toThrow(/no vector/);

    expect(fake.written.vectors).toEqual([]);
    expect(fake.written.statuses).toEqual([
      { state: 'FAILED', error: 'service-unavailable', attempts: 1 },
    ]);
  });

  it('builds its own provider and logger when none are supplied', async () => {
    /*
     * Construction only — the batch is empty, so nothing is called. What it
     * pins is that the production path needs neither injected, which is the
     * shape every other test here bypasses.
     */
    const result = await handler({ Records: [] });

    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('writes to the console when no logger is injected', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await handler({ Records: [{ messageId: 'm0', body: 'not json' }] }, undefined, {
        provider: provider(),
        database: fakeDb().database,
      });

      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
    }
  });
});

describe('the batch', () => {
  const event = (bodies: readonly string[]): SqsEvent => ({
    Records: bodies.map((body, index) => ({ messageId: `m${String(index)}`, body })),
  });

  it('reports only the messages that failed', async () => {
    /*
     * **The whole reason `reportBatchItemFailures` is set on the mapping.**
     * Throwing would fail the batch: nine wines that embedded successfully
     * would be redelivered, re-embedded and paid for again because a tenth was
     * malformed — and after three rounds all ten would land in the DLQ.
     */
    let call = 0;
    const embed = vi.fn(() => {
      call += 1;
      return call === 2
        ? Promise.reject(Object.assign(new Error('nope'), { name: 'ThrottlingException' }))
        : Promise.resolve([vector()]);
    });

    const result = await handler(
      event([JSON.stringify(message()), JSON.stringify(message()), JSON.stringify(message())]),
      undefined,
      { provider: provider(embed), database: fakeDb().database, log: () => undefined },
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });

  it('reports an unreadable message rather than dropping it', async () => {
    /*
     * There is no product to record a failure against and no reason to expect a
     * retry to do better — so this is how it reaches the DLQ, which is where a
     * message nobody can act on belongs. Silently discarding it would leave a
     * queue that cannot be debugged.
     */
    const lines: string[] = [];

    const result = await handler(
      event(['not json at all', '{"tenantId":"only-half"}']),
      undefined,
      {
        provider: provider(),
        database: fakeDb().database,
        log: (line) => lines.push(line),
      },
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm0' }, { itemIdentifier: 'm1' }]);
    expect(lines).toHaveLength(2);
  });

  it('returns an empty failure list when everything worked', async () => {
    const result = await handler(event([JSON.stringify(message())]), undefined, {
      provider: provider(),
      database: fakeDb().database,
      log: () => undefined,
    });

    expect(result.batchItemFailures).toEqual([]);
  });

  it('processes records one at a time, not in parallel', async () => {
    /*
     * Each record opens a transaction. A batch of ten fanned out would hold ten
     * connections from a pool sized for the whole platform — P1-32's arithmetic
     * budgets two per invocation, not ten, and exhausting `max_connections` is
     * how the database falls over while the symptom looks like an application
     * fault.
     */
    let inFlight = 0;
    let peak = 0;

    const embed = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return [vector()];
    });

    await handler(event(Array.from({ length: 5 }, () => JSON.stringify(message()))), undefined, {
      provider: provider(embed),
      database: fakeDb().database,
      log: () => undefined,
    });

    expect(peak).toBe(1);
  });
});

describe('what a failure means (P1-50)', () => {
  const refused = (name: string) =>
    vi.fn(() =>
      Promise.reject(
        Object.assign(new Error('https://user:secret@bedrock.example refused'), { name }),
      ),
    );

  it('fails fast on a text the provider refused: one call, recorded, acknowledged', async () => {
    const embed = refused('ValidationException');
    const fake = fakeDb();

    const result = await embedProduct(message(), {
      provider: provider(embed),
      database: fake.database,
    });

    expect(result).toEqual({
      outcome: 'failed',
      productId: PRODUCT,
      reason: 'input-rejected',
      providerError: 'ValidationException',
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(fake.written.statuses).toEqual([
      { state: 'FAILED', error: 'input-rejected', attempts: 1 },
    ]);
  });

  it('stores a reason code, never the provider’s message or its error name', async () => {
    // P0-56 applied to a column the seller's grid reads.
    const fake = fakeDb();

    await embedProduct(message(), {
      provider: provider(refused('ValidationException')),
      database: fake.database,
    });

    expect(JSON.stringify(fake.written.statuses)).not.toMatch(/secret|bedrock|Exception/);
  });

  it('retries an unrecognised provider error once, then records it as permanent', async () => {
    const first = fakeDb();
    await expect(
      embedProduct(
        message(),
        { provider: provider(refused('ModelErrorException')), database: first.database },
        1,
      ),
    ).rejects.toThrow();
    expect(first.written.statuses[0]?.error).toBe('unknown');

    const second = fakeDb();
    expect(
      await embedProduct(
        message(),
        { provider: provider(refused('ModelErrorException')), database: second.database },
        2,
      ),
    ).toMatchObject({ outcome: 'failed', reason: 'unknown' });
  });

  it('never fails a wine permanently for something that went wrong around the provider', async () => {
    const fake = fakeDb({ row: ROW, failVector: true });

    await expect(
      embedProduct(message(), { provider: provider(), database: fake.database }, 5),
    ).rejects.toThrow('connection lost');
    expect(fake.written.statuses).toEqual([
      { state: 'FAILED', error: 'service-unavailable', attempts: 1 },
    ]);
  });

  it('keeps retrying an operator problem, which belongs behind the DLQ alarm', async () => {
    const fake = fakeDb();

    await expect(
      embedProduct(
        message(),
        { provider: provider(refused('AccessDeniedException')), database: fake.database },
        3,
      ),
    ).rejects.toThrow();
    expect(fake.written.statuses[0]?.error).toBe('service-unavailable');
  });

  it('indexes a failed wine once its text is fixed, clearing the reason', async () => {
    // The loop closes without new code: an edit re-queues it (P1-38), and success clears the error.
    const fake = fakeDb({
      row: {
        ...ROW,
        embeddingState: 'FAILED',
        embeddingError: 'input-rejected',
        embeddingAttempts: 1,
      },
    });

    expect(
      await embedProduct(message({ reason: 'edited' }), {
        provider: provider(),
        database: fake.database,
      }),
    ).toEqual({ outcome: 'indexed', productId: PRODUCT });
    expect(fake.written.statuses).toEqual([{ state: 'INDEXED', error: null, attempts: 1 }]);
  });
});

describe('the batch, after P1-50', () => {
  const record = (messageId: string, receiveCount?: string) => ({
    messageId,
    body: JSON.stringify(message()),
    ...(receiveCount === undefined
      ? {}
      : { attributes: { ApproximateReceiveCount: receiveCount } }),
  });

  const refusedBy = (name: string) =>
    provider(vi.fn(() => Promise.reject(Object.assign(new Error('no'), { name }))));

  it('acknowledges a refused text rather than sending it towards the DLQ', async () => {
    const lines: string[] = [];

    const result = await handler({ Records: [record('m0', '1')] }, undefined, {
      provider: refusedBy('ValidationException'),
      database: fakeDb().database,
      log: (line) => lines.push(line),
    });

    expect(result.batchItemFailures).toEqual([]);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      event: 'embedding.processed',
      outcome: 'failed',
      reason: 'input-rejected',
      providerError: 'ValidationException',
    });
  });

  it('reads the delivery count SQS reports, so an unknown error gets exactly one more try', async () => {
    const options = {
      provider: refusedBy('ModelErrorException'),
      database: fakeDb().database,
      log: () => undefined,
    };

    expect(
      (await handler({ Records: [record('m0', '1')] }, undefined, options)).batchItemFailures,
    ).toEqual([{ itemIdentifier: 'm0' }]);
    expect(
      (await handler({ Records: [record('m0', '2')] }, undefined, options)).batchItemFailures,
    ).toEqual([]);
  });

  it('treats a record with no count, or a nonsense one, as a first delivery', async () => {
    const result = await handler({ Records: [record('m0'), record('m1', 'abc')] }, undefined, {
      provider: refusedBy('ModelErrorException'),
      database: fakeDb().database,
      log: () => undefined,
    });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm0' }, { itemIdentifier: 'm1' }]);
  });

  it('logs the provider’s own error name for an operator when a failure is retried', async () => {
    const lines: string[] = [];

    await handler({ Records: [record('m0', '1')] }, undefined, {
      provider: refusedBy('ThrottlingException'),
      database: fakeDb().database,
      log: (line) => lines.push(line),
    });

    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      event: 'embedding.failed',
      reason: 'ThrottlingException',
    });
  });
});
