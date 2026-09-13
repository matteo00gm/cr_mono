import { delimiterNotice, parseCsv } from './csv.js';
import type { Table } from './delimited.js';
import { decodeFile, encodingNotice, type Encoding } from './encoding.js';
import { headerProblems, headersBlockImport, mapHeaders, type HeaderMap } from './header-map.js';
import type { RawRow, TemplateField } from './template.js';
import { chooseSheet, readWorkbook, WORKBOOK_MESSAGES, type WorkbookProblem } from './xlsx.js';

/**
 * A chosen file, from its bytes to rows (P1-21).
 *
 * **One pipeline, as §2.2a draws it**: bytes are decoded (P1-17) and split
 * (P1-16), or read as a workbook (P1-18), then matched against the template
 * (P1-19) and capped — and what comes out is the same `RawRow[]` a paste
 * produces, for the draft grid to validate (P1-22). No earlier row owned the
 * composition, so it lands with the test that exercises it end to end
 * *(deviation)*.
 *
 * **Everything that can refuse a file does so with a reason, before a single
 * row is shown.** A file that half-imports — the first ten thousand rows of a
 * longer one, a sheet picked without asking — looks complete, and that is the
 * failure worth designing against.
 */

/**
 * §2.2a's row cap. P1-27 holds the server to the same number; this one answers
 * before anything is sent, and before a grid tries to render the rows.
 */
export const MAX_ROWS = 10_000;

/**
 * The file-size cap. Ten thousand wines with long tasting notes are a few
 * megabytes of CSV; ten is room for that, and refuses a file that could only
 * be something else — a photo, an export of a whole shop.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type ImportProblem =
  | { readonly kind: 'empty' }
  | { readonly kind: 'header-only' }
  | { readonly kind: 'too-large'; readonly bytes: number }
  | { readonly kind: 'too-many-rows'; readonly rows: number }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'workbook'; readonly reason: WorkbookProblem }
  | { readonly kind: 'choose-sheet'; readonly names: readonly string[] }
  | { readonly kind: 'headers'; readonly problems: readonly string[] };

export interface ImportedRows {
  readonly rows: readonly RawRow[];
  readonly headers: HeaderMap;
  /** What was detected, said to the seller: encoding, delimiter, ignored columns. */
  readonly notices: readonly string[];
}

export type ImportResult =
  | { readonly ok: true; readonly imported: ImportedRows }
  | {
      readonly ok: false;
      readonly problem: ImportProblem;
      /** Kept on refusal too: "Codifica rilevata" is how a seller explains a header that did not match. */
      readonly notices: readonly string[];
    };

export interface ImportFile {
  readonly name: string;
  readonly bytes: ArrayBuffer;
  /** The seller's choice, when the preview showed the detected one was wrong (P1-17). */
  readonly encoding?: Encoding | undefined;
  /** The sheet the seller picked, when the workbook has more than one (P1-18). */
  readonly sheet?: string | undefined;
}

type TableRead =
  | { readonly ok: true; readonly table: Table }
  | { readonly ok: false; readonly problem: ImportProblem };

const extensionOf = (name: string): string => name.toLowerCase().split('.').at(-1) ?? '';

/**
 * **Dispatched on the extension the seller's file carries**, not on sniffed
 * content. The file picker offers `.csv` and `.xlsx`, and the extension is the
 * choice the seller made; `readWorkbook` still checks the bytes, so a CSV
 * renamed `.xlsx` is refused rather than misread.
 */
