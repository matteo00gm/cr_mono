import { and, eq, isNull, sql } from 'drizzle-orm';

import {
  writeEmbeddingStatus,
  type EmbeddingState,
  type EmbeddingStatusWrite,
} from './embedding-status.js';
import { outbox } from './schema/outbox.js';
import { productEmbeddings } from './schema/product-embeddings.js';
import { products } from './schema/products.js';
import type { ProductInsert, ProductUpdate } from './contracts.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * The catalogue write statements (P1-02).
 *
 * Here rather than in an app for the reason the header of `index.ts` gives:
 * statements live in this package so no app imports a driver. Which capability
 * a caller needs, and what a refusal means over HTTP, stay where those
 * decisions belong.
 *
 * Every function takes the caller's transaction. That is not a preference here:
 * the §4.1 guarantee is that a product and its embedding job commit together,
 * and a function that opened its own connection could not offer it.
 */

/** unique_violation — a `(tenant_id, sku)` that already exists. */
const UNIQUE_VIOLATION = '23505';

/**
 * The SQLSTATE, wherever the driver left it.
 *
 * Both levels, because the two call sites differ: `db.execute` with a raw
 * statement wraps the driver error in a Drizzle one and the code sits on
 * `cause`, while the query builder lets postgres-js's own `PostgresError`
 * through with the code on the error itself. The message is never matched on —
 * `Failed query: …` is Drizzle's phrasing, which is neither ours nor stable.
 */
const pgErrorCode = (error: unknown): string | undefined => {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const direct = candidate?.code;
  const wrapped = candidate?.cause?.code;

  return typeof direct === 'string' ? direct : typeof wrapped === 'string' ? wrapped : undefined;
};

/**
 * **A constraint violation cannot be caught and walked away from inside a
 * transaction, and CI is what established that.**
 *
 * The first version of `insertProduct` wrapped its insert in `try`/`catch`,
 * read the SQLSTATE and returned an outcome — and the outcome never arrived.
 * postgres-js marks a transaction failed the moment any statement errors, rolls
 * it back, and rejects the *outer* `transaction()` promise with the original
 * error, whatever the callback did with it. Postgres agrees: after an error the
 * session refuses every further statement until the transaction ends, so there
 * is nothing to continue into even if the driver allowed it.
 *
 * The way out is to **never raise**. `ON CONFLICT (tenant_id, sku) DO NOTHING
 * ... RETURNING` makes the conflict a *result* — an empty row set — rather than
 * an error: no exception, no poisoned transaction, one round trip, and no race
 * between checking and inserting. The conflict target is named, so a violation
 * of any other constraint still raises and is still ours to fix.
 *
 * `updateProduct` cannot do that — `UPDATE` has no `DO NOTHING` that could be
 * told apart from "matched nothing" — so it takes the other route: a
 * **savepoint**, which rolls back the failed statement without ending the
 * transaction, and only then is there something a `catch` can act on.
 */

export type ProductRow = typeof products.$inferSelect;

/**
 * A duplicate SKU is an outcome, not an exception.
 *
 * The same reasoning as `MemberWriteOutcome` (P0-52): what a refusal means to a
 * caller is HTTP-shaped, and this package has no HTTP. A thrown error would
 * also have to be caught and re-classified by every caller, which is where one
 * of them eventually gets it wrong and returns a 500 for a form mistake.
 */
export type ProductWriteOutcome =
  | { readonly outcome: 'created'; readonly product: ProductRow }
  | { readonly outcome: 'duplicate-sku' };

/** What the embedding worker is being asked to do, and why. */
export const EMBEDDING_EVENT = 'product.embed';

/**
 * Enqueues an embedding job for a product.
 *
 * **Never called on its own from a route.** It exists as a separate function
 * because P1-03 needs to call it conditionally — an update that changed nothing
 * the model sees must not enqueue one — and P1-39 needs it for a manual
 * reindex. The create path below always pairs it with the insert, in the same
 * statement batch and the same transaction.
 */
export const enqueueEmbedding = async (
  tx: DbTransaction,
  job: { readonly tenantId: string; readonly productId: string; readonly reason: string },
): Promise<void> => {
  await tx.insert(outbox).values({
    tenantId: job.tenantId,
    aggregateId: job.productId,
    eventType: EMBEDDING_EVENT,
    payload: { reason: job.reason },
  });
};

