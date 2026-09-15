import { MAX_IMPORT_BODY_BYTES, MAX_IMPORT_ROWS } from '@catalogorosso/core/import-limits';
import { describe, expect, it } from 'vitest';

import { importBodyProblem } from '../src/features/catalog/draft-rows.js';
import { parsePaste, pasteCapProblem } from '../src/features/catalog/paste.js';

/**
 * The import caps on the dashboard's side (P1-27).
 *
 * A file's caps are tested with the rest of the file pipeline in
 * `import.test.ts`. What is here: a paste meets the same row cap a file does,
 * and a request is measured in bytes before it is sent.
 */

const paste = (rows: number) =>
  parsePaste(
    [
      'nome\tsku\ttipologia\tprezzo',
      ...Array.from({ length: rows }, (_, index) => `Vino\tSKU-${String(index)}\trosso\t9,90`),
    ].join('\n'),
  );

describe('a paste', () => {
  it('takes exactly the row cap', () => {
    const pasted = paste(MAX_IMPORT_ROWS);

    expect(pasted.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(pasteCapProblem(pasted)).toBeNull();
  });

  it('refuses one row more, whole, naming the limit and how to proceed', () => {
    expect(pasteCapProblem(paste(MAX_IMPORT_ROWS + 1))).toBe(
      // Italian groups digits only from five, so 2501 and 2500 carry no separator.
      'Hai incollato 2501 vini, oltre il massimo di 2500 per importazione. Incollali in più volte.',
    );
  });
});

describe('a request', () => {
  it('fits when its JSON is within the cap', () => {
    expect(importBodyProblem([{ sku: 'BAR-2019', name: 'Barolo Bussia' }])).toBeNull();
  });

  it('is refused before sending when its JSON is over the cap, naming the limit', () => {
    const problem = importBodyProblem([
      { sku: 'BAR-2019', tastingNotes: 'x'.repeat(MAX_IMPORT_BODY_BYTES) },
    ]);

    expect(problem).toMatch(/oltre i 5 MB/);
    expect(problem).toMatch(/Dividile in più importazioni/);
  });

  it('counts bytes rather than characters, so accented notes cannot slip under it', () => {
    // Each "è" is two bytes: counted as characters, these notes would fit.
    const notes = 'è'.repeat(MAX_IMPORT_BODY_BYTES / 2);

    expect(importBodyProblem([{ sku: 'BAR-2019', tastingNotes: notes }])).not.toBeNull();
  });
});