const tableOf = async (file: ImportFile, notices: string[]): Promise<TableRead> => {
  const extension = extensionOf(file.name);

  if (extension === 'xlsx') {
    const workbook = await readWorkbook(file.bytes);
    if (!workbook.ok) return { ok: false, problem: { kind: 'workbook', reason: workbook.reason } };

    const choice = chooseSheet(workbook.sheets, file.sheet);
    return choice.kind === 'ask'
      ? { ok: false, problem: { kind: 'choose-sheet', names: choice.names } }
      : { ok: true, table: choice.sheet.table };
  }

  if (extension === 'xls') return { ok: false, problem: { kind: 'workbook', reason: 'xls' } };

  if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
    const decoded = decodeFile(file.bytes, file.encoding);
    const csv = parseCsv(decoded.text);
    notices.push(encodingNotice(decoded), delimiterNotice(csv.delimiter));
    return { ok: true, table: csv.table };
  }

  return { ok: false, problem: { kind: 'unsupported' } };
};

const blank = (cells: readonly string[]): boolean => cells.every((cell) => cell.trim() === '');

const rowFrom = (cells: readonly string[], fields: HeaderMap['fields']): RawRow => {
  const row: Partial<Record<TemplateField, string>> = {};

  cells.forEach((cell, index) => {
    const field = fields[index];
    if (field !== undefined) row[field] = cell;
  });

  return row;
};

export const readImportFile = async (file: ImportFile): Promise<ImportResult> => {
  const notices: string[] = [];
  const refuse = (problem: ImportProblem): ImportResult => ({ ok: false, problem, notices });

  if (file.bytes.byteLength === 0) return refuse({ kind: 'empty' });
  if (file.bytes.byteLength > MAX_FILE_BYTES) {
    return refuse({ kind: 'too-large', bytes: file.bytes.byteLength });
  }

  const read = await tableOf(file, notices);
  if (!read.ok) return refuse(read.problem);

  const [header, ...body] = read.table;
  if (header === undefined || blank(header)) return refuse({ kind: 'empty' });

  const headers = mapHeaders(header);
  if (headersBlockImport(headers)) {
    return refuse({ kind: 'headers', problems: headerProblems(headers) });
  }
  // Not blocking, so only the "ignored" sentence can be in here — and it is said.
  notices.push(...headerProblems(headers));

  /*
   * A blank line in the middle of a file is not a wine. Skipping it is not a
   * guess: every cell is empty, so there is nothing in it to have misread.
   */
  const data = body.filter((cells) => !blank(cells));

  if (data.length === 0) return refuse({ kind: 'header-only' });

  /*
   * **The whole file is refused, not truncated.** Importing the first ten
   * thousand rows of a longer file leaves a catalogue that looks complete and
   * is not, and nothing afterwards points at the rows that were never read.
   */
  if (data.length > MAX_ROWS) return refuse({ kind: 'too-many-rows', rows: data.length });

  return {
    ok: true,
    imported: { rows: data.map((cells) => rowFrom(cells, headers.fields)), headers, notices },
  };
};

const thousands = new Intl.NumberFormat('it-IT');

const megabytes = (bytes: number): string =>
  (bytes / 1024 / 1024).toLocaleString('it-IT', { maximumFractionDigits: 1 });

/** A refusal, in the sentence the import screen shows. */
export const importProblemMessage = (problem: ImportProblem): string => {
  switch (problem.kind) {
    case 'empty':
      return 'Il file è vuoto.';
    case 'header-only':
      return 'Il file contiene solo l’intestazione: non ci sono vini da importare.';
    case 'too-large':
      return `Il file pesa ${megabytes(problem.bytes)} MB, oltre il massimo di ${megabytes(MAX_FILE_BYTES)} MB. Dividilo in più file.`;
    case 'too-many-rows':
      return `Il file contiene ${thousands.format(problem.rows)} vini, oltre il massimo di ${thousands.format(MAX_ROWS)} per importazione. Dividilo in più file.`;
    case 'unsupported':
      return 'Importa un file CSV oppure Excel (.xlsx).';
    case 'workbook':
      return WORKBOOK_MESSAGES[problem.reason];
    case 'choose-sheet':
      return `Il file contiene più fogli (${problem.names.join(', ')}): scegli quale importare.`;
    case 'headers':
      return problem.problems.join(' ');
  }
};
