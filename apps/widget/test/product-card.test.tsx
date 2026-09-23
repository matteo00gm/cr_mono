import type { WidgetProduct } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

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
};

const show = (product: Partial<WidgetProduct> = {}, locale: 'it' | 'en' = 'it') =>
  render(
    <LocaleContext.Provider value={locale}>
      <MessagesContext.Provider value={locale === 'it' ? italian : en}>
        <ProductCard productId="p1" reason="tannino deciso" product={{ ...WINE, ...product }} />
      </MessagesContext.Provider>
    </LocaleContext.Provider>,
  );

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