export interface NewProduct {
  readonly tenantId: string;
  /** Already validated against `productInsert`, which omits `tenant_id`. */
  readonly values: ProductInsert;
  /** From `contentHashOf` in `packages/core` — this package has no domain. */
  readonly contentHash: string;
}

/**
 * Inserts a product **and** its embedding job, or neither.
 *
 * **The pairing is the function, and that is why it is not two exported calls
 * for a route to make in order.** §4.1's guarantee is that a committed product
 * always has a queued embedding job: a product without one is invisible to
 * search, and the seller sees a catalogue that silently lacks it — no error, no
 * failed job, nothing to retry. Leaving the two calls to the caller makes that
 * a convention every future route has to remember, and P0-54 is this
 * repository's evidence for how long conventions like that survive.
 *
 * `tenant_id` is written from the argument, which comes from a `memberships`
 * row (P0-48) — never from `values`, which cannot carry it because
 * `productInsert` omits the column at the type level.
 */
export const insertProduct = async (
  tx: DbTransaction,
  product: NewProduct,
): Promise<ProductWriteOutcome> => {
  const rows = await tx
    .insert(products)
    .values({
      ...product.values,
      tenantId: product.tenantId,
      contentHash: product.contentHash,
      /*
       * Explicit rather than left to the column default. The default is
       * `PENDING` and this says the same thing — but a row inserted here is
       * pending *because* the outbox row below exists, and stating it keeps
       * the two visibly paired at the call site rather than in two schema
       * files.
       */
      embeddingState: 'PENDING',
    })
    /*
     * The conflict is a *result*, not an error — see the note at the top of the
     * file. The target is named rather than bare, so a violation of any other
     * constraint still raises: `DO NOTHING` with no target would swallow the
     * next unique index somebody adds and report a silent success.
     */
    .onConflictDoNothing({ target: [products.tenantId, products.sku] })
    .returning();

  const created = rows[0];

  if (created === undefined) return { outcome: 'duplicate-sku' };

  await enqueueEmbedding(tx, {
    tenantId: product.tenantId,
    productId: created.id,
    reason: 'created',
  });

  return { outcome: 'created', product: created };
};

/**
 * A patch that changed nothing the model sees is not a failure and not a
 * re-index — it is the ordinary case, and the outcome says so.
 *
 * `reindexed` is reported rather than inferred by the caller, because the
 * caller cannot infer it: the decision needs the *stored* hash, which only this
 * function has read.
 */
export type ProductUpdateOutcome =
  | { readonly outcome: 'updated'; readonly product: ProductRow; readonly reindexed: boolean }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'duplicate-sku' };

export interface ProductPatch {
  readonly productId: string;
  /** Partial by construction: `productUpdate` is `productInsert.partial()`. */
  readonly values: ProductUpdate;
  /**
   * The domain rule, injected.
   *
   * **A function rather than a value, and the shape is forced by the problem.**
   * A patch is partial, so the hash has to be taken over the *merged* row — and
   * the caller cannot merge, because it has not read the row. Passing the rule
   * in keeps the field set in `packages/core` (where it is tested as a domain
   * decision) while the read, the comparison and the enqueue stay inside one
   * transaction here, where they cannot come apart.
   */
  readonly hashOf: (merged: ProductRow) => string;
}

/**
 * Drops keys the caller did not send.
 *
 * `productUpdate` is `.partial()`, so an absent field arrives as `undefined` —
 * and spreading that over the stored row would blank every column the patch did
 * not mention. The bug would be silent for the *hash* long before it was
 * visible in the data: a merged row full of `undefined` hashes to something
 * that looks like a change, so every patch would re-embed.
 */
const defined = (values: ProductUpdate): Partial<ProductRow> =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));

/**
 * Applies a patch, and enqueues re-embedding **only when the content changed**.
 *
 * **This is where the cost control actually lives.** A seller correcting stock
 * or fixing a price edits rows constantly; embedding every one of those is a
 * bill that tracks how often people use the product rather than what is in it.
 * The comparison is against the stored hash, so it survives a round trip that
 * happens to produce identical text.
 *
 * `FOR UPDATE` locks the row for the rest of the transaction, and that is not
 * ceremony: two concurrent patches would otherwise both read the same base row,
 * both merge onto it, and the second would overwrite fields the first had just
 * set — with a hash computed from a row that never existed.
 *
 * A row this tenant cannot see is `not-found` rather than an error, and it
 * arrives that way for free: RLS scopes the read, so another winery's id
 * matches nothing. §3.5's "a cross-tenant id returns 404" is therefore a
 * property of the policy rather than a branch somebody has to remember — which
 * matters, because the natural hand-written version returns 403.
 */
