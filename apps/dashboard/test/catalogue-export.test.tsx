import { ApiError, type Product } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  catalogueCsv,
  EXPORT_PAGE_SIZE,
  fetchCatalogue,
} from '../src/features/catalog/catalogue-export.js';
import { CatalogScreen } from '../src/features/catalog/CatalogScreen.js';
import { draftFromRaw } from '../src/features/catalog/draft-rows.js';
import { importProblemMessage, readImportFile } from '../src/features/catalog/import-file.js';
import { TEMPLATE_COLUMNS } from '../src/features/catalog/template.js';
import { fakeClient, listOf } from './support/client.js';
import { wine } from './support/wine.js';

/**
 * The catalogue export (P1-30).
 *
 * **The round trip is the assertion.** A file exported and imported again must
 * change nothing, and that one test holds P1-16's delimiter detection, P1-17's
 * byte-order mark, P1-19's headers, P1-20's numbers and P1-22's drafts to the
 * file this writes — the whole import path, against its own output.
 */

afterEach(cleanup);

const LIST = 'GET /v1/dashboard/products';

const bytes = (body: string): ArrayBuffer => Uint8Array.from(new TextEncoder().encode(body)).buffer;

/** A catalogue carrying every field, and the cells that make a round trip hard. */
const CATALOGUE: Product[] = [
  wine({
    id: 'a',
    sku: 'BAR-2019',
    externalVariantId: '4321567890',
    name: 'Barolo "Bussia", Riserva',
    producer: 'Poderi Colla',
    vintage: 2019,
    wineType: 'red',
    grapeVarieties: ['Nebbiolo'],
    region: 'Piemonte',
    denomination: 'Barolo DOCG',
    styleTags: ['strutturato', 'tannico'],
    tastingNotes: 'Rosa appassita, catrame;\nciliegia sotto spirito.',
    foodPairings: ['brasato al Barolo', 'tajarin al tartufo'],
    alcoholPct: '14.50',
    priceCents: 123450,
    currency: 'EUR',
    stockStatus: 'IN_STOCK',
    stockQty: 1200,
    productUrl: 'https://cantina.example/barolo',
    imageUrl: 'https://cantina.example/barolo.jpg',
  }),
  wine({
    id: 'b',
    sku: 'ETN-2020',
    name: 'Etna Rosso',
    vintage: null,
    alcoholPct: '13.00',
    priceCents: 5,
    stockStatus: 'OUT_OF_STOCK',
    stockQty: 0,
  }),
  wine({
    id: 'c',
    sku: 'FRA-NV',
    name: 'Franciacorta Brut',
    wineType: 'sparkling',
    priceCents: 1000000,
    stockStatus: 'PREORDER',
  }),
];

/**
 * The fields P1-24 compares to call a row unchanged, null and absent alike.
 *
 * Restated because the dashboard cannot import `packages/db`; the server's own
 * list, `WRITTEN_FIELDS`, is pinned by its guard test in `products-upsert.test.ts`.
 */
const WRITTEN = [
  'sku',
  'externalVariantId',
  'name',
  'producer',
  'vintage',
  'wineType',
  'grapeVarieties',
  'region',
  'denomination',
  'styleTags',
  'tastingNotes',
  'foodPairings',
  'alcoholPct',
  'priceCents',
  'currency',
  'stockStatus',
  'stockQty',
  'productUrl',
  'imageUrl',
] as const;

const written = (source: Partial<Record<(typeof WRITTEN)[number], unknown>>) =>
  Object.fromEntries(WRITTEN.map((field) => [field, source[field] ?? null]));

const importedBack = async (csv: string) => {
  const result = await readImportFile({ name: 'catalogo.csv', bytes: bytes(csv) });
  if (!result.ok) throw new Error(`refused: ${importProblemMessage(result.problem)}`);
  return result.imported.rows.map((row, index) => draftFromRaw(row, index + 1));
};

describe('the file', () => {
  it('imports back with every wine unchanged', async () => {
    const drafts = await importedBack(catalogueCsv(CATALOGUE));

    expect(drafts.map((draft) => draft.errors)).toEqual(CATALOGUE.map(() => ({})));
    expect(drafts.map((draft) => written(draft.payload ?? {}))).toEqual(
      CATALOGUE.map((product) => written(product)),
    );
  });

  it('writes the template’s columns in order, after a byte-order mark, separated by commas', () => {
    const csv = catalogueCsv([]);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.slice(1)).toBe(TEMPLATE_COLUMNS.map((column) => column.header).join(','));
  });

  it('writes every price with a dot and exactly two decimals', () => {
    const at = TEMPLATE_COLUMNS.findIndex((column) => column.field === 'price');
    const [, ...rows] = catalogueCsv([
      wine({ priceCents: 123450 }),
      wine({ priceCents: 5 }),
      wine({ priceCents: 1000000 }),
    ])
      .slice(1)
      .split('\r\n');

    expect(rows.map((row) => row.split(',')[at])).toEqual(['1234.50', '0.05', '10000.00']);
  });
});

describe('fetching the catalogue', () => {
  it('follows every page, at the largest size the list serves', async () => {
    const { client, request } = fakeClient({
      [LIST]: (init) =>
        Promise.resolve(
          init?.query?.cursor === undefined
            ? listOf([wine({ id: 'a' })], { nextCursor: 'page-2' })
            : listOf([wine({ id: 'b' })]),
        ),
    });

    const products = await fetchCatalogue(client);

    expect(EXPORT_PAGE_SIZE).toBe(100);
    expect(products.map((product) => product.id)).toEqual(['a', 'b']);
    expect(request.mock.calls.map(([, init]) => init?.query)).toEqual([
      { cursor: undefined, limit: EXPORT_PAGE_SIZE },
      { cursor: 'page-2', limit: EXPORT_PAGE_SIZE },
    ]);
  });
});

describe('the export button', () => {
  it('saves the whole catalogue as catalogo.csv', async () => {
    const saveFile = vi.fn<(text: string, filename: string) => void>();
    const { client } = fakeClient({
      [LIST]: () => Promise.resolve(listOf([wine({ id: 'a', name: 'Barolo Bussia' })])),
    });

    render(<CatalogScreen client={client} saveFile={saveFile} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Esporta CSV' }));

    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledTimes(1);
    });
    const [text, filename] = saveFile.mock.calls[0] ?? [];
    expect(filename).toBe('catalogo.csv');
    expect(text).toContain('Barolo Bussia');
  });

  it('says the export failed, quoting the request id, and saves nothing', async () => {
    const saveFile = vi.fn<(text: string, filename: string) => void>();
    const { client } = fakeClient({
      [LIST]: (init) =>
        !('q' in (init?.query ?? {}))
          ? Promise.reject(new ApiError(500, 'internal', 'boom', 'req-9'))
          : Promise.resolve(listOf([wine()])),
    });

    render(<CatalogScreen client={client} saveFile={saveFile} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Esporta CSV' }));

    expect(await screen.findByText(/Esportazione del catalogo non riuscita.*req-9/)).toBeTruthy();
    expect(saveFile).not.toHaveBeenCalled();
  });
});
