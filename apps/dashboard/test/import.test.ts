import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  importProblemMessage,
  MAX_FILE_BYTES,
  MAX_ROWS,
  readImportFile,
  type ImportResult,
} from '../src/features/catalog/import-file.js';

/**
 * The file hazard table, end to end (P1-21).
 *
 * **Every row of §2.2a's hazard table, from bytes on disk to rows.** Each has a
 * real file in `fixtures/`, marked binary so its bytes cannot be normalised —
 * except the two sizes, which are generated here: ten thousand identical rows
 * and ten megabytes of nothing are better described by the line that makes them
 * than by a file nobody will open.
 */

/* Same-realm buffer; see `xlsx.test.ts` for why a Node Buffer's is refused. */
const bytesOf = (name: string): ArrayBuffer =>
  Uint8Array.from(readFileSync(join(import.meta.dirname, 'fixtures', name))).buffer;

const text = (body: string): ArrayBuffer => Uint8Array.from(new TextEncoder().encode(body)).buffer;

const importing = (
  name: string,
  over: { encoding?: 'utf-8' | 'windows-1252'; sheet?: string } = {},
) => readImportFile({ name, bytes: bytesOf(name), ...over });

const rowsOf = (result: ImportResult) => {
  if (!result.ok) throw new Error(`refused: ${importProblemMessage(result.problem)}`);
  return result.imported.rows;
};

const BAROLO = { name: 'Barolo Bussia', sku: 'BAR-2019', wineType: 'rosso', price: '45,00' };

describe('the §2.2a hazards', () => {
  it('reads a semicolon file, as Italian Excel writes one', async () => {
    const result = await importing('import-semicolon.csv');

    expect(rowsOf(result)).toEqual([BAROLO]);
    expect(result.ok && result.imported.notices).toEqual([
      'Codifica rilevata: UTF-8.',
      'Separatore rilevato: punto e virgola.',
    ]);
  });

  it('reads a comma file', async () => {
    expect(rowsOf(await importing('import-comma.csv'))).toEqual([
      { name: 'Barolo Bussia', sku: 'BAR-2019', wineType: 'red', price: '45.00' },
    ]);
  });

  it('reads a tab-separated file', async () => {
    const result = await importing('import-tab.csv');

    expect(rowsOf(result)).toEqual([{ ...BAROLO, wineType: 'red' }]);
    expect(result.ok && result.imported.notices).toContain('Separatore rilevato: tabulazione.');
  });

  it('reads past a UTF-8 byte-order mark, so the first header still matches', async () => {
    expect(rowsOf(await importing('import-bom.csv'))).toEqual([BAROLO]);
  });

  it('decodes Italian Excel’s Windows-1252, accents intact', async () => {
    const result = await importing('import-cp1252.csv');

    expect(rowsOf(result)[0]?.tastingNotes).toBe('Viola, liquirizia, finale più lungo');
    expect(result.ok && result.imported.notices[0]).toMatch(/^Codifica rilevata: Windows-1252/);
  });

  it('keeps a quoted comma inside its cell', async () => {
    expect(rowsOf(await importing('import-quoted-comma.csv'))[0]?.name).toBe('Barbaresco, Riserva');
  });

  it('keeps a line break inside a quoted cell, as one wine', async () => {
    const rows = rowsOf(await importing('import-embedded-newline.csv'));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tastingNotes).toBe('Frutto rosso.\nFinale sapido.');
  });

  it('refuses a file missing a required column, and names it', async () => {
    const result = await importing('import-missing-header.csv');

    expect(result).toMatchObject({ ok: false, problem: { kind: 'headers' } });
    expect(!result.ok && importProblemMessage(result.problem)).toBe(
      'Mancano colonne obbligatorie: prezzo.',
    );
  });

  it('imports past an extra column, and says it was ignored', async () => {
    const result = await importing('import-extra-header.csv');

    expect(rowsOf(result)).toEqual([BAROLO]);
    expect(result.ok && result.imported.notices).toContain(
      'Colonne non riconosciute e ignorate: scaffale.',
    );
  });

  it('refuses an empty file', async () => {
    const result = await importing('import-empty.csv');

    expect(result).toMatchObject({ ok: false, problem: { kind: 'empty' } });
    expect(!result.ok && importProblemMessage(result.problem)).toBe('Il file è vuoto.');
  });

  it('refuses a file with only a header', async () => {
    const result = await importing('import-header-only.csv');

    expect(result).toMatchObject({ ok: false, problem: { kind: 'header-only' } });
    expect(!result.ok && importProblemMessage(result.problem)).toMatch(/solo l’intestazione/);
  });
});

