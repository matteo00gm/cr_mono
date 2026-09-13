import {
  classifyEmbeddingFailure,
  contentHashOf,
  EmbeddingProviderError,
  embeddingText,
  nextEmbeddingStatus,
  shouldEmbed,
  type EmbeddableProduct,
  type EmbeddingFailure,
  type EmbeddingFailureReason,
  type EmbeddingProvider,
} from '@catalogorosso/core';
import {
  readProductForEmbedding,
  upsertEmbedding,
  withTenant,
  writeEmbeddingStatus,
  type Database,
  type EmbeddableRow,
} from '@catalogorosso/db';

import { titanEmbeddingProvider, TITAN_PROVENANCE } from './providers/titan.js';
import type { EmbeddingMessage } from './outbox-poller.js';

/**
 * The consumer (P1-37).
 *
 * P1-31 fills the queue; this is what empties it. Load the wine, decide whether
 * it is worth a provider call, embed, store the vector, record the state.
 *
 * **Everything here runs inside one `withTenant` transaction**, so a crash
 * between the vector and the state cannot leave a row claiming `INDEXED` with
 * nothing behind it — the state column is only true because the write it
 * describes committed alongside it.
 */

/** What one message did, for the log and for the tests. */
export type EmbedOutcome =
  | { readonly outcome: 'indexed'; readonly productId: string }
  | { readonly outcome: 'unchanged'; readonly productId: string }
  | { readonly outcome: 'gone'; readonly productId: string }
  | { readonly outcome: 'archived'; readonly productId: string }
  | {
      readonly outcome: 'failed';
      readonly productId: string;
      readonly reason: EmbeddingFailureReason;
      readonly providerError: string | undefined;
    };

