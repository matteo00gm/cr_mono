import type { WidgetProduct } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductCard } from '../src/components/ProductCard.js';
import { en } from '../src/i18n/en.js';
import { it as italian } from '../src/i18n/it.js';
import { LocaleContext, MessagesContext } from '../src/i18n/useT.js';
import { asPrice } from '../src/sanitise.js';

/**
 * One wine, as a shopper sees it (P3-08, §1.5).
 *
 * The security half is `xss.test.tsx`. This is the rest: that a card says what
 * a shopper needs in order to decide, and that the ways a seller's own
 * catalogue is *incomplete* — no image, no link, no producer, a currency
 * somebody typed by hand — each produce a card rather than a broken one.
 */

afterEach(cleanup);

const WINE: WidgetProduct = {
  name: 'Barolo Bussia',
  producer: 'Cantina Rossi',
  vintage: 2016,
  priceCents: 4200,
  currency: 'EUR',
  imageUrl: 'https://cdn.example/barolo.jpg',
  productUrl: 'https://cantina-rossi.example/barolo',
  stockStatus: 'IN_STOCK',
  variantId: '45123456789',
};

interface Extras {
  readonly onAdd?: (item: { productId: string; variantId: string | null }) => Promise<void>;
  readonly needsVariantId?: boolean;
}

const show = (
  product: Partial<WidgetProduct> = {},
  locale: 'it' | 'en' = 'it',
  extras: Extras = {},
) =>
  render(
    <LocaleContext.Provider value={locale}>
      <MessagesContext.Provider value={locale === 'it' ? italian : en}>
        <ProductCard
          productId="p1"
          reason="tannino deciso"
          product={{ ...WINE, ...product }}
          variantId={'variantId' in product ? (product.variantId ?? null) : WINE.variantId}
          {...extras}
        />
      </MessagesContext.Provider>
    </LocaleContext.Provider>,
  );

const addButton = (): HTMLButtonElement | null =>
  card().querySelector<HTMLButtonElement>('.card-add');

/** The button, insisting it is there: a missing one is the test's own bug. */
const pressAdd = (): void => {
  const button = addButton();

  if (button === null) throw new Error('The card rendered no add-to-cart button.');

  fireEvent.click(button);
};

const card = (): HTMLElement => screen.getByRole('listitem');
const textOf = (selector: string): string =>
  card().querySelector(selector)?.textContent?.trim() ?? '';

describe('what a card says', () => {
  it('names the wine, the producer and the vintage', () => {
    show();

    expect(textOf('.card-title')).toBe('Barolo Bussia — Cantina Rossi, 2016');
  });

  it('carries the id, so the cart knows what to add', () => {
    show();

    expect(card().dataset.productId).toBe('p1');
  });

  it('shows the reason the model wrote', () => {
    show();

    expect(textOf('.card-reason')).toBe('tannino deciso');
  });

  it('shows the price in the winery currency, formatted for the reader', () => {
    show();

    expect(textOf('.card-price')).toBe(asPrice(4200, 'EUR', 'it'));
  });

  it('formats the same price differently for an English reader', () => {
    // €42,00 and €42.00 are the same money and not the same string.
    expect(asPrice(4200, 'EUR', 'it')).not.toBe(asPrice(4200, 'EUR', 'en'));
  });

  it('does not fall over on a currency somebody typed into a spreadsheet', () => {
    /* `Intl` throws on anything that is not a well-formed code, and a seller who
     * typed `EURO` would otherwise take every card on their own site down. */
    show({ currency: 'EURO' });

    expect(textOf('.card-price')).toContain('42.00');
  });
});

describe('a catalogue that is not complete', () => {
  it('drops the producer and vintage it does not have', () => {
    show({ producer: null, vintage: null });

    expect(textOf('.card-title')).toBe('Barolo Bussia');
  });

  it('keeps a vintage without a producer', () => {
    show({ producer: null });

    expect(textOf('.card-title')).toBe('Barolo Bussia — 2016');
  });

  it('shows a placeholder rather than a broken image box', () => {
    // A broken image on a wine card looks like a broken shop.
    show({ imageUrl: null });

    expect(card().querySelector('img')).toBeNull();
    expect(card().querySelector('.card-image--missing')).not.toBeNull();
  });

  it('falls back when the image fails to load', () => {
    show();

    const image = card().querySelector('img');

    if (image === null) throw new Error('The card rendered no image to fail.');

    fireEvent.error(image);

    expect(card().querySelector('img')).toBeNull();
    expect(card().querySelector('.card-image--missing')).not.toBeNull();
  });

  it('loads the image lazily, because most cards are below the fold', () => {
    show();

    expect(card().querySelector('img')?.getAttribute('loading')).toBe('lazy');
  });

  it('hides the image from a screen reader, which the title already names', () => {
    show();

    expect(card().querySelector('img')?.getAttribute('alt')).toBe('');
  });

  it('offers no link when the winery has not given one', () => {
    show({ productUrl: null });

    expect(card().querySelector('a')).toBeNull();
  });
});

