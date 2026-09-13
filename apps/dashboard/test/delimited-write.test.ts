import { describe, expect, it } from 'vitest';

import { parseDelimited, writeDelimited } from '../src/features/catalog/delimited.js';

/**
 * Writing a table back as delimited text (P1-23, and P1-30's export after it).
 *
 * Held to `parseDelimited` by round trip, because a writer and a reader that
 * each look right alone are how a file the dashboard hands a seller fails to
 * import back into the same dashboard.
 */

describe('writeDelimited', () => {
  it('round-trips the cells a spreadsheet makes hard', () => {
    const table = [
      ['name', 'notes', 'price'],
      ['Barolo; Riserva', 'Rosa "appassita"', '45,00'],
      ['Etna', 'due\nrighe', ''],
      ['"Riserva" Speciale', 'semplice', '12'],
    ];

    expect(parseDelimited(writeDelimited(table, ';'), ';')).toEqual(table);
  });

  it('quotes only the cells that need it, doubling a quote inside', () => {
    expect(writeDelimited([['a', 'b;c', 'd"e']], ';')).toBe('a;"b;c";"d""e"');
  });

  it('quotes a line break and a carriage return, which would otherwise end the row', () => {
    expect(writeDelimited([['a\nb', 'c\rd']], ',')).toBe('"a\nb","c\rd"');
  });

  it('ends rows in CRLF, as spreadsheets write them', () => {
    expect(writeDelimited([['a'], ['b']], ',')).toBe('a\r\nb');
  });
});
