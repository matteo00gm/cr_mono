import type * as Reader from 'read-excel-file/universal';

/**
 * XLSX, read in the browser (P1-18).
 *
 * **The reader is loaded when a workbook is opened, never at module scope.**
 * A spreadsheet parser is the largest thing the import path needs and the one
 * thing a seller who never imports a file should not download. The only import
 * of it in this file is `import type`, which the compiler erases;
 * `bundle.test.ts` fails the build that puts it in the entry chunk.
 *
 * **`read-excel-file`, not SheetJS** *(deviation)*. The npm `xlsx` package is
 * frozen at 0.18.5, carrying the prototype-pollution and ReDoS advisories fixed
 * only in versions SheetJS publishes from its own CDN, and the dependency audit
 * blocks it. A community republish would put an unofficial publisher in charge
 * of the code that parses files strangers upload. This reader is maintained,
 * MIT, and read-only — which is all an import needs, since export is CSV
 * (P1-30).
 *
 * **The `universal` entry**, which runs no Web Workers: the path the tests run
 * is the path that ships. The cost is that a very large workbook parses on the
 * main thread, which P1-27's row and size caps bound.
 */

type ReaderModule = typeof Reader;

export const loadReader = (): Promise<ReaderModule> => import('read-excel-file/universal');

export interface WorkbookSheet {
  readonly name: string;
  /** The same shape a CSV parses to, so one pipeline takes it from here. */
  readonly table: string[][];
}

export type WorkbookProblem = 'xls' | 'not-xlsx' | 'unreadable';

export type WorkbookRead =
  | { readonly ok: true; readonly sheets: readonly WorkbookSheet[] }
  | { readonly ok: false; readonly reason: WorkbookProblem };

export const WORKBOOK_MESSAGES: Readonly<Record<WorkbookProblem, string>> = {
  xls: 'Questo file è in un formato Excel che non possiamo leggere: un .xls (Excel 97-2003) oppure un .xlsx protetto da password. Aprilo in Excel e salvalo come .xlsx senza password, oppure come CSV.',
  'not-xlsx': 'Il file non è un foglio di calcolo .xlsx.',
  unreadable:
    'Il file .xlsx è danneggiato e non si può leggere. Prova a riaprirlo e a salvarlo di nuovo.',
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((byte, index) => bytes[index] === byte);

/** Every .xlsx is a zip archive. */
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/**
 * An OLE compound file: an .xls, **or an .xlsx saved with a password**, which
 * Excel wraps in the same container. Both are named in one message, because a
 * seller holding an encrypted workbook named `.xlsx` would not recognise
 * "this is an old .xls" as being about their file.
 */
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * A cell as the text the rest of the pipeline reads.
 *
 * **Numbers go through fifteen significant digits**, which is Excel's own
 * precision. A price computed by a formula is stored as `0.30000000000000004`
 * and displayed as 0,30; reading the double literally would refuse a price the
 * seller can see is fine. This does not round what they typed — it removes
 * noise Excel itself never shows.
 */
export const cellText = (cell: unknown): string => {
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') {
    return Number.isFinite(cell) ? String(Number(cell.toPrecision(15))) : '';
  }
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? '' : cell.toISOString().slice(0, 10);
  }
  return '';
};

/**
 * Reads every sheet of a workbook.
 *
 * The bytes are checked before the reader is loaded, so a CSV picked by mistake
 * or an .xls never costs the download — and each comes back as a reason the
 * screen can put into a sentence rather than as a parser's exception.
 */
export const readWorkbook = async (
  bytes: ArrayBuffer,
  load: () => Promise<ReaderModule> = loadReader,
): Promise<WorkbookRead> => {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, OLE.length));

  if (startsWith(head, OLE)) return { ok: false, reason: 'xls' };
  if (!startsWith(head, ZIP)) return { ok: false, reason: 'not-xlsx' };

  const reader = await load();

  try {
    const sheets = await reader.default(bytes);

    return {
      ok: true,
      sheets: sheets.map(({ sheet, data }) => ({
        name: sheet,
        table: data.map((row) => row.map(cellText)),
      })),
    };
  } catch {
    /*
     * A zip that is not a workbook, or a workbook with a part missing. The
     * library's messages are about XML and archive entries; none of that is
     * something a seller can act on beyond "save it again".
     */
    return { ok: false, reason: 'unreadable' };
  }
};

export type SheetChoice =
  | { readonly kind: 'chosen'; readonly sheet: WorkbookSheet }
  | { readonly kind: 'ask'; readonly names: readonly string[] };

/**
 * Which sheet to import.
 *
 * One sheet is read without asking. **Several are never guessed between**: a
 * workbook with "Vini" and "Listino vecchio" imported from whichever came first
 * is a catalogue rewritten from last year's prices. The screen asks, with the
 * names; a name it was given is used when it exists.
 */
export const chooseSheet = (sheets: readonly WorkbookSheet[], name?: string): SheetChoice => {
  const named = name === undefined ? undefined : sheets.find((sheet) => sheet.name === name);
  if (named !== undefined) return { kind: 'chosen', sheet: named };

  const [only, ...others] = sheets;
  if (only !== undefined && others.length === 0 && name === undefined) {
    return { kind: 'chosen', sheet: only };
  }

  return { kind: 'ask', names: sheets.map((sheet) => sheet.name) };
};
