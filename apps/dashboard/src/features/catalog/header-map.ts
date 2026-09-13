import { TEMPLATE_COLUMNS, type TemplateField } from './template.js';

/**
 * File and paste headers matched to template fields, and failures named
 * (P1-19).
 *
 * §2.2 promises one fixed template, so matching is deterministic — but headers
 * arrive with capitals, accents, stray spaces, a "(€)" somebody added, and in
 * Italian. **Reporting by name is the safety property.** A silent positional
 * fallback on a mismatch shifts every column of every row, and the import
 * would look like it worked.
 */

/**
 * A header, reduced to the words that identify it.
 *
 * Accents go (`Quantità` → `quantita`), punctuation and symbols become spaces
 * (`Prezzo (€)` → `prezzo`), underscores are separators (`stock_qty` →
 * `stock qty`), and runs of space collapse. Both sides of every comparison go
 * through this, so the synonyms below are written in the same reduced form.
 */
export const normaliseHeader = (cell: string): string =>
  cell
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * What a seller might call each column, beyond the template's own header.
 *
 * **Italian first**, because that is who writes these files, then the English
 * a spreadsheet exported from a shop platform tends to carry. Kept short on
 * purpose: a synonym that could mean two fields — "costo", which is not the
 * selling price, or "stato", which could be anything — is left out, because
 * matching it would be exactly the guess this module exists not to make.
 */
export const SYNONYMS: Readonly<Record<TemplateField, readonly string[]>> = {
  name: ['nome', 'nome vino', 'vino', 'wine', 'wine name', 'prodotto'],
  producer: ['produttore', 'cantina', 'azienda', 'azienda agricola', 'winery'],
  vintage: ['annata', 'anno', 'year'],
  sku: ['codice', 'codice articolo', 'cod articolo', 'articolo', 'item code'],
  externalVariantId: ['id variante', 'variant id', 'shopify variant id'],
  wineType: ['tipologia', 'tipo', 'tipo vino', 'type'],
  grapeVarieties: ['vitigni', 'vitigno', 'uve', 'uvaggio', 'grapes', 'grape'],
  region: ['regione', 'zona'],
  denomination: ['denominazione', 'appellation'],
  styleTags: ['stile', 'stili', 'style', 'tags'],
  tastingNotes: [
    'note di degustazione',
    'note degustazione',
    'degustazione',
    'descrizione',
    'note',
    'notes',
  ],
  foodPairings: ['abbinamenti', 'abbinamento', 'abbinamenti cibo', 'pairings'],
  alcoholPct: ['alcol', 'gradazione', 'gradazione alcolica', 'alcohol', 'abv'],
  price: ['prezzo', 'prezzo euro', 'prezzo di vendita', 'prezzo vendita'],
  currency: ['valuta', 'moneta'],
  stockStatus: ['disponibilita', 'availability'],
  stockQty: ['quantita', 'bottiglie', 'giacenza', 'stock', 'qty', 'magazzino'],
  productUrl: ['url prodotto', 'link prodotto', 'pagina prodotto', 'url', 'link'],
  imageUrl: ['url immagine', 'immagine', 'image', 'foto'],
};

const BY_NAME = new Map<string, TemplateField>(
  TEMPLATE_COLUMNS.flatMap((column) => [
    [normaliseHeader(column.header), column.field] as const,
    ...SYNONYMS[column.field].map((synonym) => [normaliseHeader(synonym), column.field] as const),
  ]),
);

export const matchHeader = (cell: string): TemplateField | undefined =>
  BY_NAME.get(normaliseHeader(cell));

/**
 * Columns an import cannot do without.
 *
 * **Exactly the fields the form has no default for.** Currency and
 * availability are filled in the way the form fills them — EUR, in stock — so a
 * file without those columns is still a file of wines. A file without a price
 * is not, and neither is one without a name, a SKU or a type. `external variant
 * id` is not here although §2.2 lists it as required: the API contract accepts
 * a wine without one, and P1-01 explains in the form why a seller wants it.
 */
export const REQUIRED_COLUMNS: readonly TemplateField[] = ['name', 'sku', 'wineType', 'price'];

/** Each field's name in the sentences a seller reads. */
export const COLUMN_LABEL: Readonly<Record<TemplateField, string>> = {
  name: 'nome',
  producer: 'produttore',
  vintage: 'annata',
  sku: 'SKU',
  externalVariantId: 'ID variante',
  wineType: 'tipologia',
  grapeVarieties: 'vitigni',
  region: 'regione',
  denomination: 'denominazione',
  styleTags: 'stile',
  tastingNotes: 'note di degustazione',
  foodPairings: 'abbinamenti',
  alcoholPct: 'gradazione',
  price: 'prezzo',
  currency: 'valuta',
  stockStatus: 'disponibilità',
  stockQty: 'bottiglie',
  productUrl: 'URL prodotto',
  imageUrl: 'URL immagine',
};

export interface DuplicateColumn {
  readonly field: TemplateField;
  /** The headers as the seller wrote them, so the message quotes their words. */
  readonly headers: readonly string[];
}

export interface HeaderMap {
  /** The field each column fills, by position; `undefined` for a column that fills none. */
  readonly fields: readonly (TemplateField | undefined)[];
  readonly unrecognised: readonly string[];
  readonly missingRequired: readonly TemplateField[];
  readonly duplicates: readonly DuplicateColumn[];
}

export const mapHeaders = (header: readonly string[]): HeaderMap => {
  const fields = header.map((cell) => matchHeader(cell));
  const byField = new Map<TemplateField, string[]>();

  header.forEach((cell, index) => {
    const field = fields[index];
    if (field !== undefined) byField.set(field, [...(byField.get(field) ?? []), cell]);
  });

  return {
    fields,
    unrecognised: header.filter((cell, index) => cell.trim() !== '' && fields[index] === undefined),
    missingRequired: REQUIRED_COLUMNS.filter((field) => !byField.has(field)),
    duplicates: [...byField]
      .filter(([, headers]) => headers.length > 1)
      .map(([field, headers]) => ({ field, headers })),
  };
};

/**
 * Whether these headers stop the import.
 *
 * **A missing required column refuses, and so does a duplicate.** Two columns
 * both reading as *prezzo* — "Prezzo" and "Prezzo scontato" do not, but
 * "Prezzo" and "price" do — leave no way to know which one the seller meant,
 * and choosing is the guess. Unrecognised columns do not block: they are
 * ignored, and said to be.
 */
export const headersBlockImport = (map: HeaderMap): boolean =>
  map.missingRequired.length > 0 || map.duplicates.length > 0;

/** Every problem with the headers, as sentences, blocking ones first. */
export const headerProblems = (map: HeaderMap): string[] => [
  ...(map.missingRequired.length === 0
    ? []
    : [
        `Mancano colonne obbligatorie: ${map.missingRequired.map((field) => COLUMN_LABEL[field]).join(', ')}.`,
      ]),
  ...map.duplicates.map(
    ({ field, headers }) =>
      `Più colonne indicano ${COLUMN_LABEL[field]} (${headers.join(', ')}): lasciane una sola.`,
  ),
  ...(map.unrecognised.length === 0
    ? []
    : [`Colonne non riconosciute e ignorate: ${map.unrecognised.join(', ')}.`]),
];
