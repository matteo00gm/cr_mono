import type { Product } from '@catalogorosso/api-client';
import {
  completenessOf,
  contentHashOf,
  EMBEDDING_STATES,
  nextEmbeddingStatus,
  type EmbeddingState,
} from '@catalogorosso/core';
import {
  archiveProduct,
  insertProduct,
  listProducts,
  reindexCatalogue,
  reindexProduct,
  updateProduct,
  upsertProducts,
  withTenant,
  type CatalogueReindexOutcome,
  type ListQuery,
  type ProductArchiveOutcome,
  type ProductInsert,
  type ProductPage,
  type ProductReindexOutcome,
  type ProductRow,
  type ProductUpdate,
  type ProductUpdateOutcome,
  type ProductWriteOutcome,
  type UpsertOutcome,
} from '@catalogorosso/db';

/**
 * The catalogue port and its database-backed implementation (P1-02).
 *
 * The composition root's job, for the reason `members.ts` is: this is the one
 * place that knows both what a product's embedding depends on
 * (`packages/core`) and where a product is stored (`packages/db`). Neither
 * package should learn about the other.
 */

/**
 * A stored row, projected onto the shape the API publishes (P1-02).
 *
 * **Returning the row verbatim was a leak, and a test caught it rather than a
 * reviewer.** `content_hash` is an internal cost control: a client that can see
 * it will eventually branch on it, and then changing how it is computed becomes
 * a breaking API change instead of a re-index. `tenant_id` is not secret — the
 * caller knows which winery they are in — but publishing a field the contract
 * does not declare invites a client to depend on it, which is the same problem
 * one step later.
 *
 * The projection is explicit rather than a delete-list, so a column added to
 * the table in future is absent from responses until somebody decides it should
 * be there. `products.test.ts` asserts the body carries these keys and no
 * others, which is what makes that hold for the next column rather than this
 * one.
 *
 * Timestamps become ISO strings here rather than being left to `c.json`.
 * `JSON.stringify` would produce the same text, and doing it explicitly is what
 * makes the function's return type the published one — so a column whose type
 * changes fails to compile here instead of changing the API quietly.
 */