describe('the caps', () => {
  const header = 'nome;sku;tipologia;prezzo\n';
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => `Vino;SKU-${String(index)};rosso;9,90`).join('\n');

  it('takes exactly the row cap', async () => {
    const result = await readImportFile({ name: 'cap.csv', bytes: text(header + rows(MAX_ROWS)) });

    expect(rowsOf(result)).toHaveLength(MAX_ROWS);
  });

  it('refuses one row more, whole — never the first ten thousand of it', async () => {
    const result = await readImportFile({
      name: 'cap.csv',
      bytes: text(header + rows(MAX_ROWS + 1)),
    });

    expect(result).toMatchObject({ ok: false, problem: { kind: 'too-many-rows', rows: 10_001 } });
    expect(!result.ok && importProblemMessage(result.problem)).toBe(
      'Il file contiene 10.001 vini, oltre il massimo di 10.000 per importazione. Dividilo in più file.',
    );
  });

  it('refuses a file over the size cap before reading any of it', async () => {
    const result = await readImportFile({
      name: 'enorme.csv',
      bytes: new Uint8Array(MAX_FILE_BYTES + 1).buffer,
    });

    expect(result).toMatchObject({ ok: false, problem: { kind: 'too-large' } });
    // Refused before decoding, so there is nothing to have detected.
    expect(!result.ok && result.notices).toEqual([]);
    expect(!result.ok && importProblemMessage(result.problem)).toMatch(/oltre il massimo di 10 MB/);
  });
});

describe('the rest of the pipeline', () => {
  it('skips a blank line in the middle of a file', async () => {
    const result = await readImportFile({
      name: 'buchi.csv',
      bytes: text('nome;sku;tipologia;prezzo\nA;1;rosso;1\n;;;\nB;2;rosso;2\n'),
    });

    expect(rowsOf(result).map((row) => row.name)).toEqual(['A', 'B']);
  });

  it('decodes with the encoding the seller chose instead of the detected one', async () => {
    const result = await importing('import-cp1252.csv', { encoding: 'utf-8' });

    expect(rowsOf(result)[0]?.tastingNotes).toContain('\uFFFD');
    expect(result.ok && result.imported.notices[0]).toBe('Codifica scelta: UTF-8.');
  });

  it('asks which sheet when a workbook has several', async () => {
    const result = await importing('wines.xlsx');

    expect(result).toMatchObject({
      ok: false,
      problem: { kind: 'choose-sheet', names: ['Vini', 'Note'] },
    });
    expect(!result.ok && importProblemMessage(result.problem)).toBe(
      'Il file contiene più fogli (Vini, Note): scegli quale importare.',
    );
  });

  it('reads the chosen sheet through the same header check as a CSV', async () => {
    // `wines.xlsx` has no type column: the workbook path refuses it exactly as a CSV would.
    const result = await importing('wines.xlsx', { sheet: 'Vini' });

    expect(!result.ok && importProblemMessage(result.problem)).toBe(
      'Mancano colonne obbligatorie: tipologia.',
    );
  });

  it('names an .xls rather than trying to read it', async () => {
    const result = await readImportFile({ name: 'listino.xls', bytes: bytesOf('legacy.xls') });

    expect(result).toMatchObject({ ok: false, problem: { kind: 'workbook', reason: 'xls' } });
  });

  it('refuses a CSV renamed .xlsx, by its bytes', async () => {
    const result = await readImportFile({ name: 'finto.xlsx', bytes: bytesOf('import-comma.csv') });

    expect(result).toMatchObject({ ok: false, problem: { kind: 'workbook', reason: 'not-xlsx' } });
  });

  it('refuses a file that is neither CSV nor a workbook', async () => {
    const result = await readImportFile({ name: 'catalogo.pdf', bytes: text('%PDF-1.7') });

    expect(result).toMatchObject({ ok: false, problem: { kind: 'unsupported' } });
    expect(!result.ok && importProblemMessage(result.problem)).toMatch(/CSV oppure Excel/);
  });

  it('reads a CSV whose extension is in capitals', async () => {
    expect(
      rowsOf(await readImportFile({ name: 'LISTINO.CSV', bytes: bytesOf('import-comma.csv') })),
    ).toHaveLength(1);
  });

  it('words every refusal', () => {
    expect(importProblemMessage({ kind: 'workbook', reason: 'unreadable' })).toMatch(/danneggiato/);
  });
});