export interface EmbedDependencies {
  readonly provider: EmbeddingProvider;
  readonly database?: Database | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * The product as the text builder wants it.
 *
 * A named function rather than a spread, because `EmbeddableProduct`'s fields
 * are the *contract* between the row and the document: a column added to
 * `products` and not added here is a column the model never sees, and nothing
 * about that fails. Listing them makes the omission visible in a diff.
 */
const embeddable = (row: EmbeddableRow): EmbeddableProduct => ({
  name: row.name,
  producer: row.producer,
  vintage: row.vintage,
  wineType: row.wineType,
  grapeVarieties: row.grapeVarieties,
  region: row.region,
  denomination: row.denomination,
  styleTags: row.styleTags,
  tastingNotes: row.tastingNotes,
  foodPairings: row.foodPairings,
  alcoholPct: row.alcoholPct,
  priceCents: row.priceCents,
});

/**
 * The error that actually happened: the provider's own, when the call was wrapped.
 *
 * The wrapper exists for the classifier alone. SQS, the handler's log line and
 * anybody reading a stack trace should see what failed, not the envelope.
 */
const originalError = (error: unknown): unknown =>
  error instanceof Error && error.name === 'EmbeddingProviderError' ? error.cause : error;

/**
 * Embeds one product, or explains why it did not.
 *
 * **The tenant comes from the message and is used to *open* the transaction,
 * never to filter afterwards.** That is what makes the P1-37 row's "re-validate
 * against the product row" real rather than ceremonial: a message naming the
 * wrong tenant opens a transaction for that tenant and then matches no product,
 * so it reports `gone`. Comparing `row.tenantId` to `message.tenantId` after
 * the fact would only restate what the policy already guaranteed. What makes
 * the id itself trustworthy is that it came out of an `outbox` row whose
 * `WITH CHECK` is tenant-only (P1-31), so it cannot name a tenant its writer
 * was not in.
 *
 * **On failure the state is always written, and the error rethrown only when
 * another delivery could succeed** (P1-50). The write is what the seller's grid
 * reads; the throw is what makes SQS redeliver. A text the provider refused is
 * acknowledged instead, because repeating it cannot help, and an unrecognised
 * provider error gets one more delivery before it is treated the same way.
 * `deliveries` is SQS's own receive count for the message.
 */
export const embedProduct = async (
  message: EmbeddingMessage,
  deps: EmbedDependencies,
  deliveries = 1,
): Promise<EmbedOutcome> => {
  const run = async (): Promise<EmbedOutcome> =>
    withTenant(
      message.tenantId,
      async (tx) => {
        const row = await readProductForEmbedding(tx, message.productId);

        /*
         * Deleted, or never belonged to this tenant. Not an error: the outbox
         * job outlives the product it points at, and a message for a wine that
         * has since gone is the ordinary consequence of that. Throwing would
         * retry it three times and then park it in the DLQ, where it would
         * look like a provider problem.
         */
        if (row === undefined) return { outcome: 'gone', productId: message.productId };

        /*
         * Archived wines keep their row and lose their vectors (P1-04).
         * Re-embedding one would put it back in front of visitors, which is
         * precisely what archiving means to stop — and the seller would have no
         * way to tell it had happened.
         */
        if (row.status === 'ARCHIVED') {
          return { outcome: 'archived', productId: message.productId };
        }

        const product = embeddable(row);
        const hash = contentHashOf(product);

        /*
         * Compared against the hash stored *beside the vector*, never against
         * `products.content_hash` — that one is written at edit time and would
         * match on every freshly created wine, so the worker would skip the
         * whole catalogue and report success doing it.
         */
        if (!shouldEmbed(hash, row.embeddedHash)) {
          /*
           * Still worth a state write. A redelivery of a job whose vector is
           * already current finds `PENDING` on a row that is in fact indexed —
           * the state and the vector disagreeing is exactly what P1-38 exists
           * to stop, and correcting it here costs one UPDATE and no provider
           * call.
           */
          if (row.embeddingState !== 'INDEXED') {
            await writeEmbeddingStatus(
              tx,
              row.id,
              nextEmbeddingStatus({
                status: {
                  state: row.embeddingState,
                  error: row.embeddingError,
                  attempts: row.embeddingAttempts,
                },
                event: 'embedded',
              }),
            );
          }

          return { outcome: 'unchanged', productId: row.id };
        }

        /*
         * Wrapped so the classifier can tell the provider refusing a text from
         * anything else going wrong around it (P1-50). Only the first can be
         * the seller's to fix; a database connection dropped mid-run is not,
         * and must never mark a wine permanently failed.
         */
        const [vector] = await deps.provider
          .embed([embeddingText(product)])
          .catch((error: unknown) => {
            throw new EmbeddingProviderError(error);
          });

        if (vector === undefined) {
          // `assertBatchAligned` in the provider makes this unreachable; it is
          // here so a provider that skipped that check fails loudly rather than
          // writing `undefined` into a NOT NULL vector column.
          throw new Error(`${deps.provider.model} returned no vector for ${row.id}`);
        }

        await upsertEmbedding(tx, {
          tenantId: row.tenantId,
          productId: row.id,
          contentHash: hash,
          embedding: vector,
          model: deps.provider.model,
        });

        await writeEmbeddingStatus(
          tx,
          row.id,
          nextEmbeddingStatus({
            status: {
              state: row.embeddingState,
              error: row.embeddingError,
              attempts: row.embeddingAttempts,
            },
            event: 'embedded',
          }),
        );

        return { outcome: 'indexed', productId: row.id };
      },
      deps.database,
    );

  try {
    return await run();
  } catch (error) {
    /*
     * **Classified before anything else is decided** (P1-50). A permanent
     * failure is recorded and the message acknowledged: repeating a refused
     * text cannot succeed, and it would park a wine the seller can fix in a DLQ
     * meant for problems an operator must. A transient one is recorded and
     * rethrown, so SQS delivers it again and, past its limit, sets it aside
     * behind the alarm.
     */
    const failure = classifyEmbeddingFailure(error, deliveries);

    await recordFailure(message, failure, deps);

    if (failure.retry) throw originalError(error);

    return {
      outcome: 'failed',
      productId: message.productId,
      reason: failure.reason,
      providerError: failure.providerError,
    };
  }
};

/**
 * Writes the failure in its own transaction, because the first one is gone.
 *
 * The transaction that threw has rolled back — under postgres-js it is poisoned
 * from the first statement error, so nothing could be written inside it even if
 * the code tried. A second `withTenant` is the only way the reason survives the
 * failure that produced it.
 *
 * Its own errors are swallowed and logged. A database that is refusing writes
 * is a plausible cause of the original failure, and letting the bookkeeping
 * throw would replace the real reason with "could not record the reason".
 */
const recordFailure = async (
  message: EmbeddingMessage,
  failure: EmbeddingFailure,
  deps: EmbedDependencies,
): Promise<void> => {
  /*
   * A reason *code* from a closed set, never the provider's message or even its
   * error name (P1-50). The message is free text that has carried endpoints and
   * credentials (P0-56), and the name tells a winery nothing. The code is what
   * the API publishes and the dashboard words; the provider's name goes to the
   * operator's log line instead.
   */
  const reason = failure.reason;

  try {
    await withTenant(
      message.tenantId,
      async (tx) => {
        const row = await readProductForEmbedding(tx, message.productId);
        if (row === undefined) return;

        await writeEmbeddingStatus(
          tx,
          row.id,
          nextEmbeddingStatus({
            status: {
              state: row.embeddingState,
              error: row.embeddingError,
              attempts: row.embeddingAttempts,
            },
            event: 'failed',
            error: reason,
          }),
        );
      },
      deps.database,
    );
  } catch (writeError) {
    deps.log?.(
      JSON.stringify({
        event: 'embedding.status_write_failed',
        productId: message.productId,
        reason: (writeError as { name?: string } | undefined)?.name ?? 'UnknownError',
      }),
    );
  }
};

/** The shape Lambda hands an SQS-triggered function. */
export interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
  /** SQS's own metadata. `ApproximateReceiveCount` is how many times this message has been delivered. */
  readonly attributes?: { readonly ApproximateReceiveCount?: string | undefined } | undefined;
}

export interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

export interface BatchResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

const parseMessage = (body: string): EmbeddingMessage | undefined => {
  const parsed = JSON.parse(body) as Partial<EmbeddingMessage>;

  return typeof parsed.tenantId === 'string' && typeof parsed.productId === 'string'
    ? {
        outboxId: typeof parsed.outboxId === 'number' ? parsed.outboxId : 0,
        tenantId: parsed.tenantId,
        productId: parsed.productId,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'unknown',
      }
    : undefined;
};

/**
 * How many times SQS has delivered this record, counting this one.
 *
 * A missing or unreadable count is a first delivery: that errs towards one more
 * retry of an unrecognised error, never towards giving up on a wine early.
 */
const deliveriesOf = (record: SqsRecord): number => {
  const count = Number(record.attributes?.ApproximateReceiveCount);
  return Number.isInteger(count) && count >= 1 ? count : 1;
};

/** The error name an operator needs: the provider's own, when the provider raised it. */
const errorName = (error: unknown): string => {
  const cause = originalError(error);
  return (cause as { name?: string } | undefined)?.name ?? 'UnknownError';
};

export interface HandlerOptions {
  readonly provider?: EmbeddingProvider | undefined;
  readonly database?: Database | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * The Lambda entry point.
 *
 * **Returns partial failures rather than throwing**, which is what
 * `reportBatchItemFailures` on the event source mapping (P1-32) reads. Throwing
 * would fail the whole batch: nine wines that embedded successfully would be
 * redelivered, re-embedded and paid for again because a tenth was malformed,
 * and after three rounds all ten would land in the DLQ.
 *
 * The records are processed **in sequence, not in parallel.** Each one opens a
 * transaction, and a batch of ten fanned out would hold ten connections from a
 * pool sized for the whole platform — the arithmetic in P1-32 budgets two per
 * invocation, not ten. The provider's own concurrency is inside `embed()`.
 */
export const handler = async (
  event: SqsEvent,
  _context?: unknown,
  options: HandlerOptions = {},
): Promise<BatchResponse> => {
  const provider = options.provider ?? titanEmbeddingProvider();
  const log =
    options.log ??
    ((line: string) => {
      console.info(line);
    });

  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const message = parseMessage(record.body);

      if (message === undefined) {
        /*
         * Unparseable, so there is no product to record a failure against and
         * no reason to expect a retry to do better. Reported as a failure
         * anyway — that is what sends it to the DLQ after three attempts,
         * which is where a message nobody can act on belongs. Dropping it
         * silently would be the alternative, and a queue that quietly discards
         * what it cannot read is a queue nobody can debug.
         */
        failures.push({ itemIdentifier: record.messageId });
        log(JSON.stringify({ event: 'embedding.unreadable_message', messageId: record.messageId }));
        continue;
      }

      const result = await embedProduct(
        message,
        { provider, database: options.database, log },
        deliveriesOf(record),
      );

      log(
        JSON.stringify({
          event: 'embedding.processed',
          outcome: result.outcome,
          productId: result.productId,
          ...(result.outcome === 'failed'
            ? { reason: result.reason, providerError: result.providerError }
            : {}),
          model: TITAN_PROVENANCE,
        }),
      );
    } catch (error) {
      failures.push({ itemIdentifier: record.messageId });
      log(
        JSON.stringify({
          event: 'embedding.failed',
          messageId: record.messageId,
          reason: errorName(error),
        }),
      );
    }
  }

  return { batchItemFailures: failures };
};
