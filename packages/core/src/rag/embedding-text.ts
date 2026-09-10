/**
 * Product → the text that gets embedded (P1-33).
 *
 * **Determinism is the whole requirement, and it is a cost control rather than
 * a correctness nicety.** Any nondeterminism — map iteration order, a
 * locale-dependent number format, an array the caller happened to reorder —
 * changes the text, which changes the hash, which re-embeds a wine that did not
 * change. That leak is silent: nothing fails, the bill simply tracks how often
 * sellers open the form.
 *
 * P1-02 decided the *field set* early, because P1-03 had to gate its outbox row
 * on something. This row owns the *rendering*, and it corrects two of that
 * earlier decision's details — both recorded below rather than quietly changed.
 */

/**
 * Bumped whenever the fields below change, or when their rendering does.
 *
 * **Every product re-embeds when this moves, and that is the intent.** A new
 * rendering that left old hashes intact would leave a catalogue half-embedded
 * under two different schemes — retrieval would work, return plausible results,
 * and quietly compare vectors built from different text. So the version is
 * inside the hash: changing it is a deliberate, visible, one-off re-index, and
 * P1-49's embedding-version affordance is what surfaces it.
 */
export const EMBEDDING_TEXT_VERSION = 'v1';

/**
 * The fields a sommelier answer is actually built from.
 *
 * **What is absent matters more than what is present.** `stockStatus`,
 * `stockQty`, `productUrl` and `imageUrl` are all displayed and none is
 * embedded: a visitor asking for "something for grilled fish" is not asking
 * about stock, and every one of those changes far more often than the wine
 * does. That exclusion is what makes P1-11's inline edits free.
 *
 * `sku` and `externalVariantId` are internal identifiers — a warehouse code in
 * the embedding text is noise that retrieval has to work around, and the field
 * most likely to collide with a real word.
 */
export interface EmbeddableProduct {
  readonly name?: string | null | undefined;
  readonly producer?: string | null | undefined;
  readonly vintage?: number | null | undefined;
  readonly wineType?: string | null | undefined;
  readonly grapeVarieties?: readonly string[] | null | undefined;
  readonly region?: string | null | undefined;
  readonly denomination?: string | null | undefined;
  readonly styleTags?: readonly string[] | null | undefined;
  readonly tastingNotes?: string | null | undefined;
  readonly foodPairings?: readonly string[] | null | undefined;
  readonly alcoholPct?: string | number | null | undefined;
  /**
   * Minor units. **Bucketed into a band before it reaches the text** — see
   * `priceBand`. P1-02 excluded price entirely; this row includes the band,
   * and the difference is argued there.
   */
  readonly priceCents?: number | null | undefined;
}

/**
 * Price bands, in minor units, as a visitor would ask for them.
 *
 * **P1-02 excluded price from the embedding altogether and this row puts a
 * *band* back, which is a real change of mind rather than a detail.** The case
 * for excluding it is that a price edit must not cost an embedding. The case
 * for the band is that "qualcosa sotto i venti euro" is one of the commonest
 * things a visitor says, and a retrieval layer that cannot see price at all
 * answers it by accident or not at all.
 *
 * The band is what reconciles them: an edit *within* a band costs nothing,
 * which is the ordinary case — a seller adjusting 18,50 to 19,00. Crossing a
 * band does re-embed, which is rare and correct, because the wine really has
 * moved into a different answer.
 *
 * The boundaries are round numbers a person would say out loud, not quantiles:
 * a band nobody would name is a band the model cannot be asked about.
 */
const PRICE_BANDS: readonly (readonly [limit: number, label: string])[] = [
  [1000, 'fino a 10 euro'],
  [2000, 'tra 10 e 20 euro'],
  [3500, 'tra 20 e 35 euro'],
  [6000, 'tra 35 e 60 euro'],
  [10_000, 'tra 60 e 100 euro'],
];

const ABOVE_TOP_BAND = 'oltre 100 euro';

export const priceBand = (priceCents: number): string =>
  PRICE_BANDS.find(([limit]) => priceCents < limit)?.[1] ?? ABOVE_TOP_BAND;

/**
 * The labels, in Italian, because the text is read by a model answering in
 * Italian and a mixed-language document is a worse document.
 *
 * The order is fixed and is part of the contract. Reordering this array changes
 * every hash, which is why it is a literal rather than derived from
 * `Object.keys` — key order in an object literal is a thing people reformat
 * without thinking, and it must not be able to trigger a full re-index by
 * accident.
 */
const FIELDS = [
  ['name', 'Nome'],
  ['producer', 'Produttore'],
  ['vintage', 'Annata'],
  ['wineType', 'Tipologia'],
  ['grapeVarieties', 'Vitigni'],
  ['region', 'Regione'],
  ['denomination', 'Denominazione'],
  ['styleTags', 'Stile'],
  ['tastingNotes', 'Note di degustazione'],
  ['foodPairings', 'Abbinamenti'],
  ['alcoholPct', 'Gradazione'],
] as const satisfies readonly (readonly [keyof EmbeddableProduct, string])[];

type EmbeddableValue = string | number | readonly string[] | null | undefined;

/**
 * Absent, null and empty all collapse to *absent*, and arrays are **sorted**.
 *
 * A field cleared to `''` and a field never filled in describe the same wine,
 * so treating them differently would enqueue an embedding for a save that
 * changed nothing a reader could see.
 *
 * **The sort is a correction to P1-02, which preserved the author's order.**
 * That decision rested on an assumption this row removes: it argued that a
 * reorder is not free because the text handed to the model is built in that
 * order. Once the *text* sorts, the two orders produce the same document and
 * the same vector — so a reorder genuinely is free, and charging for one was
 * charging for nothing.
 */
const normalise = (value: EmbeddableValue): string | undefined => {
  if (value === null || value === undefined) return undefined;

  if (Array.isArray(value)) {
    const items = (value as readonly string[])
      .map((item) => item.trim())
      .filter((item) => item !== '')
      /*
       * `localeCompare` is deliberately *not* used: it is locale-dependent, and
       * a sort that depends on the runtime's locale is exactly the
       * nondeterminism this file exists to exclude. A code-point sort is stable
       * everywhere and nobody reads this string for its alphabetical order.
       */
      .sort();

    return items.length === 0 ? undefined : items.join(', ');
  }

  const text = String(value).trim();
  return text === '' ? undefined : text;
};

/**
 * The label/value pairs, in field order, with absent fields omitted entirely.
 *
 * Pairs rather than a joined string in the *hash*, and the difference is not
 * cosmetic: a flat `"${name}\n${producer}"` lets a producer typed into a name
 * field produce the same string as the two filled in properly, so an edit that
 * moved text between fields would hash identically and never re-embed. The
 * labels below give the same protection to the rendered text.
 */
export const embeddingFields = (
  product: EmbeddableProduct,
): readonly (readonly [field: string, value: string])[] => {
  const pairs = FIELDS.flatMap(([field, label]) => {
    const value = normalise(product[field]);
    return value === undefined ? [] : [[label, value] as const];
  });

  const price = product.priceCents;
  return price === null || price === undefined
    ? pairs
    : [...pairs, ['Fascia di prezzo', priceBand(price)] as const];
};

/**
 * The document handed to the embedding provider.
 *
 * Labelled lines rather than a bare concatenation, because the labels are what
 * let the model tell a *region* called Barolo from a *wine* called Barolo — and
 * that distinction is most of what a wine query turns on.
 */
export const embeddingText = (product: EmbeddableProduct): string =>
  embeddingFields(product)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
