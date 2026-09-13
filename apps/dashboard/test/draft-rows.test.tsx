import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import {
  draftFromRaw,
  editDraft,
  MAX_ERRORS_PER_ROW,
  stockStatusFrom,
  STOCK_WORD_MESSAGE,
  summarise,
  summaryText,
  visibleErrors,
} from '../src/features/catalog/draft-rows.js';
import { DRAFT_COLUMNS, DraftGrid, useDrafts } from '../src/features/catalog/DraftGrid.js';
import { parsePaste } from '../src/features/catalog/paste.js';
import { PRICE_MESSAGES } from '../src/features/catalog/price.js';
import type { RawRow } from '../src/features/catalog/template.js';

/**
 * Draft rows and per-cell validation (P1-22).
 *
 * The row's three assertions are the core of this: **a row with a bad price
 * shows exactly one field error, fixing it clears the error, and the summary
 * count updates.** Everything else is what makes those three true for rows
 * that arrived from a spreadsheet rather than a form.
 */

afterEach(cleanup);

const GOOD: RawRow = { name: 'Barolo Bussia', sku: 'BAR-2019', wineType: 'rosso', price: '45,00' };

describe('draftFromRaw', () => {
  it('turns a good row into the payload the API accepts', () => {
    const row = draftFromRaw({ ...GOOD, stockQty: '1.200', stockStatus: 'esaurito' }, 1);

    // `1.200` is ambiguous (P1-20), so this one is refused — see the next test for a clean one.
    expect(row.payload).toBeUndefined();
    expect(Object.keys(row.errors)).toEqual(['stockQty']);

    const clean = draftFromRaw({ ...GOOD, stockQty: '12', stockStatus: 'esaurito' }, 2);
    expect(clean.errors).toEqual({});
    expect(clean.payload).toMatchObject({
      name: 'Barolo Bussia',
      priceCents: 4500,
      currency: 'EUR',
      stockStatus: 'OUT_OF_STOCK',
      stockQty: 12,
    });
  });

  it('shows exactly one field error for a bad price', () => {
    const row = draftFromRaw({ ...GOOD, price: '1.234' }, 1);

    expect(row.errors).toEqual({ price: PRICE_MESSAGES.ambiguous });
    expect(row.payload).toBeUndefined();
  });

  it('fills an empty currency the way the form does', () => {
    expect(draftFromRaw({ ...GOOD, currency: '  ' }, 1).payload?.currency).toBe('EUR');
  });

  it('keeps the position it was given, as the id and the number shown', () => {
    expect(draftFromRaw(GOOD, 7)).toMatchObject({ id: 'draft-7', position: 7 });
  });
});

describe('editDraft', () => {
  it('clears the error when the cell is fixed, and the row becomes sendable', () => {
    const fixed = editDraft(draftFromRaw({ ...GOOD, price: '1.234' }, 1), 'price', '1234');

    expect(fixed.errors).toEqual({});
    expect(fixed.payload?.priceCents).toBe(123_400);
  });

  it('breaks a good row when a cell is broken', () => {
    const broken = editDraft(draftFromRaw(GOOD, 1), 'name', '  ');

    expect(Object.keys(broken.errors)).toEqual(['name']);
    expect(broken.payload).toBeUndefined();
  });

  it('accepts a picked availability, clearing an unrecognised word', () => {
    const row = draftFromRaw({ ...GOOD, stockStatus: 'in arrivo' }, 1);
    expect(row.errors).toEqual({ stockStatus: STOCK_WORD_MESSAGE });
    // Not sendable either: sent, it would go out as the form's default, in stock.
    expect(row.payload).toBeUndefined();

    const picked = editDraft(row, 'stockStatus', 'PREORDER');
    expect(picked.errors).toEqual({});
    expect(picked.payload?.stockStatus).toBe('PREORDER');
  });
});

describe('stockStatusFrom', () => {
  it.each([
    ['', 'IN_STOCK'],
    ['Disponibile', 'IN_STOCK'],
    ['sì', 'IN_STOCK'],
    ['IN_STOCK', 'IN_STOCK'],
    ['Esaurito', 'OUT_OF_STOCK'],
    ['non disponibile', 'OUT_OF_STOCK'],
    ['NO', 'OUT_OF_STOCK'],
    ['out of stock', 'OUT_OF_STOCK'],
    ['In prevendita', 'PREORDER'],
    ['pre-order', 'PREORDER'],
  ] as const)('reads %j as %s', (text, status) => {
    expect(stockStatusFrom(text)).toBe(status);
  });

  it('refuses a word it does not know rather than guessing in stock', () => {
    // "In arrivo" guessed as in stock is a wine recommended to people who cannot buy it.
    expect(stockStatusFrom('in arrivo')).toBeUndefined();
  });
});

