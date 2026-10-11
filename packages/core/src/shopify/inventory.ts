import { z } from 'zod';

/**
 * Reading a Shopify product for what is in stock (P6-11, §4.4).
 *
 * **`products/update`, not `inventory_levels/update`.** The inventory webhook
 * is the intuitive one and the wrong one: it names an inventory item and a
 * location, never a variant, so every delivery would need a mapping table or a
 * call back to Shopify before it meant anything. `products/update` fires when
 * a product is edited *and when it is ordered*, and carries each variant with
 * the id the catalogue already holds (P3-11).
 *
 * **The quantity is Shopify's own sum across locations.** A variant's
 * `inventory_quantity` is the aggregate of every location that stocks it, so a
 * warehouse reaching zero while the shop still has six bottles arrives here as
 * six. Nothing is summed in this file because nothing arrives in parts.
 *
 * **Untracked is in stock, not zero.** A shop that does not have Shopify count
 * a wine (`inventory_management: null`) reports a quantity of zero for it, and
 * reading that as sold out would hide a seller's whole catalogue the moment
 * they connected their store.
 */

/** How many deliveries one shop may have applied in a minute, before it is asked to send them again. */
export const STOCK_SYNC_PER_MINUTE = 600;
export const STOCK_SYNC_WINDOW_SEC = 60;

/** The key one shop's stock deliveries are counted under. */
export const stockSyncLimitKey = (shop: string): string => `shopify:stock:${shop}`;

export type SyncedStockStatus = 'IN_STOCK' | 'OUT_OF_STOCK' | 'PREORDER';

/** What Shopify says of one variant, in the catalogue's own terms. */
export interface VariantStock {
  /** Shopify's numeric variant id, as the catalogue stores it (P3-11). */
  readonly variantId: string;
  readonly status: SyncedStockStatus;
  /** Units on hand across every location, or `null` when Shopify does not count this wine. */
  readonly quantity: number | null;
}

export interface ProductStock {
  /**
   * When Shopify says the product last changed. Deliveries are not ordered —
   * a redelivery can arrive after the news that replaced it — and this is what
   * lets the record tell which is the later word. `undefined` when the body
   * does not say.
   */
  readonly updatedAt: Date | undefined;
  readonly variants: readonly VariantStock[];
}

const variant = z.object({
  /* `.int()` is a safe integer: an id past what JSON carries whole is not one we can match on. */
  id: z.number().int().positive(),
  inventory_quantity: z.number().int().optional(),
  inventory_management: z.string().nullish(),
  inventory_policy: z.string().nullish(),
});

const productBody = z.object({
  updated_at: z.string().max(64).optional(),
  variants: z.array(z.unknown()).max(2000),
});

/**
 * One variant's availability.
 *
 * Counted and above zero is in stock. Counted and at or below zero is sold out
 * — unless the shop keeps selling it anyway (`inventory_policy: 'continue'`),
 * which is a wine a shopper can still order and so is `PREORDER`: the widget
 * says *"Su ordinazione"* rather than hiding it (§1.5). A quantity below zero
 * is an oversold line, and is kept as zero: the column counts bottles.
 */
const stockOf = (
  tracked: boolean,
  counted: number,
  keepsSelling: boolean,
): Pick<VariantStock, 'status' | 'quantity'> => {
  if (!tracked) return { status: 'IN_STOCK', quantity: null };
  if (counted > 0) return { status: 'IN_STOCK', quantity: counted };

  return { status: keepsSelling ? 'PREORDER' : 'OUT_OF_STOCK', quantity: 0 };
};

/**
 * Each variant's stock, as a product update reports it — or `undefined` when
 * the body is not a product we can read.
 *
 * A variant that cannot be read is left out rather than guessed at: a wine
 * whose stock we do not know keeps the stock it had. Called only after the
 * body's signature has been checked.
 */
export const readProductStock = (body: string): ProductStock | undefined => {
  let json: unknown;

  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }

  const parsed = productBody.safeParse(json);

  if (!parsed.success) return undefined;

  const changed =
    parsed.data.updated_at === undefined ? Number.NaN : Date.parse(parsed.data.updated_at);

  return {
    updatedAt: Number.isNaN(changed) ? undefined : new Date(changed),
    variants: parsed.data.variants.flatMap((raw) => {
      const read = variant.safeParse(raw);

      if (!read.success) return [];

      /*
       * Untracked is said with an explicit `null`. A body that does not
       * mention tracking at all has told us nothing, and nothing is not
       * "in stock": the wine keeps what it had.
       */
      if (read.data.inventory_management === undefined) return [];

      const tracked = read.data.inventory_management !== null;

      /* Counted, and no count given: not something to turn into "sold out". */
      if (tracked && read.data.inventory_quantity === undefined) return [];

      return [
        {
          variantId: String(read.data.id),
          ...stockOf(
            tracked,
            read.data.inventory_quantity ?? 0,
            read.data.inventory_policy === 'continue',
          ),
        },
      ];
    }),
  };
};
