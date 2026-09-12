import { parseDelimited } from './delimited.js';

/**
 * A CSV file's text into rows (P1-16).
 *
 * **Parsed in the browser**, which is the §2.2a decision: no upload endpoint,
 * no staging, and the rows land in the same draft grid a paste does. The reader
 * is P1-14's — one RFC-4180 state machine for a clipboard and a file — so what
 * is new here is only the question a paste never has: which character
 * separates the cells.
 *
 * **Not `papaparse`** *(deviation)*. The row reaches for it to avoid
 * hand-rolling RFC-4180, but P1-14 already had to: a paste needs quoted cells
 * with line breaks in them just as a file does. A second parser for files would
 * be two answers to "what is a cell", and the row's own instruction — assert
 * the delimiter rather than trust auto-detection — is the one piece of the
 * library that would not have been used.
 */

export type Delimiter = ';' | ',' | '\t';

/**
 * The candidates, in the order a tie is broken.
 *
 * **Semicolon first**, because Italian Excel writes it — a comma is the
 * decimal separator there, so a spreadsheet in that locale cannot use one
 * between cells. A header that contains both, the same number of times and
 * outside quotes, is one no spreadsheet writes; resolving it towards the
 * market this product sells in is the least surprising wrong answer.
 */
export const DELIMITERS: readonly Delimiter[] = [';', ',', '\t'];

export const DELIMITER_LABEL: Readonly<Record<Delimiter, string>> = {
  ';': 'punto e virgola',
  ',': 'virgola',
  '\t': 'tabulazione',
};

const BOM = '\uFEFF';

/**
 * Drops a UTF-8 byte-order mark.
 *
 * **Not cosmetic.** Excel's "CSV UTF-8" export starts with one, and left in
 * place it becomes the first character of the first header — so `name` is
 * `\uFEFFname`, matches nothing, and the column a seller can see is reported as
 * unrecognised with a name that looks identical to the one expected.
 */
export const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text);

/**
 * Which delimiter the header line uses.
 *
 * **Counted in the header line only, and only outside quotes.** Data rows are
 * where commas live — "Barbaresco, Riserva", "12,50" — and a header quoted
 * around a semicolon is still a comma-separated header. A header with none of
 * the three is a single column, read as a comma file.
 */
export const sniffDelimiter = (text: string): Delimiter => {
  const counts: Record<Delimiter, number> = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === '\n' || char === '\r')) {
      break;
    } else if (!quoted && (char === ';' || char === ',' || char === '\t')) {
      counts[char] += 1;
    }
  }

  const best = DELIMITERS.reduce((winner, candidate) =>
    counts[candidate] > counts[winner] ? candidate : winner,
  );

  return counts[best] === 0 ? ',' : best;
};

export interface CsvTable {
  readonly delimiter: Delimiter;
  readonly table: string[][];
}

export const parseCsv = (text: string): CsvTable => {
  const clean = stripBom(text);
  const delimiter = sniffDelimiter(clean);

  return { delimiter, table: parseDelimited(clean, delimiter) };
};

/**
 * The detected delimiter, as the screen says it. A wrong guess turns every row
 * into one cell, and this sentence is how a seller connects that to its cause.
 */
export const delimiterNotice = (delimiter: Delimiter): string =>
  `Separatore rilevato: ${DELIMITER_LABEL[delimiter]}.`;
