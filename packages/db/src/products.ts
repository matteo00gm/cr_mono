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

/** unique_violation — a `(tenant_id, sku)` that already exists. */
const UNIQUE_VIOLATION = '23505';

/**
 * The SQLSTATE, wherever the driver left it.
 *
 * **Both levels, and CI is what established that.** `db.execute` with a raw
 * statement wraps the driver error in a Drizzle one, so the code sits on
 * `cause`; the query builder lets postgres-js's own `PostgresError` through
 * untouched, with the code on the error itself. The first version of this
 * function read only `cause` — and the unit test fabricated a wrapped error, so
 * the fake and the code agreed with each other and not with Postgres. A
 * duplicate SKU escaped as a 500 while every unit test stayed green.
 *
 * That is the same shape as A1's timestamp bug, from the same cause: a fixture
 * written from the implementation's assumption rather than from the driver's
 * behaviour. `products.write.test.ts` now builds both forms and names which
 * call site produces each.
 *
 * The message is never matched on. `Failed query: …` is Drizzle's phrasing,
 * which is neither ours nor stable.
 */
const pgErrorCode = (error: unknown): string | undefined => {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const direct = candidate?.code;
  const wrapped = candidate?.cause?.code;

  return typeof direct === 'string' ? direct : typeof wrapped === 'string' ? wrapped : undefined;
};

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
  let created: ProductRow | undefined;

  try {
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
      .returning();

    created = rows[0];
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) return { outcome: 'duplicate-sku' };
    throw error;
  }

  if (created === undefined) {
    /*
     * Unreachable: `RETURNING` on a single-row insert that did not throw yields
     * exactly one row. Kept because the alternative to a throw is enqueueing a
     * job for `undefined.id`, and this package would rather fail than write a
     * job pointing at nothing.
     */
    throw new Error('insertProduct: the insert returned no row, which cannot happen');
  }

  await enqueueEmbedding(tx, {
    tenantId: product.tenantId,
    productId: created.id,
    reason: 'created',
  });

  return { outcome: 'created', product: created };
};
