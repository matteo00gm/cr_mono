import { parseDelimited, type Table } from './delimited.js';
import { fieldForHeader, TEMPLATE_COLUMNS, type RawRow, type TemplateField } from './template.js';

/**
 * Clipboard paste into rows (P1-14).
 *
 * **The primary bulk path** (§2.2a): a seller selects rows in Excel, Numbers or
 * Sheets and pastes. The clipboard carries TSV, so there is no file, no upload
 * and no format negotiation — only the question of which column is which.
 *
 * **That question is answered out loud.** A first row that names template
 * fields is a header and columns are matched by name; anything else is data,
 * read in template order. A mis-detection shifts every column of every row, so
 * the result says which rule was used and the screen shows it — a seller who
 * sees "lette nell'ordine del modello" above a grid of prices in the name
 * column knows what happened, where a silent guess leaves them to work it out.
 */

export type ColumnMapping = 'by-header' | 'by-position';

export interface PastedRows {
  readonly mapping: ColumnMapping;
  readonly rows: readonly RawRow[];
  /** Header cells that named no template field, by name (by header only). */
  readonly unrecognised: readonly string[];
  /** Cells beyond the template's last column, which were dropped (by position only). */
  readonly extraColumns: number;
}

/**
 * Whether a first row is a header.
 *
 * **At least half its filled cells must name a field.** A header with a column
 * or two of the seller's own ("note interne") is still a header; a data row
 * almost never has half its cells equal to "sku", "region" or "price". One
 * filled cell that matches is enough, so a single-column paste of `name` reads
 * as the header it is.
 */
export const isHeaderRow = (cells: readonly string[]): boolean => {
  const filled = cells.filter((cell) => cell.trim() !== '');
  if (filled.length === 0) return false;

  const matched = filled.filter((cell) => fieldForHeader(cell) !== undefined).length;
  return matched * 2 >= filled.length;
};

/**
 * Cells into a row. **The first column naming a field wins**; a second column
 * with the same header is not allowed to overwrite it silently. P1-19 reports
 * duplicates by name.
 */
const toRow = (
  cells: readonly string[],
  fields: readonly (TemplateField | undefined)[],
): RawRow => {
  const row: Partial<Record<TemplateField, string>> = {};

  cells.forEach((cell, index) => {
    const field = fields[index];
    if (field !== undefined && row[field] === undefined) row[field] = cell;
  });

  return row;
};

export const rowsFromTable = (table: Table): PastedRows => {
  const [first, ...rest] = table;

  if (first === undefined) {
    return { mapping: 'by-position', rows: [], unrecognised: [], extraColumns: 0 };
  }

  if (isHeaderRow(first)) {
    const fields = first.map((cell) => fieldForHeader(cell));

    return {
      mapping: 'by-header',
      rows: rest.map((cells) => toRow(cells, fields)),
      unrecognised: first.filter(
        (cell, index) => cell.trim() !== '' && fields[index] === undefined,
      ),
      extraColumns: 0,
    };
  }

  const fields = TEMPLATE_COLUMNS.map((column) => column.field);
  const widest = table.reduce((most, cells) => Math.max(most, cells.length), 0);

  return {
    mapping: 'by-position',
    rows: table.map((cells) => toRow(cells, fields)),
    unrecognised: [],
    extraColumns: Math.max(0, widest - fields.length),
  };
};

export const parsePaste = (text: string): PastedRows => rowsFromTable(parseDelimited(text, '\t'));

export type ClipboardRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'empty' | 'html-only' };

/**
 * The text of a paste event.
 *
 * **`text/plain`, never `text/html`.** Every spreadsheet puts both on the
 * clipboard, and the plain half is TSV. HTML is a second parser with its own
 * hazards — merged cells, hidden rows, formatting as content — so a clipboard
 * that carries *only* HTML is a copy from a web page, refused with a sentence
 * saying where to copy from instead.
 */
export const readClipboard = (
  data: Pick<DataTransfer, 'getData' | 'types'> | null,
): ClipboardRead => {
  if (data === null) return { ok: false, reason: 'empty' };

  const text = data.getData('text/plain');
  if (text.trim() !== '') return { ok: true, text };

  return data.types.includes('text/html')
    ? { ok: false, reason: 'html-only' }
    : { ok: false, reason: 'empty' };
};

export const CLIPBOARD_MESSAGES: Readonly<Record<'empty' | 'html-only', string>> = {
  empty: 'Negli appunti non ci sono righe da incollare.',
  'html-only':
    'Hai copiato una pagina web. Copia le righe direttamente dal foglio di calcolo (Excel, Numbers o Fogli Google).',
};

/** Which rule placed the columns, in the words the screen shows above the rows. */
export const mappingNotice = (pasted: PastedRows): string => {
  if (pasted.mapping === 'by-header') {
    return pasted.unrecognised.length === 0
      ? 'Colonne abbinate per intestazione.'
      : `Colonne abbinate per intestazione. Colonne non riconosciute e ignorate: ${pasted.unrecognised.join(', ')}.`;
  }

  const order = TEMPLATE_COLUMNS.slice(0, 3)
    .map((column) => column.header)
    .join(', ');
  const extra =
    pasted.extraColumns === 0
      ? ''
      : ` ${String(pasted.extraColumns)} ${pasted.extraColumns === 1 ? 'colonna in più ignorata' : 'colonne in più ignorate'}.`;

  return `Nessuna intestazione riconosciuta: colonne lette nell’ordine del modello (${order}, …).${extra}`;
};
