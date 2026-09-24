import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPayload,
  emptyValues,
  ProductForm,
  valuesFrom,
  type ProductFormValues,
} from '../src/features/catalog/ProductForm.js';

/**
 * The form's mapping, both ways, and the branches nothing else took.
 *
 * `product-form.test.tsx` covers the rules; a coverage report showed the
 * mapping of *filled* optional fields, the round trip from a stored product,
 * each numeric message, and the availability select were never exercised. A
 * dropped optional field is a value a seller typed and lost, with nothing to
 * explain it — so each one is asserted to arrive.
 */

afterEach(cleanup);

const REQUIRED: ProductFormValues = {
  ...emptyValues(),
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  price: '45,00',
};

describe('valuesFrom', () => {
  it('turns every stored field back into the text the form edits', () => {
    expect(
      valuesFrom({
        sku: 'BAR-2019',
        externalVariantId: '45123456789',
        name: 'Barolo Bussia',
        producer: 'Poderi Colla',
        vintage: 2019,
        wineType: 'red',
        grapeVarieties: ['Nebbiolo', 'Barbera'],
        region: 'Piemonte',
        denomination: 'Barolo DOCG',
        tastingNotes: 'Rosa appassita.',
        foodPairings: ['brasato', 'tartufo'],
        styleTags: ['tannico'],
        alcoholPct: '14.50',
        priceCents: 4500,
        currency: 'CHF',
        stockStatus: 'PREORDER',
        stockQty: 24,
        productUrl: 'https://example.com/barolo',
        imageUrl: 'https://example.com/barolo.jpg',
      }),
    ).toEqual({
      sku: 'BAR-2019',
      externalVariantId: '45123456789',
      name: 'Barolo Bussia',
      producer: 'Poderi Colla',
      vintage: '2019',
      wineType: 'red',
      grapeVarieties: 'Nebbiolo, Barbera',
      region: 'Piemonte',
      denomination: 'Barolo DOCG',
      tastingNotes: 'Rosa appassita.',
      foodPairings: 'brasato, tartufo',
      styleTags: 'tannico',
      alcoholPct: '14.50',
      price: '45,00',
      currency: 'CHF',
      stockStatus: 'PREORDER',
      stockQty: '24',
      productUrl: 'https://example.com/barolo',
      imageUrl: 'https://example.com/barolo.jpg',
    });
  });

  it('reads nulls as empty fields, with the form’s currency and availability', () => {
    expect(
      valuesFrom({
        externalVariantId: null,
        producer: null,
        vintage: null,
        grapeVarieties: null,
        region: null,
        denomination: null,
        tastingNotes: null,
        foodPairings: null,
        styleTags: null,
        alcoholPct: null,
        stockQty: null,
        productUrl: null,
        imageUrl: null,
      }),
    ).toEqual(emptyValues());
  });
});

describe('buildPayload', () => {
  it('sends every optional field a seller filled in, trimmed and parsed', () => {
    expect(
      buildPayload({
        ...REQUIRED,
        sku: ' BAR-2019 ',
        externalVariantId: ' gid://shopify/ProductVariant/45123456789 ',
        producer: 'Poderi Colla',
        vintage: '2019',
        grapeVarieties: 'Nebbiolo, , Barbera',
        region: 'Piemonte',
        denomination: 'Barolo DOCG',
        styleTags: 'tannico',
        tastingNotes: 'Rosa appassita.',
        foodPairings: 'brasato',
        alcoholPct: '14,5',
        stockQty: '24',
        productUrl: 'https://example.com/barolo',
        imageUrl: 'https://example.com/barolo.jpg',
      }),
    ).toEqual({
      ok: true,
      payload: {
        sku: 'BAR-2019',
        externalVariantId: '45123456789',
        name: 'Barolo Bussia',
        producer: 'Poderi Colla',
        vintage: 2019,
        wineType: 'red',
        grapeVarieties: ['Nebbiolo', 'Barbera'],
        region: 'Piemonte',
        denomination: 'Barolo DOCG',
        styleTags: ['tannico'],
        tastingNotes: 'Rosa appassita.',
        foodPairings: ['brasato'],
        alcoholPct: '14.50',
        priceCents: 4500,
        currency: 'EUR',
        stockStatus: 'IN_STOCK',
        stockQty: 24,
        productUrl: 'https://example.com/barolo',
        imageUrl: 'https://example.com/barolo.jpg',
      },
    });
  });

  it.each([
    ['vintage', 'ieri', 'Scrivi un anno, ad esempio 2019.'],
    ['stockQty', '-2', 'Le bottiglie non possono essere negative.'],
    ['stockQty', 'molte', 'Scrivi un numero intero di bottiglie.'],
    ['alcoholPct', '13,5555', 'Al massimo due decimali, ad esempio 13,5.'],
    ['alcoholPct', '-1', 'La gradazione non può essere negativa.'],
    ['alcoholPct', 'forte', 'Scrivi la gradazione, ad esempio 13,5.'],
  ] as const)('explains %s = %j in words', (field, text, message) => {
    const result = buildPayload({ ...REQUIRED, [field]: text });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[field]).toBe(message);
  });

  it('reports what only the shared contract refuses, in the field it is about', () => {
    const result = buildPayload({ ...REQUIRED, name: '   ', sku: 'x'.repeat(65) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.name).toBeDefined();
    expect(result.errors.sku).toBeDefined();
  });

  it('keeps the price message rather than the contract’s, for an unreadable price', () => {
    const result = buildPayload({ ...REQUIRED, price: 'gratis' });

    expect(!result.ok && result.errors.price).toBe('Scrivi solo cifre, ad esempio 12,50.');
  });
});

describe('the form', () => {
  it('submits the availability chosen in the select', () => {
    const onSubmit = vi.fn();
    render(<ProductForm initial={REQUIRED} onSubmit={onSubmit} />);

    fireEvent.input(screen.getByLabelText('Disponibilità'), { target: { value: 'OUT_OF_STOCK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ stockStatus: 'OUT_OF_STOCK' }));
  });
});

describe('the Shopify variant id', () => {
  /*
   * **Normalised here rather than at the cart** (P3-11). `/cart/add.js` accepts
   * only the numeric form, so a GID stored unnoticed produces a wine that looks
   * correctly configured on this screen and fails at the moment a visitor
   * presses *Aggiungi al carrello* — weeks later, on a shopper's screen.
   */
  it('stores a global id as the number the cart needs', () => {
    const result = buildPayload({
      ...REQUIRED,
      externalVariantId: 'gid://shopify/ProductVariant/45123456789',
    });

    expect(result.ok && result.payload.externalVariantId).toBe('45123456789');
  });

  it('refuses something that is neither, naming both formats', () => {
    const result = buildPayload({ ...REQUIRED, externalVariantId: 'barolo-bussia' });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.errors.externalVariantId).toContain(
      'gid://shopify/ProductVariant/',
    );
  });

  it('accepts an empty value, because most catalogues are not on Shopify', () => {
    const result = buildPayload({ ...REQUIRED, externalVariantId: '' });

    expect(result.ok).toBe(true);
    expect(result.ok && 'externalVariantId' in result.payload).toBe(false);
  });
});