export const updateProduct = async (
  tx: DbTransaction,
  patch: ProductPatch,
): Promise<ProductUpdateOutcome> => {
  const existing = await tx
    .select()
    .from(products)
    .where(eq(products.id, patch.productId))
    .for('update')
    .limit(1);

  const row = existing[0];
  if (row === undefined) return { outcome: 'not-found' };

  const merged: ProductRow = { ...row, ...defined(patch.values) };
  const nextHash = patch.hashOf(merged);
  const reindexed = nextHash !== row.contentHash;

  let updated: ProductRow | undefined;

  try {
    /*
     * **A savepoint, and it is what makes the `catch` below mean anything.**
     * `insertProduct` avoids the problem entirely with `ON CONFLICT DO
     * NOTHING`; `UPDATE` has no equivalent, because a `DO NOTHING` there could
     * not be told apart from "matched nothing" and would report a silent
     * success for a SKU that was never changed.
     *
     * So the statement runs inside a nested transaction, which Drizzle issues
     * as `SAVEPOINT`. A constraint violation then rolls back to the savepoint
     * rather than poisoning the whole transaction — which is the difference
     * between catching an error and merely watching it go past: without this,
     * postgres-js rejects the outer `transaction()` promise with the original
     * error whatever this `catch` returns, and the caller sees a 500 for a form
     * mistake.
     */
    updated = await tx.transaction(async (inner) => {
      const rows = await inner
        .update(products)
        .set({
          ...defined(patch.values),
          contentHash: nextHash,
          /*
           * `STALE`, not `PENDING`. The distinction is what P1-40's grid shows
           * a seller: `PENDING` means this wine has never been indexed and
           * cannot be recommended yet, while `STALE` means it is findable under
           * its previous description. Collapsing them would tell somebody their
           * catalogue had gone dark during an ordinary edit.
           */
          ...(reindexed ? { embeddingState: 'STALE' as const } : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(products.id, patch.productId)))
        .returning();

      return rows[0];
    });
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) return { outcome: 'duplicate-sku' };
    throw error;
  }

  if (updated === undefined) {
    // Unreachable: the row was locked above, so it cannot have gone.
    throw new Error('updateProduct: the update returned no row, which cannot happen');
  }

  if (reindexed) {
    await enqueueEmbedding(tx, {
      tenantId: updated.tenantId,
      productId: updated.id,
      reason: 'updated',
    });
  }

  return { outcome: 'updated', product: updated, reindexed };
};

export type ProductArchiveOutcome =
  | { readonly outcome: 'archived'; readonly product: ProductRow; readonly vectorsRemoved: number }
  | { readonly outcome: 'not-found' };

/**
 * Archives a product and **deletes its vectors**, in one transaction (P1-04).
 *
 * **The two halves are different kinds of delete on purpose.** The row is soft-
 * deleted — `status = 'ARCHIVED'` — because an order placed last month refers to
 * it, and a catalogue that forgets what it sold cannot answer a customer's
 * question about their own purchase. The vectors are hard-deleted, because a
 * vector is not history: it is the thing retrieval searches, and leaving it
 * means the wine keeps being recommended after the seller removed it. That is a
 * visible, embarrassing bug rather than a data-integrity one.
 *
 * **`ON DELETE CASCADE` does not help here and the explicit delete is
 * required.** The cascade on `product_embeddings.product_id` fires when the
 * *product row* goes, and this path deliberately keeps it. A reader who knows
 * the cascade exists is exactly the reader who would assume this is handled.
 *
 * Archiving twice is not an error. The seller's intent — stop recommending this
 * — is already satisfied, and answering 409 to a repeated click would make a
 * dashboard explain a conflict that is not one. The vector delete is idempotent
 * for the same reason: the second call removes nothing and says so.
 */
export const archiveProduct = async (
  tx: DbTransaction,
  productId: string,
): Promise<ProductArchiveOutcome> => {
  const updated = await tx
    .update(products)
    .set({ status: 'ARCHIVED', updatedAt: sql`now()` })
    .where(eq(products.id, productId))
    .returning();

  const product = updated[0];
  /*
   * A row this tenant cannot see matches nothing under the policy, so an id
   * from another winery arrives here as `not-found` — §3.5's 404 without a
   * tenant comparison anybody could get wrong.
   */
  if (product === undefined) return { outcome: 'not-found' };

  const removed = await tx
    .delete(productEmbeddings)
    .where(eq(productEmbeddings.productId, productId))
    .returning({ id: productEmbeddings.id });

  return { outcome: 'archived', product, vectorsRemoved: removed.length };
};

