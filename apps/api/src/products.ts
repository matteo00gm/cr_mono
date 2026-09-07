import type { Product } from '@catalogorosso/api-client';
import { contentHashOf } from '@catalogorosso/core';
import {
  insertProduct,
  updateProduct,
  withTenant,
  type ProductInsert,
  type ProductRow,
  type ProductUpdate,
  type ProductUpdateOutcome,
  type ProductWriteOutcome,
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

export interface ProductsPort {
  create(command: CreateProductCommand): Promise<ProductWriteOutcome>;
  update(command: UpdateProductCommand): Promise<ProductUpdateOutcome>;
}

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
});
