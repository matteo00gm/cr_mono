import { productRequest } from '@catalogorosso/api-client';
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
 * The product form (P1-01).
 *
 * **What a form *sends* is the part with consequences** — a dropped field is a
 * value somebody typed and lost, with nothing to explain it — so most of this
 * exercises `buildPayload` directly rather than through a rendered component,
 * which would test the rendering as much as the mapping.
 *
 * The rendered cases are the ones that are about the interface: that an invalid
 * price stops the submit and says so where a screen reader will find it, and
 * that the two pieces of load-bearing help text are actually on the page.
 */

afterEach(cleanup);

const filled = (overrides: Partial<ProductFormValues> = {}): ProductFormValues => ({
  ...emptyValues(),
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  price: '12,50',
  currency: 'EUR',
  ...overrides,
});

describe('buildPayload', () => {
  it('produces the payload the API accepts', () => {
    const result = buildPayload(
      filled({
        producer: 'Poderi Colla',
        vintage: '2019',
        grapeVarieties: 'Nebbiolo, Barbera',
        region: 'Piemonte',
        foodPairings: 'brasato al Barolo, formaggi stagionati',
        alcoholPct: '14.50',
        stockQty: '24',
      }),
    );

    expect(result).toEqual({
      ok: true,
      payload: {
        sku: 'BAR-2019',
        name: 'Barolo Bussia',
        wineType: 'red',
        producer: 'Poderi Colla',
        vintage: 2019,
        grapeVarieties: ['Nebbiolo', 'Barbera'],
        region: 'Piemonte',
        foodPairings: ['brasato al Barolo', 'formaggi stagionati'],
        alcoholPct: '14.50',
        priceCents: 1250,
        currency: 'EUR',
        stockStatus: 'IN_STOCK',
        stockQty: 24,
      },
    });
  });

  it('turns 12,50 into 1250 minor units', () => {
    const result = buildPayload(filled({ price: '12,50' }));

    expect(result.ok && result.payload.priceCents).toBe(1250);
  });

  it('sends nothing at all for a field left empty', () => {
    /*
     * An empty input is "not filled in", not "an empty string". Sending `''`
     * would store a producer whose name is nothing, which reads as data and
     * sorts and filters as data.
     */
    const result = buildPayload(filled());

    expect(result.ok && result.payload).not.toHaveProperty('producer');
    expect(result.ok && result.payload).not.toHaveProperty('tastingNotes');
  });

  it('drops empty entries a trailing comma leaves behind', () => {
    const result = buildPayload(filled({ grapeVarieties: 'Nebbiolo, , Barbera,' }));

    expect(result.ok && result.payload.grapeVarieties).toEqual(['Nebbiolo', 'Barbera']);
  });

  it('never sends a field the server owns', () => {
    /*
     * The form has no input for `status`, `embeddingState` or `contentHash`,
     * and the contract has no field for them either (P1-01 widened
     * `PRODUCT_SERVER_OWNED`). Asserted because the failure is invisible: a
     * `status` that got through would archive a wine without deleting its
     * vectors, leaving it hidden from the seller and still recommended.
     */
    const result = buildPayload(filled());

    for (const owned of ['status', 'embeddingState', 'contentHash', 'tenantId', 'id']) {
      expect(result.ok && result.payload).not.toHaveProperty(owned);
    }
  });

  it('produces something the shared contract accepts', () => {
    /*
     * The form validates with `productRequest` and the server validates with
     * the derived contract, which `apps/api/test/product-contracts.test.ts`
     * pins field-for-field against it. This closes the loop from this side.
     */
    const result = buildPayload(filled());

    expect(result.ok && productRequest.safeParse(result.payload).success).toBe(true);
  });
});

describe('what the form refuses', () => {
  it.each([
    ['a price that is not a number', { price: 'gratis' }, 'price'],
    ['a price with three decimals', { price: '12,5051' }, 'price'],
    ['an ambiguous price', { price: '1.234' }, 'price'],
    ['a negative price', { price: '-5' }, 'price'],
    ['a missing name', { name: '' }, 'name'],
    ['a missing sku', { sku: '' }, 'sku'],
    ['a vintage that is not a year', { vintage: 'vecchio' }, 'vintage'],
    ['a fractional bottle count', { stockQty: '2,5' }, 'stockQty'],
  ])('refuses %s and blames the right field', (_case, overrides, field) => {
    const result = buildPayload(filled(overrides));

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : Object.keys(result.errors)).toContain(field);
  });

  it('explains the ambiguous price by saying what to write instead', () => {
    /*
     * A message reporting a rule — "1.234 is ambiguous" — is a fact about
     * parsing. Telling somebody to write `1234` or `1.234,00` is an instruction
     * they can follow without knowing why, which is what a form owes them.
     */
    const result = buildPayload(filled({ price: '1.234' }));

    expect(result.ok ? '' : (result.errors.price ?? '')).toContain('1.234,00');
  });
});