export const toProductResponse = (row: ProductRow): Product => ({
  id: row.id,
  sku: row.sku,
  externalVariantId: row.externalVariantId,
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
  currency: row.currency,
  stockStatus: row.stockStatus,
  stockQty: row.stockQty,
  productUrl: row.productUrl,
  imageUrl: row.imageUrl,
  status: row.status,
  embeddingState: row.embeddingState,
  /*
   * Computed here rather than stored, and sent rather than left to the client.
   * The catalogue filters by completeness band in SQL (P1-09), so a client
   * recomputing it could disagree with what was filtered — a wine listed under
   * "Da completare" with a "Buono" badge beside it. One number, computed once.
   */
  completeness: completenessOf(row).score,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export interface CreateProductCommand {
  readonly tenantId: string;
  /** Already validated against `productInsert`, which omits `tenant_id`. */
  readonly values: ProductInsert;
}

export interface UpdateProductCommand {
  readonly tenantId: string;
  readonly productId: string;
  /** Partial: `productUpdate` is `productInsert.partial()`. */
  readonly values: ProductUpdate;
}

export interface ArchiveProductCommand {
  readonly tenantId: string;
  readonly productId: string;
}

export interface ListProductsCommand extends ListQuery {
  readonly tenantId: string;
}

export interface ReindexProductCommand {
  readonly tenantId: string;
  readonly productId: string;
}

export interface ReindexCatalogueCommand {
  readonly tenantId: string;
  /**
   * Identifies this run on every outbox row it writes.
   *
   * Passed in rather than generated below, because the composition root is
   * where a non-deterministic value belongs: a test that asserts what landed on
   * the rows can supply its own instead of reaching for a mock of `randomUUID`.
   */
  readonly batchId: string;
}

/**
 * Rows per transaction in a bulk import (P1-25).
 *
 * **One transaction over ten thousand rows holds its locks for the whole
 * import**, so a seller saving a price in the form waits for somebody else's
 * spreadsheet — and a timeout near the end rolls back everything before it.
 * One transaction per row is the opposite failure: ten thousand commits for an
 * import that could be fifty. Two hundred keeps each transaction short and lets
 * a failure say exactly which stretch of the file did not apply.
 */
export const IMPORT_BATCH_SIZE = 200;

export interface ImportProductsCommand {
  readonly tenantId: string;
  /** Already validated against `productInsert`, in the order the seller's file had them. */
  readonly rows: readonly ProductInsert[];
}

/** Where an import stopped, by batch and by row index, and why — for the log, not the caller. */
export interface ImportStop {
  readonly batch: number;
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly cause: unknown;
}

export interface ImportProductsResult {
  /** One per row that was applied or refused, in row order. Rows after a stop have none. */
  readonly outcomes: readonly UpsertOutcome[];
  readonly stoppedAt: ImportStop | null;
}

export interface ImportCounts {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly duplicateSku: number;
  /** Matched an archived wine: updated or unchanged, and still archived. */
  readonly archived: number;
}

/** The summary P1-23's screen shows: *nuovi, aggiornati, invariati*. */
export const countImportOutcomes = (outcomes: readonly UpsertOutcome[]): ImportCounts => ({
  created: outcomes.filter((outcome) => outcome.outcome === 'created').length,
  updated: outcomes.filter((outcome) => outcome.outcome === 'updated').length,
  unchanged: outcomes.filter((outcome) => outcome.outcome === 'unchanged').length,
  duplicateSku: outcomes.filter((outcome) => outcome.outcome === 'duplicate-sku').length,
  archived: outcomes.filter((outcome) => 'archived' in outcome && outcome.archived).length,
});

export interface ProductsPort {
  create(command: CreateProductCommand): Promise<ProductWriteOutcome>;
  update(command: UpdateProductCommand): Promise<ProductUpdateOutcome>;
  archive(command: ArchiveProductCommand): Promise<ProductArchiveOutcome>;
  list(command: ListProductsCommand): Promise<ProductPage>;
  reindex(command: ReindexProductCommand): Promise<ProductReindexOutcome>;
  reindexAll(command: ReindexCatalogueCommand): Promise<CatalogueReindexOutcome>;
  importRows(command: ImportProductsCommand): Promise<ImportProductsResult>;
}

/**
 * The `queued` edge, flattened to a lookup for the bulk statement (P1-39).
 *
 * **Derived by asking the state machine, never written out here.** A second
 * copy of the transition table is exactly the thing P1-38 exists to prevent —
 * and a copy that is *nearly* right is worse than an obvious one, because it
 * disagrees only for the state nobody tested. Building it from
 * `nextEmbeddingStatus` means the two cannot drift; `products-reindex.test.ts`
 * asserts it anyway, because a future edit could add a state and this would
 * keep compiling.
 *
 * The error and attempt count are placeholders: `queued` is not a `failed`
 * event, so the function reads neither.
 */
export const queuedEdges: Readonly<Record<EmbeddingState, EmbeddingState>> = Object.fromEntries(
  EMBEDDING_STATES.map((state) => [
    state,
    nextEmbeddingStatus({ status: { state, error: null, attempts: 0 }, event: 'queued' }).state,
  ]),
) as Record<EmbeddingState, EmbeddingState>;

/**
 * The port with nothing behind it.
 *
 * Throws rather than answering plausibly, the same shape as
 * `unconfiguredMembers`: a create endpoint wired to nothing must fail loudly
 * and completely, never return a 200 for a product that was not stored.
 */
export class ProductsPortNotConfiguredError extends Error {
  constructor() {
    super(
      'No products port was supplied to createApp, so the catalogue cannot be written. ' +
        'This is a wiring bug at the composition root, not a request problem.',
    );
    this.name = 'ProductsPortNotConfiguredError';
  }
}

export const unconfiguredProducts: ProductsPort = {
  create: () => Promise.reject(new ProductsPortNotConfiguredError()),
  update: () => Promise.reject(new ProductsPortNotConfiguredError()),
  archive: () => Promise.reject(new ProductsPortNotConfiguredError()),
  list: () => Promise.reject(new ProductsPortNotConfiguredError()),
  reindex: () => Promise.reject(new ProductsPortNotConfiguredError()),
  reindexAll: () => Promise.reject(new ProductsPortNotConfiguredError()),
  importRows: () => Promise.reject(new ProductsPortNotConfiguredError()),
};

/* -------------------------------------------------------------------------- */

export const createProductsPort = (): ProductsPort => ({
  create: (command) =>
    /*
     * One transaction for the whole write, which is what `insertProduct`
     * requires to keep its promise: the product row and the outbox row commit
     * together or not at all (§4.1). Nothing here runs after the commit, unlike
     * the invite path, because there is no message to send — so the ordering
     * question that shapes `members.ts` does not arise.
     */
    withTenant(command.tenantId, (tx) =>
      insertProduct(tx, {
        tenantId: command.tenantId,
        values: command.values,

        /*
         * Computed here rather than in `packages/db`, and that placement is the
         * point of this file. Which fields a hash covers is a *domain* decision
         * — it decides what an edit costs — and `packages/db` has no domain.
         * Computing it in SQL would be worse still: the rule would live in a
         * statement nobody can unit-test and a migration would silently
         * re-embed the catalogue.
         */
        contentHash: contentHashOf(command.values),
      }),
    ),

  update: (command) =>
    withTenant(command.tenantId, (tx) =>
      updateProduct(tx, {
        productId: command.productId,
        values: command.values,

        /*
         * The rule travels as a function because a patch is partial: the hash
         * has to be taken over the *merged* row, and only the statement has
         * read it. This keeps the field set in `packages/core`, where it is
         * tested as the domain decision it is, while the read, the comparison
         * and the enqueue stay inside one transaction where they cannot come
         * apart.
         */
        hashOf: (merged) => contentHashOf(merged),
      }),
    ),

  archive: (command) => withTenant(command.tenantId, (tx) => archiveProduct(tx, command.productId)),

  /*
   * The tenant is peeled off and everything else is the query. Splitting it
   * this way means the port cannot accidentally pass a tenant *into* the query
   * builder, where it would be a second, unscoped filter competing with the RLS
   * policy that is already doing the work.
   */
  list: ({ tenantId, ...query }) => withTenant(tenantId, (tx) => listProducts(tx, query)),

  reindex: (command) =>
    withTenant(command.tenantId, (tx) =>
      reindexProduct(tx, {
        productId: command.productId,

        /*
         * The transition travels as a function for the reason `hashOf` does:
         * only the statement has read the current state, and what that state
         * becomes is a domain decision. `packages/db` writing its own
         * `SET embedding_state` is the scattered edge P1-38 exists to stop.
         */
        nextStatus: (current) => nextEmbeddingStatus({ status: current, event: 'queued' }),
        reason: 'manual-reindex',
      }),
    ),

  reindexAll: (command) =>
    withTenant(command.tenantId, (tx) =>
      reindexCatalogue(tx, {
        edges: queuedEdges,
        batchId: command.batchId,
        reason: 'manual-reindex-all',
      }),
    ),

  importRows: async ({ tenantId, rows }) => {
    /*
     * **Duplicate SKUs are found across the whole import, before batching.**
     * `upsertProducts` refuses duplicates within the rows it is given, but a
     * SKU in batch one and again in batch three would reach it as two separate
     * calls — and the second would quietly overwrite the first.
     */
    const occurrences = new Map<string, number>();
    for (const values of rows) {
      occurrences.set(values.sku, (occurrences.get(values.sku) ?? 0) + 1);
    }

    const outcomes: UpsertOutcome[] = [];
    const pending = rows.flatMap((values, index) => {
      if ((occurrences.get(values.sku) ?? 0) > 1) {
        outcomes.push({ index, outcome: 'duplicate-sku', sku: values.sku });
        return [];
      }
      return [{ index, values }];
    });

    const inOrder = (): UpsertOutcome[] => [...outcomes].sort((a, b) => a.index - b.index);

    for (let start = 0; start < pending.length; start += IMPORT_BATCH_SIZE) {
      const batch = pending.slice(start, start + IMPORT_BATCH_SIZE);

      try {
        /*
         * One transaction per batch, sequentially and on purpose: batches in
         * parallel would take row locks in an order nobody chose, and a
         * failure could no longer be described as "everything before this
         * applied".
         */

        const applied = await withTenant(tenantId, (tx) =>
          upsertProducts(tx, {
            tenantId,
            rows: batch,
            hashOf: (merged) => contentHashOf(merged),
            edited: (current) => nextEmbeddingStatus({ status: current, event: 'edited' }),
            reason: 'import',
          }),
        );
        outcomes.push(...applied);
      } catch (cause) {
        /*
         * **Reported, not thrown.** Every batch before this one committed, and
         * a thrown error would answer 500 for an import that mostly worked —
         * leaving the seller no way to know which rows are in. Importing the
         * same file again is the resume: rows already in come back unchanged
         * and cost nothing (P1-24).
         */
        return {
          outcomes: inOrder(),
          stoppedAt: {
            batch: start / IMPORT_BATCH_SIZE + 1,
            fromIndex: Math.min(...batch.map((row) => row.index)),
            toIndex: Math.max(...batch.map((row) => row.index)),
            cause,
          },
        };
      }
    }

    return { outcomes: inOrder(), stoppedAt: null };
  },
});
