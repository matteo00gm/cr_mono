import { describe, expect, it } from 'vitest';

import { isSommelierCart, resolveCart, type HostPage } from '../src/cart/resolve.js';

/**
 * Which cart this storefront has (P3-10, §1.6).
 *
 * **A table of cases is the whole safety net.** We cannot test on every
 * customer site, so the only thing standing between us and a shop where the
 * button does nothing is that every branch of a pure function has an assertion
 * against it.
 */

const cart = { addToCart: () => undefined, getCount: () => 0 };

const on = (host: HostPage, declared?: string) => resolveCart({ host, declared });

describe('what is on the page', () => {
  it('uses the seller own object when there is one', () => {
    expect(on({ __sommelierCart: cart })).toEqual({ k: 'generic', cart });
  });

  it('uses Shopify when the theme is there', () => {
    expect(on({ Shopify: { shop: 'cantina-rossi.myshopify.com' } })).toEqual({ k: 'shopify' });
  });

  it('lets the seller own object beat Shopify', () => {
    /*
     * A Shopify store that has *also* implemented the contract has done so on
     * purpose, probably because their theme does something ours would break.
     */
    expect(on({ __sommelierCart: cart, Shopify: {} })).toEqual({ k: 'generic', cart });
  });

  it('finds nothing on a page with neither', () => {
    // The card degrades to "Vedi prodotto" (§1.6) rather than a dead button.
    expect(on({})).toEqual({ k: 'none' });
  });

  it('ignores a Shopify global that is not an object', () => {
    expect(on({ Shopify: 'yes' })).toEqual({ k: 'none' });
  });
});

describe('a half-implemented contract', () => {
  it('is refused when addToCart is missing', () => {
    expect(on({ __sommelierCart: { getCount: () => 0 } })).toEqual({ k: 'none' });
  });

  it('is refused when getCount is missing', () => {
    expect(on({ __sommelierCart: { addToCart: () => undefined } })).toEqual({ k: 'none' });
  });

  it('is refused when the members are not functions', () => {
    expect(on({ __sommelierCart: { addToCart: 'yes', getCount: 3 } })).toEqual({ k: 'none' });
  });

  it('is refused when it is not an object at all', () => {
    for (const value of [null, undefined, 'cart', 42, []]) {
      expect(isSommelierCart(value), String(value)).toBe(false);
    }
  });

  it('degrades rather than throwing, which is the point', () => {
    /* A seller's half-implementation must not become an exception inside their
     * own page, with our name on the stack trace. */
    expect(() => on({ __sommelierCart: { addToCart: null } })).not.toThrow();
  });
});

describe('when the seller says so themselves', () => {
  it('takes the event contract on their word', () => {
    /*
     * There is no API that answers "does anything listen for this event", so
     * the event contract cannot be detected — declaring it is one attribute
     * beside `data-key`.
     */
    expect(on({}, 'event')).toEqual({ k: 'event' });
  });

  it('takes Shopify on their word, for a headless storefront', () => {
    // A headless store sets no `window.Shopify` and still has `/cart/add.js`.
    expect(on({}, 'shopify')).toEqual({ k: 'shopify' });
  });

  it('takes no cart on their word, whatever is on the page', () => {
    expect(on({ Shopify: {} }, 'none')).toEqual({ k: 'none' });
  });

  it('prefers what they declared over what we detect', () => {
    expect(on({ Shopify: {} }, 'event')).toEqual({ k: 'event' });
  });

  it('treats a declared generic as the same thing detection already does', () => {
    /* Saying it changes nothing: if the object is there we find it anyway. */
    expect(on({ __sommelierCart: cart }, 'generic')).toEqual({ k: 'generic', cart });
  });

  it('falls through when they declared generic and the object is not there', () => {
    /* They said what they meant and got it wrong. A degraded card still works;
     * a declared adapter with nothing behind it does not. */
    expect(on({ Shopify: {} }, 'generic')).toEqual({ k: 'shopify' });
  });

  it('ignores a mode nobody defined', () => {
    expect(on({ Shopify: {} }, 'woocommerce')).toEqual({ k: 'shopify' });
  });

  it('ignores an empty declaration', () => {
    expect(on({ Shopify: {} }, '')).toEqual({ k: 'shopify' });
  });
});