/* -------------------------------------------------------------------------- *
 *                                  Reindex                                    *
 * -------------------------------------------------------------------------- */

/**
 * What a reindex found (P1-39).
 *
 * `archived` is its own answer rather than a silent success. The worker skips
 * an archived wine deliberately — re-embedding one would put it back in front
 * of visitors, which is what archiving means to stop — so accepting the request
 * and queueing a job that will be discarded would tell a seller their wine was
 * being reindexed when nothing of the kind was going to happen.
 */
export type ProductReindexOutcome =
  | { readonly outcome: 'queued'; readonly product: ProductRow }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'archived'; readonly product: ProductRow };

export interface ReindexRequest {
  readonly productId: string;
  /**
   * The `queued` edge from `packages/core`'s state machine, applied to the row
   * this statement read.
   *
   * A callback for the same reason `updateProduct` takes `hashOf`: the current
   * state is only known inside the transaction, and the decision about what it
   * becomes is a domain one. `packages/db` writing its own `SET embedding_state
   * = 'PENDING'` is precisely the scattered statement P1-38 exists to prevent.
   */
  readonly nextStatus: (current: EmbeddingStatusWrite) => EmbeddingStatusWrite;
  /** Recorded on the outbox row, so a queue full of jobs says where it came from. */
  readonly reason: string;
}

/**
 * Re-queues one wine for embedding (P1-39).
 *
 * **It does not clear a hash, which is a departure from the row, and the
 * departure is the cost control.** P1-39 says both reindex paths "clear
 * `content_hash` (forcing recompute)". Two things have changed since that was
 * written. The hash the worker compares against is the one stored *beside the
 * vector* (P1-37), not `products.content_hash` — so clearing the product's
 * would force nothing. And `shouldEmbed`'s own docstring names "a manual
 * reindex of an unchanged product" as one of the things it exists to stop
 * costing money.
 *
 * So a reindex of a wine whose vector is already current calls no provider and
 * costs nothing, by design. What it *does* fix is every way the row and the
 * vector can disagree: a `FAILED` wine gets another attempt, a wine whose
 * outbox row was lost gets a new one, and a wine that is `PENDING` with a
 * perfectly good vector is corrected to `INDEXED` by the worker's own
 * reconciliation. Those are the reasons a seller reaches for this button.
 *
 * The one case that genuinely needs a recompute — the embedding text or the
 * model changing — already forces one without help: `EMBEDDING_TEXT_VERSION` is
 * part of the hash, so every product's hash moves at once.
 */
export const reindexProduct = async (
  tx: DbTransaction,
  request: ReindexRequest,
): Promise<ProductReindexOutcome> => {
  const rows = await tx
    .select()
    .from(products)
    .where(eq(products.id, request.productId))
    /*
     * Held for the same reason `updateProduct` holds it: the state read here
     * decides the state written below, and a concurrent edit between the two
     * would make this overwrite a transition it never saw.
     */
    .for('update')
    .limit(1);

  const row = rows[0];

  /*
   * A row this tenant cannot see matches nothing under the policy, so an id
   * from another winery arrives here as `not-found` — §3.5's 404, reached
   * without a tenant comparison anybody could get wrong.
   */
  if (row === undefined) return { outcome: 'not-found' };
  if (row.status === 'ARCHIVED') return { outcome: 'archived', product: row };

  const next = request.nextStatus({
    state: row.embeddingState,
    error: row.embeddingError,
    attempts: row.embeddingAttempts,
  });

  await writeEmbeddingStatus(tx, row.id, next);
  await enqueueEmbedding(tx, {
    tenantId: row.tenantId,
    productId: row.id,
    reason: request.reason,
  });

  return {
    outcome: 'queued',
    product: {
      ...row,
      embeddingState: next.state,
      embeddingError: next.error,
      embeddingAttempts: next.attempts,
    },
  };
};

/**
 * How many embedding jobs this tenant still has waiting (P1-39).
 *
 * Scoped by the policy rather than by a predicate, like every other read here.
 * Counts only the unpublished ones: the outbox keeps published rows as the
 * history, so `processed_at IS NULL` is the queue.
 */
