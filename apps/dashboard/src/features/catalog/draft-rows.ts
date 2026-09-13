import type { ProductRequest } from '@catalogorosso/api-client';

import { COLUMN_LABEL, normaliseHeader } from './header-map.js';
import {
  buildPayload,
  emptyValues,
  type FieldErrors,
  type ProductFormValues,
} from './ProductForm.js';
import { TEMPLATE_COLUMNS, type RawRow, type TemplateField } from './template.js';

/**
 * Pasted and imported rows, validated where they stand (P1-22).
 *
 * **Validated by the form's own `buildPayload`**, so a row refused here is
 * refused in the words the form would use, and a row accepted here is the
 * payload the API accepts — `productRequest` has the last word in both. A
 * second validator for bulk rows would be a price the form takes and the import
 * refuses, or the reverse.
 *
 * **Valid and invalid rows stay together.** The seller fixes three cells in the
 * grid rather than going back to the spreadsheet, and nothing is sent until the
 * summary screen (P1-23) says what will change.
 */

export type StockStatus = ProductFormValues['stockStatus'];

/**
 * What a spreadsheet's availability column says, reduced as headers are.
 *
 * `sì` and `no` are here because a column called *disponibilità* is filled
 * with them more often than with anything else. A word not listed is an error
 * on the cell, never a default: "in arrivo" guessed as in stock is a wine
 * recommended to visitors who cannot buy it.
 */
const STOCK_WORDS: Readonly<Record<string, StockStatus>> = {
  // Reduced like a header, so `IN_STOCK`, `In stock` and `in-stock` are all this key.
  'in stock': 'IN_STOCK',
  disponibile: 'IN_STOCK',
  si: 'IN_STOCK',
  'out of stock': 'OUT_OF_STOCK',
  esaurito: 'OUT_OF_STOCK',
  'non disponibile': 'OUT_OF_STOCK',
  no: 'OUT_OF_STOCK',
  preorder: 'PREORDER',
  'pre order': 'PREORDER',
  prevendita: 'PREORDER',
  'in prevendita': 'PREORDER',
};

export const STOCK_WORD_MESSAGE = 'Scrivi disponibile, esaurito oppure prevendita.';

/**
 * An availability cell as the enum, or `undefined` for a word not recognised.
 * Empty is in stock, which is what the form defaults to.
 */
export const stockStatusFrom = (text: string | undefined): StockStatus | undefined => {
  if (text === undefined || text.trim() === '') return 'IN_STOCK';
  return STOCK_WORDS[normaliseHeader(text)];
};

export interface DraftRow {
  readonly id: string;
  /** Its place in the list, from 1. */
  readonly position: number;
  readonly values: ProductFormValues;
  /** The availability word as it arrived, kept until the seller picks a value. */
  readonly stockStatusUnrecognised: boolean;
  readonly errors: FieldErrors;
  /** What will be sent, or `undefined` while the row has any error. */
  readonly payload: ProductRequest | undefined;
}

const validated = (
  base: Pick<DraftRow, 'id' | 'position' | 'values' | 'stockStatusUnrecognised'>,
): DraftRow => {
  const built = buildPayload(base.values);
  const errors: FieldErrors = {
    ...(built.ok ? {} : built.errors),
    ...(base.stockStatusUnrecognised ? { stockStatus: STOCK_WORD_MESSAGE } : {}),
  };

  return {
    ...base,
    errors,
    payload: built.ok && !base.stockStatusUnrecognised ? built.payload : undefined,
  };
};

/** A raw row into a validated draft. */
export const draftFromRaw = (raw: RawRow, position: number): DraftRow => {
  const values: ProductFormValues = { ...emptyValues() };

  for (const { field } of TEMPLATE_COLUMNS) {
    const text = raw[field];
    if (field !== 'stockStatus' && text !== undefined) values[field] = text;
  }

  // A column left empty is filled the way the form fills it.
  if (values.currency.trim() === '') values.currency = 'EUR';

  const status = stockStatusFrom(raw.stockStatus);
  if (status !== undefined) values.stockStatus = status;

  return validated({
    id: `draft-${String(position)}`,
    position,
    values,
    stockStatusUnrecognised: status === undefined,
  });
};

/** One cell changed, and the row validated again. */
export const editDraft = (row: DraftRow, field: TemplateField, text: string): DraftRow => {
  if (field === 'stockStatus') {
    const status = stockStatusFrom(text);
    return validated({
      ...row,
      values: status === undefined ? row.values : { ...row.values, stockStatus: status },
      stockStatusUnrecognised: status === undefined,
    });
  }

  return validated({ ...row, values: { ...row.values, [field]: text } });
};

export interface DraftSummary {
  readonly total: number;
  readonly valid: number;
  readonly invalid: number;
}

export const summarise = (rows: readonly DraftRow[]): DraftSummary => {
  const valid = rows.filter((row) => row.payload !== undefined).length;
  return { total: rows.length, valid, invalid: rows.length - valid };
};

export const summaryText = ({ total, valid, invalid }: DraftSummary): string =>
  `${String(total)} ${total === 1 ? 'riga' : 'righe'} · ${String(valid)} ${valid === 1 ? 'valida' : 'valide'} · ${String(invalid)} da correggere`;

/**
 * Error messages rendered per row, at most.
 *
 * A row that fails six ways — a pasted block of the wrong columns — would
 * otherwise fill its line with messages and push the values off screen. Three
 * say what is wrong; the rest are counted, and every one clears as it is fixed.
 */
export const MAX_ERRORS_PER_ROW = 3;

export interface VisibleErrors {
  /** Messages for fields the grid shows, to sit in their cells. */
  readonly inCells: FieldErrors;
  /** Messages for fields it does not, named so the seller knows where to look. */
  readonly elsewhere: readonly string[];
  /** Errors past the cap, counted rather than shown. */
  readonly more: number;
}

export const visibleErrors = (row: DraftRow, shown: readonly TemplateField[]): VisibleErrors => {
  const ordered = TEMPLATE_COLUMNS.map((column) => column.field).flatMap((field) => {
    const message = row.errors[field];
    return message === undefined ? [] : [[field, message] as const];
  });

  const inCells: FieldErrors = {};
  const elsewhere: string[] = [];

  for (const [field, message] of ordered.slice(0, MAX_ERRORS_PER_ROW)) {
    if (shown.includes(field)) inCells[field] = message;
    else elsewhere.push(`${COLUMN_LABEL[field]}: ${message}`);
  }

  return { inCells, elsewhere, more: Math.max(0, ordered.length - MAX_ERRORS_PER_ROW) };
};
