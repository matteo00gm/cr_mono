import type { ApiClient, Product } from '@catalogorosso/api-client';

import { writeDelimited } from './delimited.js';
import { STOCK_WORD_FOR } from './draft-rows.js';
import { TEMPLATE_COLUMNS, type TemplateField } from './template.js';

/**
 * The catalogue as a CSV file (P1-30).
 *
 * **Built here from the paginated list, not streamed by a server route.** The
 * API answers in buffered mode, and a Lambda caps a buffered response at 6 MB —
 * the ceiling P1-27 found for requests — while ten thousand wines with real
 * tasting notes are more CSV than that. The list route already serves every
 * wine, a hundred at a time, to the same session; this follows its pages.
 *
 * **Written to come back unchanged.** Every cell is in the form the importer
 * reads without a guess: `.` decimals with exactly two digits, so no price is
 * ever the ambiguous `1.234` (P1-20); availability as the Italian word; lists
 * joined as the form joins them. The round-trip test is the real assertion.
 */

/** The largest page the list route serves (`MAX_LIMIT`, P1-06). */
export const EXPORT_PAGE_SIZE = 100;

const joined = (items: readonly string[] | null): string => (items ?? []).join(', ');

const decimal = (cents: number): string =>
  `${String(Math.trunc(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;

/** One field of a stored wine as the template cell the importer reads back. */
const cellOf = (product: Product, field: TemplateField): string => {
  switch (field) {
    case 'price':
      return decimal(product.priceCents);
    case 'stockStatus':
      return STOCK_WORD_FOR[product.stockStatus];
    case 'grapeVarieties':
    case 'styleTags':
    case 'foodPairings':
      return joined(product[field]);
    default: {
      const value = product[field];
      return value === null ? '' : String(value);
    }
  }
};

/**
 * The file itself: template order and headers, a byte-order mark so Excel reads
 * the accents, and `,` — with a cell quoted whenever it holds a comma, a quote
 * or a line break (`writeDelimited`).
 */
export const catalogueCsv = (products: readonly Product[]): string =>
  '\uFEFF' +
  writeDelimited(
    [
      TEMPLATE_COLUMNS.map((column) => column.header),
      ...products.map((product) => TEMPLATE_COLUMNS.map(({ field }) => cellOf(product, field))),
    ],
    ',',
  );

/** Every active wine, page after page, as the list route serves them. */
export const fetchCatalogue = async (client: ApiClient): Promise<Product[]> => {
  const products: Product[] = [];
  let cursor: string | undefined;

  do {
    // Sequential on purpose: each page's cursor comes from the one before it.
    const page = await client.request('GET /v1/dashboard/products', {
      query: { cursor, limit: EXPORT_PAGE_SIZE },
    });
    products.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return products;
};
