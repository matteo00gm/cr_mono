import { useCallback, useEffect, useState } from 'preact/hooks';

import type { CartPort } from '../cart/port.js';
import { safeCartUrl } from '../cart/url.js';
import { useT } from '../i18n/useT.js';

/**
 * The cart, in the panel header (P3-13, §1.6).
 *
 * **We never render a checkout.** Clicking navigates the *host page* to the
 * seller's own cart, which is where their theme, their discounts and their
 * payment methods live. A cart of our own would be a second checkout for a
 * shopper to distrust and a second PCI surface for us to own.
 *
 * **The count is read back, not counted up.** A shopper may have added wines in
 * another tab or emptied the cart in the shop's own drawer, so a number we
 * incremented ourselves would drift and be wrong in a way nobody could explain.
 */

export interface CartButtonProps {
  readonly cart: CartPort;
  /** The tenant's configured cart path. Validated before it is used. */
  readonly cartUrl: string;
  /** Bumped after every add, so the count is refetched. */
  readonly refreshKey: number;
  /** Injected so a test can watch the navigation rather than perform it. */
  readonly navigate?: ((url: string) => void) | undefined;
  readonly origin?: string | undefined;
}

export const CartButton = ({ cart, cartUrl, refreshKey, navigate, origin }: CartButtonProps) => {
  const t = useT();
  const [count, setCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    let live = true;

    void cart.count().then((next) => {
      /* A count that arrives after the panel is gone is a state update nobody
       * asked for. */
      if (live) setCount(next);
    });

    return () => {
      live = false;
    };
  }, [cart, refreshKey]);

  const open = useCallback((): void => {
    const here = origin ?? globalThis.location.href;
    const url = safeCartUrl(cartUrl, here);

    if (navigate !== undefined) {
      navigate(url);

      return;
    }

    /*
     * `window.top`, because the widget may be inside an iframe the seller put
     * it in and the *shopper's* page is the one that has to move. Falls back to
     * our own window when `top` is cross-origin and unreachable.
     */
    try {
      (globalThis.top ?? globalThis).location.assign(url);
    } catch {
      globalThis.location.assign(url);
    }
  }, [cartUrl, navigate, origin]);

  return (
    <button type="button" class="cart-button" onClick={open} aria-label={t('openCart')}>
      <span aria-hidden="true">{'\u{1F6D2}'}</span>
      {count !== undefined && count > 0 && (
        <span class="cart-count" data-testid="cart-count">
          {String(count)}
        </span>
      )}
    </button>
  );
};
