import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { parseCsv } from '../src/features/catalog/csv.js';
import {
  cellText,
  chooseSheet,
  loadReader,
  readWorkbook,
  WORKBOOK_MESSAGES,
  type WorkbookSheet,
} from '../src/features/catalog/xlsx.js';

/**
 * Reading XLSX (P1-18).
 *
 * **The row's acceptance test is that a workbook and the equivalent CSV
 * produce identical rows**, because from there they share one pipeline — any
 * difference would be a class of wine that imports one way from Excel and
 * another way from a CSV of the same sheet.
 */

/*
 * Copied into a buffer made by *this* realm's `Uint8Array`. The reader checks
 * `input instanceof ArrayBuffer`, and under the jsdom environment a Node
 * `Buffer`'s backing store belongs to a different realm — so it is refused as
 * the wrong type and reads as unreadable. A browser's `file.arrayBuffer()` has
 * no such split; this is a test-environment detail, not a production one.
 */
const fixture = (name: string): ArrayBuffer =>
  Uint8Array.from(readFileSync(join(import.meta.dirname, 'fixtures', name))).buffer;

const sheetNamed = (sheets: readonly WorkbookSheet[], name: string): WorkbookSheet => {
  const choice = chooseSheet(sheets, name);
  if (choice.kind !== 'chosen') throw new Error(`no sheet named ${name}`);
  return choice.sheet;
};

describe('readWorkbook', () => {
  it('produces the rows the equivalent CSV does', async () => {
    const read = await readWorkbook(fixture('wines.xlsx'));
    if (!read.ok) throw new Error(`could not read the fixture: ${read.reason}`);

    const csv = parseCsv(new TextDecoder().decode(fixture('wines.csv')));

    expect(sheetNamed(read.sheets, 'Vini').table).toEqual(csv.table);
  });

  it('reads every sheet, by name', async () => {
    const read = await readWorkbook(fixture('wines.xlsx'));
    if (!read.ok) throw new Error(read.reason);

    expect(read.sheets.map((sheet) => sheet.name)).toEqual(['Vini', 'Note']);
    expect(sheetNamed(read.sheets, 'Note').table).toEqual([['Appunti', 'non importare']]);
  });

  it('refuses a CSV picked by mistake without loading the reader', async () => {
    const load = vi.fn(loadReader);

    expect(await readWorkbook(fixture('wines.csv'), load)).toEqual({
      ok: false,
      reason: 'not-xlsx',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('names an .xls, or a password-protected workbook, without loading the reader', async () => {
    const load = vi.fn(loadReader);

    expect(await readWorkbook(fixture('legacy.xls'), load)).toEqual({ ok: false, reason: 'xls' });
    expect(load).not.toHaveBeenCalled();
    expect(WORKBOOK_MESSAGES.xls).toMatch(/password/);
    expect(WORKBOOK_MESSAGES.xls).toMatch(/CSV/);
  });

  it('reports a broken archive as unreadable rather than throwing', async () => {
    expect(await readWorkbook(fixture('broken.xlsx'))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses an empty file', async () => {
    expect(await readWorkbook(new ArrayBuffer(0))).toEqual({ ok: false, reason: 'not-xlsx' });
  });
});

describe('cellText', () => {
  it.each([
    ['a string', 'Barolo', 'Barolo'],
    ['a whole number', 2019, '2019'],
    ['a decimal', 32.5, '32.5'],
    ['a formula’s floating-point noise, as Excel displays it', 0.1 + 0.2, '0.3'],
    ['a true boolean', true, 'true'],
    ['a false boolean', false, 'false'],
    ['a date, as the day', new Date('2026-09-01T00:00:00.000Z'), '2026-09-01'],
    ['an invalid date', new Date('nope'), ''],
    ['an empty cell', null, ''],
    ['infinity', Number.POSITIVE_INFINITY, ''],
    ['anything else', { unexpected: true }, ''],
  ])('%s', (_case, cell, text) => {
    expect(cellText(cell)).toBe(text);
  });
});

describe('chooseSheet', () => {
  const vini: WorkbookSheet = { name: 'Vini', table: [['name']] };
  const vecchio: WorkbookSheet = { name: 'Listino vecchio', table: [['name']] };

  it('reads the only sheet without asking', () => {
    expect(chooseSheet([vini])).toEqual({ kind: 'chosen', sheet: vini });
  });

  it('asks when there are several, rather than taking the first', () => {
    expect(chooseSheet([vini, vecchio])).toEqual({
      kind: 'ask',
      names: ['Vini', 'Listino vecchio'],
    });
  });

  it('uses the sheet it was told to', () => {
    expect(chooseSheet([vini, vecchio], 'Listino vecchio')).toEqual({
      kind: 'chosen',
      sheet: vecchio,
    });
  });

  it('asks again when the named sheet is not there, even if there is only one', () => {
    expect(chooseSheet([vini], 'Listino 2024')).toEqual({ kind: 'ask', names: ['Vini'] });
  });
});

describe('the reader stays out of the module graph', () => {
  it('is only ever imported as a type, or loaded on demand', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'features', 'catalog', 'xlsx.ts'),
      'utf8',
    );
    const staticImports = source.match(/^import\s+(?!type\b)[^;]*read-excel-file[^;]*;/gm) ?? [];

    expect(staticImports).toEqual([]);
    expect(source).toContain("import('read-excel-file/universal')");
  });
});
