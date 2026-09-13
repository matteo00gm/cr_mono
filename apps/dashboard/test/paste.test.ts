import { describe, expect, it } from 'vitest';

import { parseDelimited } from '../src/features/catalog/delimited.js';
import {
  CLIPBOARD_MESSAGES,
  isHeaderRow,
  mappingNotice,
  parsePaste,
  readClipboard,
} from '../src/features/catalog/paste.js';
import { emptyValues } from '../src/features/catalog/ProductForm.js';
import { fieldForHeader, TEMPLATE_COLUMNS } from '../src/features/catalog/template.js';

/**
 * The paste handler (P1-14).
 *
 * The hazard table — clipboard strings as Excel and Sheets write them, and a
 * five-thousand-row paste — is P1-15's. What is here is the handler's own
 * contract: which rule places the columns, and that it says which.
 */

const clipboard = (items: Readonly<Record<string, string>>) => ({
  types: Object.keys(items),
  getData: (type: string) => items[type] ?? '',
});

describe('the template', () => {
  it('names every field the form holds, exactly once', () => {
    /*
     * A form field missing here is a column a seller cannot paste into; one
     * listed twice is a paste that fills it from whichever column came last.
     */
    const fields = TEMPLATE_COLUMNS.map((column) => column.field);

    expect([...fields].sort()).toEqual(Object.keys(emptyValues()).sort());
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('matches a header regardless of case, surrounding space or separator', () => {
    expect(fieldForHeader(' SKU ')).toBe('sku');
    expect(fieldForHeader('Wine Type')).toBe('wineType');
    expect(fieldForHeader('stock-qty')).toBe('stockQty');
    expect(fieldForHeader('note interne')).toBeUndefined();
  });
});

describe('parseDelimited', () => {
  it('splits rows on every line ending a spreadsheet writes', () => {
    expect(parseDelimited('a\tb\r\nc\td\ne\tf\rg\th', '\t')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]);
  });

  it('keeps a delimiter, a line break and a doubled quote inside a quoted cell', () => {
    expect(parseDelimited('"a\tb"\t"riga uno\nriga due"\t"12"" bottiglia"\r\n', '\t')).toEqual([
      ['a\tb', 'riga uno\nriga due', '12" bottiglia'],
    ]);
  });

  it('treats a quote in the middle of a cell as a character', () => {
    expect(parseDelimited('Magnum 1,5" formato\tx', '\t')).toEqual([['Magnum 1,5" formato', 'x']]);
  });

  it('does not open a quoted cell on a quote that is not at its start', () => {
    expect(parseDelimited('12" bottiglia\t"x"', '\t')).toEqual([['12" bottiglia', 'x']]);
  });

  it('keeps the quotes of a word that merely starts the cell', () => {
    // A closing quote that does not end the cell was never a cell quote.
    expect(parseDelimited('"Riserva" Speciale\tx', '\t')).toEqual([['"Riserva" Speciale', 'x']]);
  });

  it('drops the empty rows a copied range ends with', () => {
    expect(parseDelimited('a\tb\r\n\t\r\n\r\n', '\t')).toEqual([['a', 'b']]);
  });

  it('reads an unclosed quote literally rather than swallowing every row after it', () => {
    expect(parseDelimited('"Riserva\tx\nsecondo\ty', '\t')).toEqual([
      ['"Riserva', 'x'],
      ['secondo', 'y'],
    ]);
  });

  it('keeps empty cells, so a column is not shifted by a blank one', () => {
    expect(parseDelimited('a\t\tc', '\t')).toEqual([['a', '', 'c']]);
  });
});

describe('column mapping', () => {
  it('matches columns by header when the first row names fields, in any order', () => {
    const pasted = parsePaste('price\tname\tnote interne\n12,50\tBarolo\tscaffale 3\n');

    expect(pasted.mapping).toBe('by-header');
    expect(pasted.rows).toEqual([{ price: '12,50', name: 'Barolo' }]);
    expect(pasted.unrecognised).toEqual(['note interne']);
  });

  it('reads a first row of data in template order', () => {
    const pasted = parsePaste('Barolo Bussia\tPoderi Colla\t2019\tBAR-2019\n');

    expect(pasted.mapping).toBe('by-position');
    expect(pasted.rows).toEqual([
      { name: 'Barolo Bussia', producer: 'Poderi Colla', vintage: '2019', sku: 'BAR-2019' },
    ]);
  });

  it('counts the columns past the template it had to drop', () => {
    const cells = Array.from(
      { length: TEMPLATE_COLUMNS.length + 2 },
      (_, index) => `c${String(index)}`,
    );

    expect(parsePaste(cells.join('\t')).extraColumns).toBe(2);
  });

  it('never lets a second column with the same header overwrite the first', () => {
    expect(parsePaste('name\tname\nPrimo\tSecondo').rows).toEqual([{ name: 'Primo' }]);
  });

  it('decides a header by whether half the filled cells name a field', () => {
    expect(isHeaderRow(['name', 'note interne'])).toBe(true);
    expect(isHeaderRow(['name', 'x', 'y'])).toBe(false);
    expect(isHeaderRow(['', '  '])).toBe(false);
  });

  it('returns nothing for an empty paste', () => {
    expect(parsePaste('\r\n\r\n')).toEqual({
      mapping: 'by-position',
      rows: [],
      unrecognised: [],
      extraColumns: 0,
    });
  });
});

describe('the clipboard', () => {
  it('takes the plain text a spreadsheet puts beside its HTML', () => {
    expect(readClipboard(clipboard({ 'text/html': '<table/>', 'text/plain': 'a\tb' }))).toEqual({
      ok: true,
      text: 'a\tb',
    });
  });

  it('refuses a copy that carries only HTML, and says where to copy from', () => {
    expect(readClipboard(clipboard({ 'text/html': '<table/>' }))).toEqual({
      ok: false,
      reason: 'html-only',
    });
    expect(CLIPBOARD_MESSAGES['html-only']).toMatch(/foglio di calcolo/);
  });

  it('reports an empty clipboard as empty', () => {
    expect(readClipboard(null)).toEqual({ ok: false, reason: 'empty' });
    expect(readClipboard(clipboard({ 'text/plain': '  ' }))).toEqual({
      ok: false,
      reason: 'empty',
    });
  });
});

describe('the notice', () => {
  it('says columns were matched by header, and names what it ignored', () => {
    expect(mappingNotice(parsePaste('name\tprice\n'))).toBe('Colonne abbinate per intestazione.');
    expect(mappingNotice(parsePaste('name\tscaffale\n'))).toContain('scaffale');
  });

  it('says columns were read in template order, and how many it dropped', () => {
    const one = Array.from({ length: TEMPLATE_COLUMNS.length + 1 }, () => 'x').join('\t');
    const two = Array.from({ length: TEMPLATE_COLUMNS.length + 2 }, () => 'x').join('\t');

    expect(mappingNotice(parsePaste('Barolo\n'))).toMatch(
      /ordine del modello \(name, producer, vintage/,
    );
    expect(mappingNotice(parsePaste(one))).toMatch(/1 colonna in più ignorata\.$/);
    expect(mappingNotice(parsePaste(two))).toMatch(/2 colonne in più ignorate\.$/);
  });
});
