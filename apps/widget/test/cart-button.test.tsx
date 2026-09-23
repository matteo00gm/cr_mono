import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CartPort } from '../src/cart/port.js';
import { DEFAULT_CART_URL, safeCartUrl } from '../src/cart/url.js';
import { CartButton } from '../src/components/CartButton.js';
import { it as italian } from '../src/i18n/it.js';
import { MessagesContext } from '../src/i18n/useT.js';

/**
 * The cart button, and where it goes (P3-13, §1.6).
 *
 * **We never render a checkout.** Clicking navigates the host page to the
 * seller's own cart, which is where their theme, their discounts and their
 * payment methods live.
 *
 * **The `cartUrl` check is a security control.** It comes from *our*
 * configuration record, so anybody who can write that record could point every
 * shopper of every winery at a page they reach from inside a shop they trust.
 */

afterEach(cleanup);

const SHOP = 'https://cantina-rossi.example/vini/barolo';

const port = (count: number | undefined): CartPort => ({
  canAdd: true,
  needsVariantId: false,
  add: () => Promise.resolve(),
  count: () => Promise.resolve(count),
});

const show = (cart: CartPort, cartUrl: string, navigate: (url: string) => void, key = 0) =>
  render(
    <MessagesContext.Provider value={italian}>
      <CartButton
        cart={cart}
        cartUrl={cartUrl}
        refreshKey={key}
        navigate={navigate}
        origin={SHOP}
      />
    </MessagesContext.Provider>,
  );

const button = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: italian.openCart });

/**
 * Lets every queued microtask and Preact rerender run.
 *
 * Needed before asserting that something did *not* happen: `waitFor` stops at
 * the first moment its callback passes, which is before the late value it is
 * supposed to be ignoring has even arrived.
 */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('the count', () => {
  it('shows what the cart reports', async () => {
    show(port(3), '/cart', () => undefined);

    await waitFor(() => {
      expect(screen.getByTestId('cart-count').textContent).toBe('3');
    });
  });

  it('shows nothing for an empty cart, rather than a zero', async () => {
    const view = show(port(0), '/cart', () => undefined);

    await waitFor(() => {
      expect(view.container.querySelector('.cart-button')).not.toBeNull();
    });

    expect(screen.queryByTestId('cart-count')).toBeNull();
  });

  it('shows nothing when the cart cannot say', async () => {
    /* A missing count is a nicety missing, not a failure to report. */
    const view = show(port(undefined), '/cart', () => undefined);

    await waitFor(() => {
      expect(view.container.querySelector('.cart-button')).not.toBeNull();
    });

    expect(screen.queryByTestId('cart-count')).toBeNull();
  });

  it('refetches after an add', async () => {
    const count = vi.fn<CartPort['count']>().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const cart: CartPort = {
      canAdd: true,
      needsVariantId: false,
      add: () => Promise.resolve(),
      count,
    };
    const view = show(cart, '/cart', () => undefined, 0);

    await waitFor(() => {
      expect(screen.getByTestId('cart-count').textContent).toBe('1');
    });

    view.rerender(
      <MessagesContext.Provider value={italian}>
        <CartButton
          cart={cart}
          cartUrl="/cart"
          refreshKey={1}
          navigate={() => undefined}
          origin={SHOP}
        />
      </MessagesContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('cart-count').textContent).toBe('2');
    });
  });
});

describe('a count that arrives late', () => {
  it('does not overwrite a fresher one', async () => {
    /*
     * The badge refetches whenever `refreshKey` changes, so two reads can be in
     * flight at once. Without the guard the *slower* one wins, and a shopper
     * who added a wine watches the count go back down.
     */
    let releaseStale = (value: number): void => void value;
    const stale = new Promise<number>((resolve) => {
      releaseStale = resolve;
    });
    const count = vi.fn<CartPort['count']>().mockReturnValueOnce(stale).mockResolvedValueOnce(2);
    const cart: CartPort = {
      canAdd: true,
      needsVariantId: false,
      add: () => Promise.resolve(),
      count,
    };
    const view = show(cart, '/cart', () => undefined, 0);

    view.rerender(
      <MessagesContext.Provider value={italian}>
        <CartButton
          cart={cart}
          cartUrl="/cart"
          refreshKey={1}
          navigate={() => undefined}
          origin={SHOP}
        />
      </MessagesContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('cart-count').textContent).toBe('2');
    });

    releaseStale(99);
    await settle();

    expect(screen.getByTestId('cart-count').textContent).toBe('2');
  });
});

describe('where it goes', () => {
  it('navigates to the configured path', () => {
    const navigate = vi.fn();

    show(port(1), '/carrello', navigate);
    fireEvent.click(button());

    expect(navigate).toHaveBeenCalledWith('/carrello');
  });

  it('keeps a same-origin absolute URL, as a path', () => {
    const navigate = vi.fn();

    show(port(1), 'https://cantina-rossi.example/carrello?x=1', navigate);
    fireEvent.click(button());

    expect(navigate).toHaveBeenCalledWith('/carrello?x=1');
  });
});

describe('a cart URL pointing somewhere else', () => {
  /*
   * **An open redirect driven by tenant config would be a real vulnerability.**
   * The shopper reaches it from a link inside a shop they trust, and the value
   * comes from *our* record rather than theirs.
   */
  it.each([
    'https://evil.example/cart',
    '//evil.example/cart',
    'javascript:alert(1)',
    'http://cantina-rossi.example.evil.test/cart',
  ])('refuses %s and falls back to the default', (cartUrl) => {
    expect(safeCartUrl(cartUrl, SHOP)).toBe(DEFAULT_CART_URL);
  });

  it('refuses it at the button too, not only in the helper', () => {
    const navigate = vi.fn();

    show(port(1), '//evil.example/cart', navigate);
    fireEvent.click(button());

    expect(navigate).toHaveBeenCalledWith(DEFAULT_CART_URL);
  });

  it('falls back for an empty or absent configuration', () => {
    expect(safeCartUrl('', SHOP)).toBe(DEFAULT_CART_URL);
    expect(safeCartUrl(undefined, SHOP)).toBe(DEFAULT_CART_URL);
  });

  it('falls back rather than throwing when the origin is unusable', () => {
    expect(safeCartUrl('/cart', 'not a url')).toBe(DEFAULT_CART_URL);
  });

  it('keeps a query and a fragment on a path it accepts', () => {
    expect(safeCartUrl('/cart?note=sommelier#top', SHOP)).toBe('/cart?note=sommelier#top');
  });

  it('is not fooled by a protocol-relative URL that reads as a path', () => {
    /*
     * The case a check written with `startsWith('/')` lets straight through —
     * and the payload has to differ from the fallback, or the exploit and the
     * refusal produce the same string and no assertion can tell them apart.
     */
    expect(safeCartUrl('//evil.example/pwn', SHOP)).toBe(DEFAULT_CART_URL);
  });
});