describe('the summary', () => {
  it('counts valid rows and rows to fix, and words the numbers', () => {
    const rows = [draftFromRaw(GOOD, 1), draftFromRaw({ ...GOOD, price: 'x' }, 2)];

    expect(summarise(rows)).toEqual({ total: 2, valid: 1, invalid: 1 });
    expect(summaryText(summarise(rows))).toBe('2 righe · 1 valida · 1 da correggere');
    expect(summaryText({ total: 1, valid: 0, invalid: 1 })).toBe(
      '1 riga · 0 valide · 1 da correggere',
    );
  });
});

describe('visibleErrors', () => {
  it('shows at most three messages in a row and counts the rest', () => {
    const row = draftFromRaw(
      { name: '', sku: '', wineType: '', price: 'gratis', vintage: 'ieri', stockQty: '-1' },
      1,
    );
    const visible = visibleErrors(row, DRAFT_COLUMNS);
    const shown = Object.keys(visible.inCells).length + visible.elsewhere.length;

    expect(Object.keys(row.errors).length).toBeGreaterThan(MAX_ERRORS_PER_ROW);
    expect(shown).toBe(MAX_ERRORS_PER_ROW);
    expect(visible.more).toBe(Object.keys(row.errors).length - MAX_ERRORS_PER_ROW);
  });

  it('names a field the grid has no column for', () => {
    const visible = visibleErrors(draftFromRaw({ ...GOOD, vintage: '2.019' }, 1), DRAFT_COLUMNS);

    expect(visible.inCells).toEqual({});
    expect(visible.elsewhere).toEqual(['annata: Scrivi l’anno senza punti, ad esempio 2019.']);
  });
});

describe('the draft grid', () => {
  const Harness = ({ raw }: { readonly raw: readonly RawRow[] }) => {
    const { rows, edit } = useDrafts(raw);
    return <DraftGrid rows={rows} onEdit={edit} />;
  };

  it('shows the error in the cell, clears it when fixed, and updates the summary', () => {
    render(<Harness raw={[GOOD, { ...GOOD, sku: 'BAR-2020', price: '1.234' }]} />);

    expect(screen.getByRole('status').textContent).toBe('2 righe · 1 valida · 1 da correggere');
    expect(screen.getAllByText(PRICE_MESSAGES.ambiguous)).toHaveLength(1);

    const price = screen.getByRole('textbox', { name: 'prezzo, riga 2' });
    expect(price.getAttribute('aria-invalid')).toBe('true');

    fireEvent.input(price, { target: { value: '1234' } });

    expect(screen.queryByText(PRICE_MESSAGES.ambiguous)).toBeNull();
    expect(price.getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('2 righe · 2 valide · 0 da correggere');
  });

  it('lets an unrecognised availability be picked from the list', () => {
    render(<Harness raw={[{ ...GOOD, stockStatus: 'in arrivo' }]} />);

    const select = screen.getByRole('combobox', { name: 'disponibilità, riga 1' });
    expect(screen.getByText(STOCK_WORD_MESSAGE)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('1 riga · 0 valide · 1 da correggere');

    fireEvent.change(select, { target: { value: 'OUT_OF_STOCK' } });

    expect(screen.queryByText(STOCK_WORD_MESSAGE)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('1 riga · 1 valida · 0 da correggere');
  });

  it('names errors in fields without a column, and counts past the cap', () => {
    render(<Harness raw={[{ name: '', sku: '', wineType: '', price: 'x', vintage: 'ieri' }]} />);

    expect(screen.getByText(/\+\d+ altri/)).toBeTruthy();
  });

  it('marks a row that cannot be sent', () => {
    const { container } = render(<Harness raw={[{ ...GOOD, price: 'x' }, GOOD]} />);

    expect(container.querySelectorAll('.cr-grid__row--error')).toHaveLength(1);
    expect(container.querySelectorAll('.cr-grid__row--draft')).toHaveLength(1);
  });

  it('takes rows straight from a paste', () => {
    const pasted = parsePaste(
      'nome\tsku\ttipologia\tprezzo\nBarolo\tBAR\trosso\t45,00\nEtna\tETN\trosso\t12,345\n',
    );

    render(<Harness raw={pasted.rows} />);

    expect(screen.getByRole('status').textContent).toBe('2 righe · 1 valida · 1 da correggere');
  });
});
