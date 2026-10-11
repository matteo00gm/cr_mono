import type { SalesResponse } from '@catalogorosso/api-client';

/**
 * The words the dashboard may use for money (P6-10, §2.4), chosen in one place.
 *
 * **A click on "add to cart" is not a sale, and calling it one to a paying
 * customer is a false claim.** An order is placed on the seller's own
 * checkout; we hear of it only once their Shopify store is connected (P6-07).
 * Until then every number we have stops at the cart, and a dashboard that
 * said "Vendite" above it would be contradicted by the seller's own order
 * list — after which nothing else on the screen is believed.
 *
 * **One flag, one function, every panel.** `hasOrderAttribution` comes from
 * the API (`GET /analytics/sales`), which is the one place that knows whether
 * a shop is connected. This turns it into the words, and no panel writes a
 * revenue word of its own: `revenue-labels.test.tsx` reads every file in this
 * folder and fails if the word turns up anywhere but here.
 *
 * **Not knowing is not a yes.** While the answer is still loading, or could
 * not be read, the flag is `undefined` and the words are the careful ones.
 */

/** What an add to cart is called. Always: knowing about orders does not turn a click into one. */
export const CART_LABEL = 'Aggiunte al carrello';

/** What attributed orders are called, when there are any to name. */
export const SALES_LABEL = 'Vendite';

export interface RevenueLabels {
  /** The funnel's last stage, and the wines table's column. */
  readonly cart: string;
  /** The sales panel's title — `undefined` when no sale can be seen, and so no panel. */
  readonly sales: string | undefined;
  /** What a seller is told under the funnel about what its last step is. */
  readonly note: string;
  /**
   * Whether to offer the Shopify connection: only when the API has said, in
   * so many words, that no shop is connected. Not while it is still to answer.
   */
  readonly offerShopify: boolean;
}

/** The flag as the API gave it, or `undefined` while it has not. */
export const attributionOf = (sales: SalesResponse | undefined): boolean | undefined =>
  sales?.hasOrderAttribution;

export const revenueLabels = (hasOrderAttribution: boolean | undefined): RevenueLabels =>
  hasOrderAttribution === true
    ? {
        cart: CART_LABEL,
        sales: SALES_LABEL,
        note:
          'L’ultimo passo è un’aggiunta al carrello, non un ordine. Gli ordini che ne sono ' +
          'nati li riporta il tuo negozio Shopify, e li trovi qui sotto.',
        offerShopify: false,
      }
    : {
        cart: CART_LABEL,
        sales: undefined,
        note:
          'L’ultimo passo è un’aggiunta al carrello, non un ordine: l’ordine si conclude sul ' +
          'tuo sito, dove non lo vediamo.',
        offerShopify: hasOrderAttribution === false,
      };

/** `2.864,50 €`: an amount in hundredths, as an Italian reads one. */
export const money = ({
  currency,
  cents,
}: {
  readonly currency: string;
  readonly cents: number;
}): string =>
  /* `always`, as `count` has it: Italian leaves four digits ungrouped by default, and a column of them does not line up. */
  new Intl.NumberFormat('it-IT', { style: 'currency', currency, useGrouping: 'always' }).format(
    cents / 100,
  );
