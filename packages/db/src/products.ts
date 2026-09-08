import { and, eq, sql } from 'drizzle-orm';

import { outbox } from './schema/outbox.js';
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
