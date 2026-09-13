/**
 * Delimited text into rows of cells (P1-14, reused by P1-16).
 *
 * **One RFC-4180 reader for a paste and for a CSV file**, differing only in the
 * delimiter. Both arrive with the same hazards — a cell containing the
 * delimiter, a cell containing a line break, a quote inside a quoted cell — and
 * `split('\t')` gets every one of them wrong in a way that still produces
 * plausible rows: a tasting note with a line break becomes two wines.
 *
 * The rules, as spreadsheets write them:
 *
 * - A cell that **starts** with `"` is quoted. Inside it the delimiter and line
 *   breaks are text, and `""` is one quote. A quote anywhere else is a
 *   character, so `12" bottle` survives.
 * - Rows end at `\r\n`, `\n` or `\r` — Windows Excel, everything else, and old
 *   Mac exports respectively.
 * - **Trailing empty rows are dropped.** Excel ends a copied range with a line
 *   break and spreadsheets pad exports with blank lines; neither is a wine.
 */

export type Table = readonly (readonly string[])[];

const read = (
  text: string,
  delimiter: string,
  quotes: boolean,
): { rows: string[][]; open: boolean } => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let atCellStart = true;

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (quoted) {
      if (char !== '"') {
        cell += char;
      } else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = false;
        /*
         * A closing quote has to end its cell. When it does not — `"Riserva"
         * Speciale`, which a spreadsheet may leave unquoted because the cell
         * has no tab or line break in it — the opening quote began a *word*,
         * not a cell, and both quotes are the seller's to keep.
         */
        const next = text[index + 1];
        if (next !== undefined && next !== delimiter && next !== '\r' && next !== '\n') {
          cell = `"${cell}"`;
        }
      }
      continue;
    }

    if (quotes && char === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
      atCellStart = true;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      atCellStart = true;
    } else {
      cell += char;
      atCellStart = false;
    }
  }

  // A last row with no line break after it.
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return { rows, open: quoted };
};

/**
 * Parses delimited text.
 *
 * **An unclosed quote makes the whole text literal** rather than swallowing
 * every row after it into one cell. A spreadsheet never writes one — it doubles
 * a quote a seller typed — so it means text pasted from somewhere that is not a
 * spreadsheet, where a stray `"` is a character. Reading it as the start of a
 * cell would turn a hundred rows into one wine with a very long name.
 */
export const parseDelimited = (text: string, delimiter: string): string[][] => {
  const quotedRead = read(text, delimiter, true);
  const { rows } = quotedRead.open ? read(text, delimiter, false) : quotedRead;

  while (rows.length > 0 && (rows.at(-1) ?? []).every((cell) => cell.trim() === '')) {
    rows.pop();
  }

  return rows;
};
