import { eq, inArray } from 'drizzle-orm';

import type { ProductInsert } from './contracts.js';
import type { EmbeddingStatusWrite } from './embedding-status.js';
import { EMBEDDING_EVENT, type ProductRow } from './products.js';
import { outbox } from './schema/outbox.js';
import { products } from './schema/products.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * The one write path every bulk entry point shares (P1-24).
 *
 * §2.2a's premise is that a paste, a file and — one row at a time — the form all
 * land in the same function, so they cannot diverge in what they accept or what
 * they cost. This is that function for many rows: match on `(tenant_id, sku)`,
 * create what is new, update what changed, and queue an embedding only where the
 * text the model reads moved.
 *
 * **In `packages/db`, beside `insertProduct` and `updateProduct`, not in
 * `packages/core`** *(deviation)*. Its siblings take the domain rules from their
 * caller — `hashOf`, the embedding transition — and so does this. The API port
 * supplies them from `packages/core` (P1-25), which keeps the statements, the
 * lock and the outbox rows inside one transaction here, and the decisions about
 * what an edit costs where they are tested as decisions.
 *
 * **It takes the caller's transaction and never opens one.** Batching is the
 * caller's (P1-25): one transaction over ten thousand rows holds locks too long,
 * and one per row is needlessly slow.
 */

/**
 * The columns an import writes, which is every column of `productInsert`.
 *
 * Written out rather than read from the contract, so that a column added to the
 * table is a decision here and not a silent change to what an import touches —
 * and `products-upsert.test.ts` fails until the two lists agree.
 */
export const WRITTEN_FIELDS = [
  'sku',
  'externalVariantId',
  'name',
  'producer',
  'vintage',
  'wineType',
  'grapeVarieties',
  'region',
  'denomination',
  'styleTags',
  'tastingNotes',
  'foodPairings',
  'alcoholPct',
  'priceCents',
  'currency',
  'stockStatus',
  'stockQty',
  'productUrl',
  'imageUrl',
] as const satisfies readonly (keyof ProductInsert)[];

export interface UpsertRow {
  /** Where the row sits in the caller's import, echoed back on its outcome. */
  readonly index: number;
  /** Already validated against `productInsert`. */
  readonly values: ProductInsert;
}

export type UpsertOutcome =
  | { readonly index: number; readonly outcome: 'created'; readonly productId: string }
  | {
      readonly index: number;
      readonly outcome: 'updated' | 'unchanged';
      readonly productId: string;
      /** Whether this row queued an embedding. */
      readonly reindexed: boolean;
      /**
       * The SKU matched an archived wine. Its values are updated and it **stays
       * archived** — re-listing a wine is a separate, deliberate act (P1-04),
       * and an import that silently put one back in front of visitors would undo
       * the seller's decision without asking. Flagged so the summary can say so.
       */
      readonly archived: boolean;
    }
  | { readonly index: number; readonly outcome: 'duplicate-sku'; readonly sku: string };

export type UpsertDecision =
  | {
      readonly kind: 'create';
      readonly index: number;
      readonly values: ProductInsert;
      readonly contentHash: string;
    }
  | {
      readonly kind: 'update';
      readonly index: number;
      readonly current: ProductRow;
      /** The stored row with this import's fields laid over it. */
      readonly values: ProductInsert;
      readonly contentHash: string;
      /** A field a seller would see is different. */
      readonly changed: boolean;
      /** The embedding text moved, so a job is queued. */
      readonly reindexed: boolean;
    }
  | { readonly kind: 'duplicate'; readonly index: number; readonly sku: string };

const defined = (values: ProductInsert): Partial<ProductInsert> =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));

const writtenOf = (row: ProductRow): ProductInsert =>
  Object.fromEntries(WRITTEN_FIELDS.map((field) => [field, row[field]])) as ProductInsert;

const same = (left: unknown, right: unknown): boolean => {
  const a = left ?? null;
  const b = right ?? null;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }

  return a === b;
};

/**
 * What each row of an import will do, decided before anything is written.
 *
 * Pure, so the rules that decide what an import costs are tested without a
 * database. Four of them are worth stating:
 *
 * - **A field the row does not carry is left as it is.** An import never clears
 *   a column: a file without a *note di degustazione* column must not blank every
 *   tasting note in the catalogue. Clearing a field is done in the form.
 * - **"Unchanged" means no field a seller would see moved — not an equal hash.**
 *   The hash covers only what the model reads, so a price edit within its band
 *   leaves it equal while the price is different; counting that as unchanged
 *   would tell a seller an import of new prices changed nothing.
 * - **An equal hash is what decides re-embedding**, and nothing else does. A row
 *   whose text is the same but whose hash is stale — an embedding-text version
 *   bump — is unchanged to the seller and still re-queued.
 * - **Two rows with one SKU are both refused.** Applying them in order would
 *   make the last one win silently, and which row that is depends on a sort the
 *   seller cannot see.
 */