describe('what a shopper can buy', () => {
  it('says nothing about stock for a wine that is in stock', () => {
    show();

    expect(card().querySelector('.card-badge')).toBeNull();
  });

  it('badges a wine that is out of stock', () => {
    // §1.5: out of stock renders with a clear badge and no add-to-cart.
    show({ stockStatus: 'OUT_OF_STOCK' });

    expect(textOf('.card-badge')).toBe(italian.outOfStock);
  });

  it('badges a wine on pre-order, which is neither in nor out', () => {
    show({ stockStatus: 'PREORDER' });

    expect(textOf('.card-badge')).toBe(italian.preorder);
  });

  it('says it in the reader language', () => {
    show({ stockStatus: 'OUT_OF_STOCK' }, 'en');

    expect(textOf('.card-badge')).toBe(en.outOfStock);
  });
});

describe('adding a wine to the cart', () => {
  const adding = () => vi.fn(() => Promise.resolve());

  it('offers no button on a storefront with no cart we can reach', () => {
    // §1.6: degrade to "Vedi prodotto" rather than a button that does nothing.
    show();

    expect(addButton()).toBeNull();
    expect(card().querySelector('.card-link')?.textContent).toBe(italian.viewProduct);
  });

  it('offers the button when there is somewhere to add to', () => {
    show({}, 'it', { onAdd: adding() });

    expect(addButton()?.textContent).toBe(italian.addToCart);
  });

  it('hands the cart the wine and its variant id', async () => {
    const onAdd = adding();

    show({}, 'it', { onAdd });
    pressAdd();

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith({ productId: 'p1', variantId: '45123456789' });
    });
  });

  it('says it is working, then that it is done', async () => {
    show({}, 'it', { onAdd: adding() });
    pressAdd();

    await waitFor(() => {
      expect(addButton()?.textContent).toBe(italian.added);
    });
  });

  it('says so when the shop refused, rather than pretending it worked', async () => {
    /* A button that says "aggiunto" over a cart that never changed is the worst
     * outcome here: the shopper finds out at checkout. */
    const onAdd = vi.fn(() => Promise.reject(new Error('esaurito')));

    show({}, 'it', { onAdd });
    pressAdd();

    await waitFor(() => {
      expect(addButton()?.textContent).toBe(italian.addFailed);
    });
  });

  it('cannot be pressed twice while it is working', async () => {
    const onAdd = vi.fn(() => new Promise<void>(() => undefined));

    show({}, 'it', { onAdd });
    pressAdd();

    await waitFor(() => {
      expect(addButton()?.disabled).toBe(true);
    });
  });

  it('offers nothing for a wine that is out of stock', () => {
    // §1.5: a clear badge and no add-to-cart.
    show({ stockStatus: 'OUT_OF_STOCK' }, 'it', { onAdd: adding() });

    expect(addButton()).toBeNull();
    expect(textOf('.card-badge')).toBe(italian.outOfStock);
  });

  it('still offers a pre-order, which is a wine a shop will sell you', () => {
    show({ stockStatus: 'PREORDER' }, 'it', { onAdd: adding() });

    expect(addButton()).not.toBeNull();
  });

  it('offers nothing on Shopify for a wine with no variant id', () => {
    /*
     * A seller left the column blank. Disabled *before* the press, because a
     * button that failed on click would look like our bug rather than their
     * setup (P3-11).
     */
    show({ variantId: null }, 'it', { onAdd: adding(), needsVariantId: true });

    expect(addButton()).toBeNull();
    expect(card().querySelector('.card-link')?.textContent).toBe(italian.viewProduct);
  });

  it('offers it anyway when the adapter does not need one', () => {
    show({ variantId: null }, 'it', { onAdd: adding(), needsVariantId: false });

    expect(addButton()).not.toBeNull();
  });

  it('calls the link "Dettagli" beside a working button', () => {
    show({}, 'it', { onAdd: adding() });

    expect(card().querySelector('.card-link')?.textContent).toBe(italian.details);
  });
});