describe('valuesFrom', () => {
  it('round-trips a stored product back into the form and out again', () => {
    /*
     * The edit path: a wine opened and saved unedited must produce the payload
     * it started from. A price shown in one convention and parsed in another is
     * how a value drifts on every save.
     */
    const stored = {
      sku: 'BAR-2019',
      name: 'Barolo Bussia',
      wineType: 'red',
      priceCents: 1250,
      currency: 'EUR',
      stockStatus: 'IN_STOCK' as const,
      grapeVarieties: ['Nebbiolo'],
      vintage: 2019,
    };

    const result = buildPayload(valuesFrom(stored));

    expect(result.ok && result.payload).toMatchObject(stored);
  });
});

describe('the rendered form', () => {
  it('submits the payload when everything is valid', () => {
    const onSubmit = vi.fn();
    render(<ProductForm initial={filled()} onSubmit={onSubmit} />);

    fireEvent.submit(screen.getByRole('button', { name: 'Salva' }).closest('form') as HTMLElement);

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ priceCents: 1250 }));
  });

  it('shows a field error for an invalid price and does not submit', () => {
    const onSubmit = vi.fn();
    render(<ProductForm initial={filled({ price: 'gratis' })} onSubmit={onSubmit} />);

    fireEvent.submit(screen.getByRole('button', { name: 'Salva' }).closest('form') as HTMLElement);

    expect(onSubmit).not.toHaveBeenCalled();

    /*
     * `role="alert"` and `aria-invalid`, because a red border is not an error
     * message to somebody using a screen reader — and this is a form whose
     * whole job is being filled in correctly.
     */
    expect(screen.getByRole('alert').textContent).toMatch(/cifre/i);
    expect(screen.getByLabelText(/Prezzo/).getAttribute('aria-invalid')).toBe('true');
  });

  it('clears the error as soon as the field is edited', () => {
    /*
     * Leaving it visible while somebody fixes the value tells them their
     * correction did not work.
     */
    render(<ProductForm initial={filled({ price: 'gratis' })} onSubmit={vi.fn()} />);

    fireEvent.submit(screen.getByRole('button', { name: 'Salva' }).closest('form') as HTMLElement);
    expect(screen.queryByRole('alert')).not.toBeNull();

    fireEvent.input(screen.getByLabelText(/Prezzo/), { target: { value: '12,50' } });

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tells a seller where Shopify keeps the variant id', () => {
    /*
     * **Help text that is part of the feature.** Without this id the cart
     * adapter cannot add the wine to a cart (§1.6), so a missing one is a
     * recommendation that dead-ends at the checkout — and nobody finds the
     * field by guessing where Shopify keeps it.
     */
    render(<ProductForm onSubmit={vi.fn()} />);

    const help = screen.getByText(/Varianti/);
    expect(help.textContent).toMatch(/carrello/i);
  });

  it('tells a seller why specific pairings matter', () => {
    /*
     * The second piece of load-bearing copy. "Carne" matches almost any
     * question and distinguishes nothing; the seller is the only person who
     * knows the specific answer, and the only reason to write it is being told
     * why it helps.
     */
    render(<ProductForm onSubmit={vi.fn()} />);

    expect(screen.getByText(/brasato al Barolo/).textContent).toMatch(/consigli/i);
  });

  it('groups the fields the way the template groups them', () => {
    render(<ProductForm onSubmit={vi.fn()} />);

    /*
     * Sommelier is a section rather than a handful of optional extras at the
     * bottom of Commerce, and the grouping is what says so: it is the part that
     * decides how well a wine can be recommended.
     */
    for (const legend of ['Identità', 'Classificazione', 'Sommelier', 'Commercio']) {
      expect(screen.getByText(legend)).toBeTruthy();
    }
  });
});
