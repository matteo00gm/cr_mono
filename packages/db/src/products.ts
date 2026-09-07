import { outbox } from './schema/outbox.js';
import { products } from './schema/products.js';
import type { ProductInsert } from './contracts.js';
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
