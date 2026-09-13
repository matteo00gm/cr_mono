import { describe, expect, it } from 'vitest';

import {
  delimiterNotice,
  parseCsv,
  sniffDelimiter,
  stripBom,
} from '../src/features/catalog/csv.js';

/**
 * The CSV reader (P1-16).
 *
 * The delimiter is the part that goes wrong silently — a wrong guess yields one
 * cell per row, which looks like a file with one very wide column rather than an
 * error — so it is asserted directly rather than trusted to the parse working
 * out. The file-to-rows hazard table is P1-21's.
 */

describe('sniffDelimiter', () => {
  it.each([
    [
      'a semicolon header, as Italian Excel writes it',
      'name;producer;price\nBarolo;Colla;12,50',
      ';',
    ],
    ['a comma header', 'name,producer,price\nBarolo,Colla,12.50', ','],
    ['a tab header', 'name\tproducer\tprice\nBarolo\tColla\t12,50', '\t'],
  ])('reads %s', (_case, text, delimiter) => {
    expect(sniffDelimiter(text)).toBe(delimiter);
  });

  it('counts only the header line, where the data rows are full of commas', () => {
    /*
     * Two semicolons in the header. The rows below carry more unquoted commas
     * than that — decimals and prose — which is exactly what a sniffer reading
     * past the first line would count, and it would then call this a comma file.
     */
    const text = [
      'name;price;notes',
      'Barbaresco;12,50;fresco, sapido, lungo, minerale',
      'Verdicchio;9,90;agrumi, mandorla, sale, erbe',
    ].join('\n');

    expect(sniffDelimiter(text)).toBe(';');
  });

  it('ignores a delimiter inside a quoted header cell', () => {
    // Two semicolons inside the quotes, one comma outside them: a sniffer that
    // ignored quotes would count this as a semicolon file.
    expect(sniffDelimiter('"nome;produttore;annata",price\n')).toBe(',');
  });

  it('breaks a tie towards the semicolon', () => {
    expect(sniffDelimiter('a;b,c\n')).toBe(';');
  });

  it('reads a header with no delimiter at all as a single comma column', () => {
    expect(sniffDelimiter('name\nBarolo\n')).toBe(',');
  });
});

describe('stripBom', () => {
  it('removes the mark Excel’s UTF-8 export starts with, and nothing else', () => {
    expect(stripBom('\uFEFFname;sku')).toBe('name;sku');
    expect(stripBom('name;sku')).toBe('name;sku');
    expect(stripBom('a\uFEFF')).toBe('a\uFEFF');
  });
});

describe('parseCsv', () => {
  it('parses with the delimiter it detected, after dropping the BOM', () => {
    const { delimiter, table } = parseCsv('\uFEFFname;sku\r\n"Barbaresco; Riserva";BBR\r\n');

    expect(delimiter).toBe(';');
    // The first header is `name`, not `\uFEFFname` — which would look identical and match nothing.
    expect(table).toEqual([
      ['name', 'sku'],
      ['Barbaresco; Riserva', 'BBR'],
    ]);
  });

  it('keeps a comma inside a quoted cell of a comma file', () => {
    expect(parseCsv('name,sku\n"Barbaresco, Riserva",BBR').table).toEqual([
      ['name', 'sku'],
      ['Barbaresco, Riserva', 'BBR'],
    ]);
  });
});

describe('delimiterNotice', () => {
  it.each([
    [';', 'Separatore rilevato: punto e virgola.'],
    [',', 'Separatore rilevato: virgola.'],
    ['\t', 'Separatore rilevato: tabulazione.'],
  ] as const)('names %j in words', (delimiter, words) => {
    expect(delimiterNotice(delimiter)).toBe(words);
  });
});
