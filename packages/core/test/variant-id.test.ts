import { describe, expect, it } from 'vitest';

import { readVariantId, VARIANT_ID_EXPECTED } from '../src/shopify/variant-id.js';

/**
 * The Shopify variant id, in whichever shape a seller pasted (P3-11).
 *
 * **The failure this prevents is invisible until a shopper hits it.** A GID
 * stored unnoticed produces a wine that looks correctly configured in the
 * console, passes every import check, and fails at the moment a visitor presses
 * *Aggiungi al carrello* — weeks later, on somebody else's storefront, with
 * nothing connecting it back to the import that caused it.
 */

describe('what a seller may paste', () => {
  it('accepts the numeric form, which is what a CSV export gives', () => {
    expect(readVariantId('45123456789')).toEqual({ ok: true, id: '45123456789' });
  });

  it('strips a GraphQL global id down to the number', () => {
    /* The admin API and newer exports emit this. `/cart/add.js` does not take it. */
    expect(readVariantId('gid://shopify/ProductVariant/45123456789')).toEqual({
      ok: true,
      id: '45123456789',
    });
  });

  it('trims what a spreadsheet cell carries around it', () => {
    expect(readVariantId('  45123456789  ')).toEqual({ ok: true, id: '45123456789' });
  });

  it('treats an empty value as nothing to do', () => {
    /* Most catalogues are not on Shopify. A blank column must not fail every
     * row of an import. */
    expect(readVariantId('')).toBeUndefined();
    expect(readVariantId('   ')).toBeUndefined();
    expect(readVariantId(null)).toBeUndefined();
    expect(readVariantId(undefined)).toBeUndefined();
  });
});

describe('what a seller pastes by mistake', () => {
  it.each([
    'barolo-bussia-2016',
    'SKU-001',
    'gid://shopify/Product/45123456789',
    'gid://shopify/ProductVariant/abc',
    '45123456789/',
    '45,123,456,789',
    '4.5e10',
  ])('refuses %s', (value) => {
    expect(readVariantId(value)).toEqual({ ok: false, message: VARIANT_ID_EXPECTED });
  });

  it('names both accepted formats, because "non valido" tells nobody anything', () => {
    // A seller who pasted a SKU has to be told what to paste instead.
    expect(VARIANT_ID_EXPECTED).toContain('45123456789');
    expect(VARIANT_ID_EXPECTED).toContain('gid://shopify/ProductVariant/');
  });

  it('refuses a GID for a product rather than a variant', () => {
    /* The two differ by one word and a seller copying from the admin URL bar
     * gets the product one. It is accepted by nothing downstream. */
    expect(readVariantId('gid://shopify/Product/1')).toMatchObject({ ok: false });
  });
});
