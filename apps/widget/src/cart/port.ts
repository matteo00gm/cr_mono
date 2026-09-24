import { addViaEvent, addViaObject, countViaObject, type AddRequest } from './generic.js';
import type { CartAdapter } from './resolve.js';
import { addToShopifyCart, shopifyCartCount } from './shopify.js';

/**
 * One cart, whichever kind the storefront has (P3-10 → P3-13, §1.6).
 *
 * **The components above this know nothing about Shopify.** A card asks to add
 * a wine and is told whether it worked; the branching lives here, once, where
 * `resolve.ts` already decided which branch applies.
 */

export interface CartPort {
  /** True when there is anywhere to add to. A card without one shows "Vedi prodotto". */
  readonly canAdd: boolean;
  /**
   * True when a wine without a Shopify variant id cannot be added at all.
   *
   * The card reads this to disable its button *before* it is pressed: a seller
   * left a column blank, and a button that failed on click would look like our
   * bug rather than their setup (P3-11).
   */
  readonly needsVariantId: boolean;
  readonly add: (item: CartItem) => Promise<void>;
  /** The number for the badge, or nothing. A missing count is not a failure. */
  readonly count: () => Promise<number | undefined>;
}

export interface CartItem extends AddRequest {
  /** Shopify's numeric variant id, when the wine has one. */
  readonly variantId: string | null;
}

/** A wine a Shopify shop cannot add, because nobody filled in the variant id. */
export class VariantMissing extends Error {
  constructor() {
    super('Questo vino non ha un ID variante.');
    this.name = 'VariantMissing';
  }
}

export interface CartPortOptions {
  readonly adapter: CartAdapter;
  /** Ours, carried into the Shopify line so an order can be traced back (§2.4). */
  readonly sessionId: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly target?: EventTarget | undefined;
}

export const createCartPort = ({
  adapter,
  sessionId,
  fetch: fetch_,
  target,
}: CartPortOptions): CartPort => {
  if (adapter.k === 'none') {
    return {
      canAdd: false,
      needsVariantId: false,
      add: () => Promise.reject(new Error('Questo negozio non ha un carrello collegato.')),
      count: () => Promise.resolve(undefined),
    };
  }

  if (adapter.k === 'generic') {
    return {
      canAdd: true,
      /* The seller's own code takes our product id; what they do with it is theirs. */
      needsVariantId: false,
      add: (item) => addViaObject(adapter.cart, item),
      count: () => countViaObject(adapter.cart),
    };
  }

  if (adapter.k === 'event') {
    return {
      canAdd: true,
      needsVariantId: false,
      add: (item) => addViaEvent(item, target === undefined ? {} : { target }),
      /*
       * **No count for the event contract, by design.** Reading one would need
       * a second round trip of events and a second timeout, and the badge is a
       * nicety. The seller can implement the object contract if they want it.
       */
      count: () => Promise.resolve(undefined),
    };
  }

  return {
    canAdd: true,
    needsVariantId: true,
    add: async (item) => {
      /*
       * **A wine with no variant id cannot be added to a Shopify cart**, and
       * that is a seller's missing column rather than a shopper's problem. The
       * card disables its button ahead of time; this is the case where it was
       * pressed anyway.
       */
      if (item.variantId === null || item.variantId === '') throw new VariantMissing();

      await addToShopifyCart({
        variantId: item.variantId,
        quantity: item.quantity,
        sessionId,
        ...(fetch_ === undefined ? {} : { fetch: fetch_ }),
      });
    },
    count: () => shopifyCartCount(fetch_ ?? globalThis.fetch),
  };
};
