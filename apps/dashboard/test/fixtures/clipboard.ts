/**
 * Clipboard text as spreadsheets put it there (P1-15).
 *
 * **Reconstructed from each application's clipboard format, not captured from
 * a real copy.** The row asks for strings copied out of Excel and Sheets and
 * checked in verbatim, and that remains the better fixture: a reconstruction
 * encodes what we believe the application writes, and the hazards that matter
 * are the ones nobody believed. Replacing these with captures is an open item
 * in `plan-v1.md`.
 *
 * Written with escapes rather than raw control characters, so git's line-ending
 * normalisation (`.gitattributes` sets `eol=lf`) cannot rewrite a CRLF fixture
 * into an LF one — which would leave the CRLF case passing on a string that no
 * longer contains a CRLF.
 */

/**
 * Excel for Windows. CRLF after every row, the last included. A cell holding a
 * line break is quoted and its own quotes doubled; a cell holding only a quote
 * is written as it is.
 */
export const EXCEL_WINDOWS = [
  'name\tproducer\tvintage\tsku\tprice\r\n',
  'Barolo Bussia\tPoderi Colla\t2019\tBAR-2019\t45,00\r\n',
  'Barbaresco "Rabajà"\tProduttori del Barbaresco\t2018\tBBR-2018\t32,50\r\n',
  '"Etna Rosso\nContrada ""Santo Spirito"""\tTenuta delle Terre Nere\t2020\tETN-2020\t28,00\r\n',
].join('');

/** Google Sheets. LF between rows and none after the last; multi-line cells quoted. */
export const GOOGLE_SHEETS = [
  'sku\tname\tprice\tstock_status\n',
  'BAR-2019\tBarolo Bussia\t45.00\tIN_STOCK\n',
  'VER-2022\t"Verdicchio\nClassico Superiore"\t14.90\tOUT_OF_STOCK',
].join('');

/** Numbers on macOS, data only — a seller who selected the rows without the header. */
export const NUMBERS_MAC = [
  'Barolo Bussia\tPoderi Colla\t2019\tBAR-2019\n',
  'Etna Rosso\tTenuta delle Terre Nere\t2020\tETN-2020\n',
].join('');
