import { describe, expect, it } from 'vitest';

import { parsePaste } from '../src/features/catalog/paste.js';
import { TEMPLATE_COLUMNS } from '../src/features/catalog/template.js';
import { EXCEL_WINDOWS, GOOGLE_SHEETS, NUMBERS_MAC } from './fixtures/clipboard.js';

/**
 * The paste hazard table (P1-15).
 *
 * **Every row here is a paste that produces plausible wrong rows rather than an
 * error** when it is handled naively: a comma that splits a name, a line break
 * that makes two wines of one, a quote that eats the rest of the clipboard. So
 * each case asserts the exact rows, not that some rows came out.
 */

const TWO_WINES = [
  { name: 'Barolo', sku: 'BAR' },
  { name: 'Etna', sku: 'ETN' },
];

describe('the hazards', () => {
  it.each([
    ['CRLF between rows (Excel on Windows)', 'name\tsku\r\nBarolo\tBAR\r\nEtna\tETN', TWO_WINES],
    ['LF between rows (Sheets, Numbers)', 'name\tsku\nBarolo\tBAR\nEtna\tETN', TWO_WINES],
    ['CR between rows (old Mac exports)', 'name\tsku\rBarolo\tBAR\rEtna\tETN', TWO_WINES],
    [
      'trailing empty rows',
      'name\tsku\r\nBarolo\tBAR\r\n\t\r\n\r\n',
      [{ name: 'Barolo', sku: 'BAR' }],
    ],
    [
      'a cell containing a comma',
      'name\tsku\nBarbaresco, Riserva\tBBR',
      [{ name: 'Barbaresco, Riserva', sku: 'BBR' }],
    ],
    [
      'a quoted cell with doubled quotes',
      'name\tsku\n"Barbaresco ""Rabajà"""\tBBR',
      [{ name: 'Barbaresco "Rabajà"', sku: 'BBR' }],
    ],
    [
      'a quote in the middle of a cell',
      'name\tsku\nMagnum 1,5" formato\tMAG',
      [{ name: 'Magnum 1,5" formato', sku: 'MAG' }],
    ],
    [
      'a line break inside a quoted cell',
      'name\ttasting_notes\nEtna\t"Frutto rosso.\nFinale sapido."',
      [{ name: 'Etna', tastingNotes: 'Frutto rosso.\nFinale sapido.' }],
    ],
    [
      'a CRLF inside a quoted cell, kept as written',
      'name\ttasting_notes\r\nEtna\t"Frutto rosso.\r\nFinale sapido."\r\n',
      [{ name: 'Etna', tastingNotes: 'Frutto rosso.\r\nFinale sapido.' }],
    ],
    ['a single cell', 'Barolo', [{ name: 'Barolo' }]],
  ])('%s', (_hazard, text, rows) => {
    expect(parsePaste(text).rows).toEqual(rows);
  });

  it('reads fewer columns than the template as the first ones, and nothing more', () => {
    const pasted = parsePaste('Barolo\tPoderi Colla');

    expect(pasted.rows).toEqual([{ name: 'Barolo', producer: 'Poderi Colla' }]);
    expect(pasted.extraColumns).toBe(0);
  });

  it('drops columns past the template, and counts them', () => {
    const cells = [
      ...TEMPLATE_COLUMNS.map((column) => `${column.header}-valore`),
      'extra 1',
      'extra 2',
    ];
    const pasted = parsePaste(cells.join('\t'));

    expect(pasted.extraColumns).toBe(2);
    expect(pasted.rows[0]?.imageUrl).toBe('image_url-valore');
    expect(Object.values(pasted.rows[0] ?? {})).not.toContain('extra 1');
  });
});

describe('clipboard text as each spreadsheet writes it', () => {
  it('Excel on Windows', () => {
    const pasted = parsePaste(EXCEL_WINDOWS);

    expect(pasted.mapping).toBe('by-header');
    expect(pasted.rows.map((row) => row.sku)).toEqual(['BAR-2019', 'BBR-2018', 'ETN-2020']);
    expect(pasted.rows[1]?.name).toBe('Barbaresco "Rabajà"');
    expect(pasted.rows[2]?.name).toBe('Etna Rosso\nContrada "Santo Spirito"');
    expect(pasted.rows[2]?.price).toBe('28,00');
  });

  it('Google Sheets', () => {
    const pasted = parsePaste(GOOGLE_SHEETS);

    expect(pasted.mapping).toBe('by-header');
    expect(pasted.rows).toEqual([
      { sku: 'BAR-2019', name: 'Barolo Bussia', price: '45.00', stockStatus: 'IN_STOCK' },
      {
        sku: 'VER-2022',
        name: 'Verdicchio\nClassico Superiore',
        price: '14.90',
        stockStatus: 'OUT_OF_STOCK',
      },
    ]);
  });

  it('Numbers, data only', () => {
    const pasted = parsePaste(NUMBERS_MAC);

    expect(pasted.mapping).toBe('by-position');
    expect(pasted.rows).toEqual([
      { name: 'Barolo Bussia', producer: 'Poderi Colla', vintage: '2019', sku: 'BAR-2019' },
      { name: 'Etna Rosso', producer: 'Tenuta delle Terre Nere', vintage: '2020', sku: 'ETN-2020' },
    ]);
  });
});

describe('size', () => {
  it('parses a five-thousand-row paste in well under a second', () => {
    /*
     * Generous on purpose: CI runners are slow and shared, and a timing
     * assertion that fails on a busy runner teaches people to ignore it. The
     * failure this exists for is quadratic work — re-scanning or re-joining
     * the text per row — which would take seconds, not a few hundred ms.
     */
    const header = TEMPLATE_COLUMNS.map((column) => column.header).join('\t');
    const row = TEMPLATE_COLUMNS.map((_, index) => `valore ${String(index)}`).join('\t');
    const text = `${header}\r\n${Array.from({ length: 5000 }, () => row).join('\r\n')}\r\n`;

    const started = performance.now();
    const pasted = parsePaste(text);
    const elapsed = performance.now() - started;

    expect(pasted.rows).toHaveLength(5000);
    expect(elapsed).toBeLessThan(1000);
  });
});
