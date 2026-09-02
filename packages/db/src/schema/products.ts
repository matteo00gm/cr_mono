import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `products` — the fixed template from §2.2, as a table (P0-26).
 *
 * The canonical schema every entry point in §2.2a validates against: the form,
 * the paste parser and the file import all funnel into `upsertProducts()` and
 * all are checked against the `drizzle-zod` contract derived from this table
 * (P0-42). One definition, not three.
 *
 * Every column here is one §2.2's form asks a seller to fill, or one the
 * ingestion pipeline reads. The `enriched_*` columns §4.2 suggested reserving
 * are deliberately absent — see the note at the foot of this file.
 */

/** §2.2's availability states. Drives retrieval filtering, so it is an enum. */
export const productStockStatus = pgEnum('product_stock_status', [
  'IN_STOCK',
  'OUT_OF_STOCK',
  'PREORDER',
]);

/** Soft delete: a product stops being recommended without losing its history. */
export const productStatus = pgEnum('product_status', ['ACTIVE', 'ARCHIVED']);

/** Where a row sits in the embedding pipeline (§4.1), surfaced per row in the UI. */
export const productEmbeddingState = pgEnum('product_embedding_state', [
  'PENDING',
  'INDEXED',
  'FAILED',
  'STALE',
]);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    // --- Identity -----------------------------------------------------------
    sku: text('sku').notNull(),

    /**
     * Nullable at the column level, required by the form (P1-01).
     *
     * The Shopify cart adapter cannot add to cart without it (§1.6), so a new
     * product without one is a bug. A legacy row may predate it, and a NOT NULL
     * here would mean the import path has to invent a value — which is worse
     * than a null, because an invented id fails at the checkout rather than at
     * the form.
     */
    externalVariantId: text('external_variant_id'),

    name: text('name').notNull(),
    producer: text('producer'),
    vintage: integer('vintage'),

    // --- Classification -----------------------------------------------------
    /**
     * Text, not an enum. *(Decision the plan left open.)* Wine categories are a
     * taxonomy that grows sideways — orange, pét-nat, col fondo — and each
     * addition would be an `ALTER TYPE` for a label that guards nothing. The
     * allowed set belongs in the shared `drizzle-zod` contract (P0-42), which is
     * where §2.2 says validation lives; the database's job here is to require a
     * value, not to adjudicate the wine world.
     */
    wineType: text('wine_type').notNull(),

    grapeVarieties: text('grape_varieties').array(),
    region: text('region'),
    denomination: text('denomination'),
    styleTags: text('style_tags').array(),

    // --- Sommelier data -----------------------------------------------------
    tastingNotes: text('tasting_notes'),
    foodPairings: text('food_pairings').array(),

    /** `numeric`, not a float: 13.5% has to round-trip as 13.5. */
    alcoholPct: numeric('alcohol_pct', { precision: 4, scale: 2 }),

    // --- Commerce -----------------------------------------------------------
    /**
     * Integer minor units. Never a float — money in floating point produces the
     * `12.499999` that shows up in a cart total and nowhere in the data.
     */
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull(),

    stockStatus: productStockStatus('stock_status').notNull(),
    stockQty: integer('stock_qty'),

    productUrl: text('product_url'),
    imageUrl: text('image_url'),

    // --- Lifecycle and indexing ---------------------------------------------
    status: productStatus('status').notNull().default('ACTIVE'),

    /**
     * Hash of the text that gets embedded (§4.1). An edit that does not change
     * it — a stock correction, a price change — costs no embedding, which is
     * the difference between a cheap catalog update and a bill.
     */
    contentHash: text('content_hash'),
    embeddingState: productEmbeddingState('embedding_state').notNull().default('PENDING'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /** The upsert key for P1-24. An import matches on it; nothing else. */
    unique('products_tenant_sku_unique').on(table.tenantId, table.sku),

    /**
     * The catalog grid and every retrieval query filter on both. `tenant_id`
     * leads, so this also serves the referential check behind a tenant delete.
     */
    index('products_tenant_status_idx').on(table.tenantId, table.status),

    /** The worker's queue query: what still needs embedding for this tenant. */
    index('products_tenant_embedding_state_idx').on(table.tenantId, table.embeddingState),

    /**
     * Negative money is not a discount, it is a bug that reaches a cart. The
     * import path is the one that would produce it, from a mis-parsed cell.
     */
    check('products_price_non_negative', sql`price_cents >= 0`),
    check('products_stock_qty_non_negative', sql`stock_qty is null or stock_qty >= 0`),
    /**
     * Only the lower bound. `numeric(4, 2)` already refuses anything at or above
     * 100 — with a `numeric_value_out_of_range`, not a check violation — so an
     * upper bound here would be unreachable code that reads as though it were
     * doing the work.
     */
    check('products_alcohol_pct_non_negative', sql`alcohol_pct is null or alcohol_pct >= 0`),
  ],
);

/*
 * On the `enriched_*` columns that are not here.
 *
 * §4.2 proposes reserving four columns for LLM enrichment "so adding it later is
 * not a migration". Two things undercut that. `ALTER TABLE ADD COLUMN` with no
 * default has been metadata-only and O(1) since Postgres 11, so adding one later
 * is not the expensive operation the argument assumes — and this table holds
 * roughly 2,500 SKUs per tenant, which is not a large table by any measure that
 * would change the answer.
 *
 * More to the point, §4.2 cuts enrichment from launch precisely so the
 * ZERO_RESULTS panel can show whether thin catalogs are actually hurting
 * retrieval. Reserving a shape now guesses at a schema for a feature that has
 * deliberately not been designed, and a wrong guess is worse than an absence,
 * because it reads as authoritative to the next person.
 */
