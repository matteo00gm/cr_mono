import type { ProductFormValues } from './ProductForm.js';

/**
 * The product template, as columns (P1-14, §2.2).
 *
 * **One order, used everywhere a table of wines leaves or enters the
 * dashboard**: a paste with no header is read in it, the CSV export writes it
 * (P1-30), and the downloadable template is it. A second list would be a paste
 * that shifts every column for one seller and not another.
 *
 * Keyed by the *form's* fields rather than the table's columns, deliberately.
 * A pasted or imported row is text a person typed into a spreadsheet — the same
 * thing the form holds — so a draft row validates through `buildPayload`
 * exactly as a form submission does (P1-22), with the same messages, and there
 * is no second mapping from "12,50" to cents to keep in step.
 */

export type TemplateField = keyof ProductFormValues;

export interface TemplateColumn {
  readonly field: TemplateField;
  /**
   * The header the template and the export write.
   *
   * `price`, not §2.2's `price_cents`: the cell holds euros as a seller writes
   * them, "12,50", and a header saying cents invites somebody to type 1250.
   */
  readonly header: string;
}

export const TEMPLATE_COLUMNS: readonly TemplateColumn[] = [
  { field: 'name', header: 'name' },
  { field: 'producer', header: 'producer' },
  { field: 'vintage', header: 'vintage' },
  { field: 'sku', header: 'sku' },
  { field: 'externalVariantId', header: 'external_variant_id' },
  { field: 'wineType', header: 'wine_type' },
  { field: 'grapeVarieties', header: 'grape_varieties' },
  { field: 'region', header: 'region' },
  { field: 'denomination', header: 'denomination' },
  { field: 'styleTags', header: 'style_tags' },
  { field: 'tastingNotes', header: 'tasting_notes' },
  { field: 'foodPairings', header: 'food_pairings' },
  { field: 'alcoholPct', header: 'alcohol_pct' },
  { field: 'price', header: 'price' },
  { field: 'currency', header: 'currency' },
  { field: 'stockStatus', header: 'stock_status' },
  { field: 'stockQty', header: 'stock_qty' },
  { field: 'productUrl', header: 'product_url' },
  { field: 'imageUrl', header: 'image_url' },
];

/** A row as a paste or a file delivers it: text per template field, nothing parsed yet. */
export type RawRow = Partial<Record<TemplateField, string>>;

/**
 * A header cell, reduced to what identifies it.
 *
 * Deliberately minimal here: case, surrounding space, and space or dash in
 * place of underscore. Accents, punctuation and Italian synonyms are P1-19's,
 * which replaces this with matching that reports what it could not place.
 */
export const normaliseHeader = (cell: string): string =>
  cell
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_');

const BY_HEADER = new Map(TEMPLATE_COLUMNS.map((column) => [column.header, column.field]));

export const fieldForHeader = (cell: string): TemplateField | undefined =>
  BY_HEADER.get(normaliseHeader(cell));