export const planUpsert = (
  rows: readonly UpsertRow[],
  existing: ReadonlyMap<string, ProductRow>,
  hashOf: (merged: ProductInsert) => string,
): UpsertDecision[] => {
  const occurrences = new Map<string, number>();
  for (const row of rows) {
    occurrences.set(row.values.sku, (occurrences.get(row.values.sku) ?? 0) + 1);
  }

  return rows.map((row): UpsertDecision => {
    const { sku } = row.values;

    if ((occurrences.get(sku) ?? 0) > 1) return { kind: 'duplicate', index: row.index, sku };

    const current = existing.get(sku);

    if (current === undefined) {
      return {
        kind: 'create',
        index: row.index,
        values: row.values,
        contentHash: hashOf(row.values),
      };
    }

    const stored = writtenOf(current);
    const values: ProductInsert = { ...stored, ...defined(row.values) };
    const contentHash = hashOf(values);

    return {
      kind: 'update',
      index: row.index,
      current,
      values,
      contentHash,
      changed: WRITTEN_FIELDS.some((field) => !same(values[field], stored[field])),
      reindexed: contentHash !== current.contentHash,
    };
  });
};

export interface UpsertRequest {
  readonly tenantId: string;
  readonly rows: readonly UpsertRow[];
  /** From `contentHashOf` in `packages/core`: which fields cost an embedding is a domain rule. */
  readonly hashOf: (merged: ProductInsert) => string;
  /** P1-38's `edited` edge, applied to each re-embedded row's current state. */
  readonly edited: (current: EmbeddingStatusWrite) => EmbeddingStatusWrite;
  /** Recorded on each outbox row, so a queue says where its jobs came from. */
  readonly reason: string;
}

/**
 * Applies an import's rows inside the caller's transaction.
 *
 * **The existing rows are locked first**, `FOR UPDATE`, so a form save or a
 * second import touching the same wines waits rather than merging onto a row
 * this one is about to overwrite. New rows go in one statement and their jobs
 * in another; changed rows are updated one at a time, which at P1-25's batch of
 * two hundred is two hundred short statements inside one transaction.
 *
 * A row this tenant cannot see is a row that does not exist here, and RLS is
 * what makes it so: the same SKU in another winery is created as a new wine in
 * this one, and the other winery's is never read.
 */
export const upsertProducts = async (
  tx: DbTransaction,
  request: UpsertRequest,
): Promise<UpsertOutcome[]> => {
  const skus = [...new Set(request.rows.map((row) => row.values.sku))];

  const found =
    skus.length === 0
      ? []
      : await tx.select().from(products).where(inArray(products.sku, skus)).for('update');

  const decisions = planUpsert(
    request.rows,
    new Map(found.map((row) => [row.sku, row])),
    request.hashOf,
  );

  const creates = decisions.flatMap((decision) => (decision.kind === 'create' ? [decision] : []));

  const created =
    creates.length === 0
      ? []
      : await tx
          .insert(products)
          .values(
            creates.map((decision) => ({
              ...decision.values,
              tenantId: request.tenantId,
              contentHash: decision.contentHash,
              embeddingState: 'PENDING' as const,
            })),
          )
          .returning({ id: products.id, sku: products.sku });

  const createdIds = new Map(created.map((row) => [row.sku, row.id]));
  const jobs = created.map((row) => row.id);

  for (const decision of decisions) {
    if (decision.kind !== 'update' || (!decision.changed && !decision.reindexed)) continue;

    const status = decision.reindexed
      ? request.edited({
          state: decision.current.embeddingState,
          error: decision.current.embeddingError,
          attempts: decision.current.embeddingAttempts,
        })
      : undefined;

    await tx
      .update(products)
      .set({
        ...decision.values,
        contentHash: decision.contentHash,
        ...(status === undefined
          ? {}
          : {
              embeddingState: status.state,
              embeddingError: status.error,
              embeddingAttempts: status.attempts,
            }),
      })
      .where(eq(products.id, decision.current.id));

    if (decision.reindexed) jobs.push(decision.current.id);
  }

  if (jobs.length > 0) {
    await tx.insert(outbox).values(
      jobs.map((productId) => ({
        tenantId: request.tenantId,
        aggregateId: productId,
        eventType: EMBEDDING_EVENT,
        payload: { reason: request.reason },
      })),
    );
  }

  return decisions.map((decision): UpsertOutcome => {
    if (decision.kind === 'duplicate') {
      return { index: decision.index, outcome: 'duplicate-sku', sku: decision.sku };
    }

    if (decision.kind === 'create') {
      const productId = createdIds.get(decision.values.sku);
      if (productId === undefined) {
        // Unreachable: every create was inserted in the statement above.
        throw new Error('upsertProducts: a created row came back without an id');
      }
      return { index: decision.index, outcome: 'created', productId };
    }

    return {
      index: decision.index,
      outcome: decision.changed ? 'updated' : 'unchanged',
      productId: decision.current.id,
      reindexed: decision.reindexed,
      archived: decision.current.status === 'ARCHIVED',
    };
  });
};
