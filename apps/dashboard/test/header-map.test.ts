import { describe, expect, it } from 'vitest';

import {
  COLUMN_LABEL,
  headerProblems,
  headersBlockImport,
  mapHeaders,
  matchHeader,
  normaliseHeader,
  REQUIRED_COLUMNS,
  SYNONYMS,
} from '../src/features/catalog/header-map.js';
import { emptyValues } from '../src/features/catalog/ProductForm.js';
import { TEMPLATE_COLUMNS } from '../src/features/catalog/template.js';

/**
 * Header matching (P1-19).
 *
 * **What is refused matters more than what is matched.** A header matched to
 * the wrong field is a column of prices imported as names; a required column
 * silently absent is a file of wines with no price. So the refusals — missing,
 * duplicated — are asserted as carefully as the matches.
 */

const HEADER = ['Nome', 'SKU', 'Tipologia', 'Prezzo'];

describe('matchHeader', () => {
  it.each([
    ['Produttore ', 'producer'],
    ['PREZZO', 'price'],
    ['Prezzo (€)', 'price'],
    ['Quantità', 'stockQty'],
    ['stock_qty', 'stockQty'],
    ['Note di degustazione', 'tastingNotes'],
    ['Gradazione alcolica %', 'alcoholPct'],
    ['Disponibilità', 'stockStatus'],
    ['  Annata:', 'vintage'],
    ['wine-type', 'wineType'],
    // An accent inside a word must not split it in two. At the end of a word
    // the punctuation rule happens to absorb it; in the middle it would not.
    ['Vitìgni', 'grapeVarieties'],
  ] as const)('reads %j as %s', (cell, field) => {
    expect(matchHeader(cell)).toBe(field);
  });

  it.each(['scaffale', 'costo', 'stato', 'note interne', ''])('matches nothing for %j', (cell) => {
    expect(matchHeader(cell)).toBeUndefined();
  });

  it('matches every template header to its own field', () => {
    for (const column of TEMPLATE_COLUMNS) {
      expect(matchHeader(column.header), column.header).toBe(column.field);
    }
  });

  it('never lets one name mean two fields', () => {
    /*
     * The lookup is a Map, and a second entry for the same name would replace
     * the first without a word — a synonym list that quietly re-pointed "note"
     * from tasting notes to something else. So the names are checked for
     * collisions before they ever reach it.
     */
    const seen = new Map<string, string>();

    for (const column of TEMPLATE_COLUMNS) {
      for (const name of [column.header, ...SYNONYMS[column.field]]) {
        const key = normaliseHeader(name);
        const earlier = seen.get(key);
        expect(
          earlier === undefined || earlier === column.field,
          `${key}: ${String(earlier)} and ${column.field}`,
        ).toBe(true);
        seen.set(key, column.field);
      }
    }
  });
});

describe('mapHeaders', () => {
  it('maps a clean header, and blocks nothing', () => {
    const map = mapHeaders([...HEADER, 'Produttore']);

    expect(map.fields).toEqual(['name', 'sku', 'wineType', 'price', 'producer']);
    expect(headersBlockImport(map)).toBe(false);
    expect(headerProblems(map)).toEqual([]);
  });

  it('reports an unknown column by name rather than dropping it silently', () => {
    const map = mapHeaders([...HEADER, 'Scaffale']);

    expect(map.unrecognised).toEqual(['Scaffale']);
    expect(map.fields[4]).toBeUndefined();
    // Ignored, and said to be — but not a reason to refuse the file.
    expect(headersBlockImport(map)).toBe(false);
    expect(headerProblems(map)).toEqual(['Colonne non riconosciute e ignorate: Scaffale.']);
  });

  it('blocks the import when a required column is missing, and names it', () => {
    const map = mapHeaders(['Nome', 'SKU', 'Tipologia', 'Produttore']);

    expect(map.missingRequired).toEqual(['price']);
    expect(headersBlockImport(map)).toBe(true);
    expect(headerProblems(map)).toEqual(['Mancano colonne obbligatorie: prezzo.']);
  });

  it('blocks the import when two columns mean the same field, quoting both', () => {
    const map = mapHeaders([...HEADER, 'price']);

    expect(map.duplicates).toEqual([{ field: 'price', headers: ['Prezzo', 'price'] }]);
    expect(headersBlockImport(map)).toBe(true);
    expect(headerProblems(map)).toEqual([
      'Più colonne indicano prezzo (Prezzo, price): lasciane una sola.',
    ]);
  });

  it('lists blocking problems before the ones it only mentions', () => {
    const problems = headerProblems(mapHeaders(['Nome', 'Nome vino', 'Scaffale']));

    expect(problems[0]).toMatch(/^Mancano colonne obbligatorie: SKU, tipologia, prezzo\.$/);
    expect(problems[1]).toMatch(/^Più colonne indicano nome/);
    expect(problems[2]).toMatch(/^Colonne non riconosciute/);
  });

  it('ignores empty header cells rather than calling them unrecognised', () => {
    expect(mapHeaders([...HEADER, '', '  ']).unrecognised).toEqual([]);
  });
});

describe('the required columns', () => {
  it('are exactly the fields the form has no default for', () => {
    /*
     * The rule, tied to the form so the two cannot drift: a column may be
     * absent from a file when the form would fill the field in anyway.
     */
    const defaults = emptyValues();

    for (const field of REQUIRED_COLUMNS) expect(defaults[field], field).toBe('');
    expect(defaults.currency).not.toBe('');
    expect(defaults.stockStatus).not.toBe('');
  });

  it('each have a label to be named by', () => {
    for (const column of TEMPLATE_COLUMNS) expect(COLUMN_LABEL[column.field]).not.toBe('');
  });
});