export const countQueuedEmbeddings = async (tx: DbTransaction): Promise<number> => {
  const rows = await tx
    .select({ queued: sql<number>`count(*)::int` })
    .from(outbox)
    .where(and(isNull(outbox.processedAt), eq(outbox.eventType, EMBEDDING_EVENT)));

  return rows[0]?.queued ?? 0;
};

export type CatalogueReindexOutcome =
  | { readonly outcome: 'queued'; readonly batchId: string; readonly queued: number }
  | { readonly outcome: 'in-flight'; readonly queued: number };

export interface CatalogueReindexRequest {
  /**
   * The `queued` edge as a lookup, one entry per state, supplied by the caller
   * from `packages/core`.
   *
   * **A table rather than a callback, because this transition is applied to
   * every row in one statement.** Reading the catalogue into the application to
   * run a function over it would be the same decision expressed as N round
   * trips, and at a few thousand wines that is the difference between a request
   * and a timeout. Handing the edges down as data keeps `packages/core` the
   * author of them; the test asserts this map and `nextEmbeddingStatus` agree,
   * which is what catches a future edit to one that forgets the other.
   */
  readonly edges: Readonly<Record<EmbeddingState, EmbeddingState>>;
  readonly batchId: string;
  readonly reason: string;
}

/**
 * Re-queues the whole active catalogue (P1-39).
 *
 * **One statement, not batches, which the row asks for.** Batching exists to
 * bound the memory of application code that materialises rows; this
 * materialises none — the `UPDATE` feeds the `INSERT` through a CTE and the
 * only thing crossing the wire is a count. At this product's ceiling (ten
 * tenants, a few thousand wines each) it is a single short transaction, and a
 * catalogue large enough to make it a long one would want chunking by product
 * id rather than by round trip, which is a different design and belongs with
 * the scale test that would show it was needed (P7-05).
 *
 * **A second run while the first is still draining is refused**, which is the
 * row's "a second concurrent reindex-all is rejected" — reached through the
 * condition that actually matters rather than a clock. Two batches in the queue
 * do not index anything twice; they double the work the poller and the worker
 * must get through before either finishes, and the seller waits longer for the
 * answer they were already waiting for. The refusal carries the number still
 * queued, so the dashboard can say how much is left rather than just "no".
 *
 * Note what is *not* guarded: running this again once the queue has drained. It
 * is close to free, because the worker calls no provider for a wine whose
 * vector is current (see `reindexProduct`) — so the expensive thing the row
 * wanted rate-limited is not expensive in this design. A general per-tenant
 * budget across every write endpoint is P2-04's, and belongs there rather than
 * special-cased here.
 */
export const reindexCatalogue = async (
  tx: DbTransaction,
  request: CatalogueReindexRequest,
): Promise<CatalogueReindexOutcome> => {
  const inFlight = await countQueuedEmbeddings(tx);
  if (inFlight > 0) return { outcome: 'in-flight', queued: inFlight };

  /*
   * The transition table, rendered as a `CASE` over the current value. The cast
   * is required because a `CASE` of string literals is `text` and the column is
   * an enum; without it Postgres refuses the assignment rather than coercing,
   * which is the failure one would want.
   */
  const transition = sql.join(
    [
      sql`CASE ${products.embeddingState}`,
      ...Object.entries(request.edges).map(
        ([from, to]) => sql`WHEN ${from} THEN ${to}::product_embedding_state`,
      ),
      sql`END`,
    ],
    sql` `,
  );

  /*
   * `embedding_attempts` is deliberately untouched: a wine that needed four
   * tries is worth knowing about after it succeeds, and a reindex is not new
   * information about that. `updated_at` does not move either — migration 0038
   * gave `products` a trigger that ignores exactly these columns, so a bulk
   * reindex no longer sends every wine to the top of "recently edited", a sort
   * the seller reads as a record of their own work.
   */
  const payload = JSON.stringify({ reason: request.reason, batchId: request.batchId });

  const rows = await tx.execute(sql`
    WITH touched AS (
      UPDATE ${products}
         SET embedding_state = ${transition},
             embedding_error = NULL
       WHERE ${products.status} = 'ACTIVE'
      RETURNING ${products.id} AS id, ${products.tenantId} AS tenant_id
    )
    INSERT INTO ${outbox} (tenant_id, aggregate_id, event_type, payload)
    SELECT touched.tenant_id, touched.id, ${EMBEDDING_EVENT}, ${payload}::jsonb
      FROM touched
    RETURNING 1
  `);

  return { outcome: 'queued', batchId: request.batchId, queued: [...rows].length };
};
