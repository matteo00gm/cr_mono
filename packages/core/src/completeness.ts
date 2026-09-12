/**
 * How well a wine is described, as a number a seller can act on (P1-12).
 *
 * **Sparse products retrieve badly, and the seller is the only person who can
 * fix that.** A wine with a name and a price is a wine the model can only match
 * on its name — so a visitor asking for "qualcosa per il brasato" never sees
 * it, and nothing anywhere reports a problem. Retrieval works; the catalogue is
 * simply half-invisible.
 *
 * This is also why LLM enrichment could be deferred (§4.2). Making the gap
 * visible is most of the value; filling it automatically is the expensive
 * remainder.
 *
 * Pure and dependency-free, so the API can score a row on the way out (P1-09's
 * filter) and the dashboard can score a form as it is typed, from the same
 * function. A score computed twice by two implementations is a score that
 * disagrees with itself in front of the seller.
 */

/**
 * The fields that carry retrieval signal, and what each is worth.
 *
 * **Weighted by retrieval impact, not by field count**, which is the whole
 * design. Counting fields makes `alcohol_pct` worth as much as
 * `food_pairings`, so a seller diligently filling in the cheap fields watches
 * the number climb while their wines stay unfindable — a score that rewards the
 * wrong work is worse than no score.
 *
 * The two heaviest are the two a visitor actually asks in: what does it taste
 * like, and what do I eat with it. Everything else is how a wine is
 * *catalogued* rather than how it is *wanted*.
 *
 * **They come to 47 of 100 — just under half, and deliberately so.** More than
 * half would say a wine with pairings and notes and nothing else is better
 * described than one carrying grape, region, denomination, producer, style,
 * vintage and alcohol. It is not: a visitor asking for "un rosso piemontese"
 * needs the second one. Under half keeps both halves worth filling in while
 * still making the pairing fields the ones that move the number most.
 *
 * `name`, `wine_type` and `price_cents` are absent on purpose — they are NOT
 * NULL in the schema, so every product has them and scoring them would add a
 * constant to every wine. A score whose floor is 30 tells a seller their empty
 * product is a third of the way there.
 */
export const COMPLETENESS_FIELDS = [
  ['foodPairings', 25, 'abbinamenti'],
  ['tastingNotes', 22, 'note di degustazione'],
  ['grapeVarieties', 13, 'vitigni'],
  ['region', 10, 'regione'],
  ['denomination', 8, 'denominazione'],
  ['producer', 8, 'produttore'],
  ['styleTags', 6, 'stile'],
  ['vintage', 5, 'annata'],
  ['alcoholPct', 3, 'gradazione'],
] as const satisfies readonly (readonly [string, number, string])[];

export type CompletenessField = (typeof COMPLETENESS_FIELDS)[number][0];

/** What the seller is asked to add, in the words the UI uses (P1-13). */
export const FIELD_LABELS: Readonly<Record<CompletenessField, string>> = Object.fromEntries(
  COMPLETENESS_FIELDS.map(([field, , label]) => [field, label]),
) as Readonly<Record<CompletenessField, string>>;

const TOTAL_WEIGHT = COMPLETENESS_FIELDS.reduce((sum, [, weight]) => sum + weight, 0);

/** Anything the score can read. Deliberately wider than any one row type. */
export type ScorableValue = string | number | readonly unknown[] | null | undefined;

export type ScorableProduct = Partial<Record<CompletenessField, ScorableValue>>;

/**
 * Absent, null, empty string and empty array all mean *not described*.
 *
 * **A field cleared to `''` and a field never filled in are the same wine**, and
 * treating them differently would score two identical catalogues differently.
 * Whitespace counts as empty for the same reason: a tasting note of `'   '`
 * describes nothing, and rewarding it would make the score gameable by
 * accident.
 */
const isPresent = (value: ScorableValue): boolean => {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';

  return true;
};

export interface Completeness {
  /** 0–100, rounded. */
  readonly score: number;
  /** Every unfilled field, heaviest first. */
  readonly missing: readonly CompletenessField[];
  /**
   * The single field worth filling next, or `undefined` when nothing is
   * missing.
   *
   * **One suggestion rather than a list**, because a list of nine is a list
   * nobody starts. This is what P1-13 names in its prompt.
   */
  readonly topSuggestion: CompletenessField | undefined;
}

/**
 * Scores a product.
 *
 * The result is deliberately three separate facts rather than one: the number
 * is what a grid column shows at a glance, the list is what a form highlights,
 * and the suggestion is what the copy names. Deriving any of them at the call
 * site would mean two places deciding what "most important" means.
 */
export const completenessOf = (product: ScorableProduct): Completeness => {
  const missing = COMPLETENESS_FIELDS.filter(([field]) => !isPresent(product[field])).map(
    ([field]) => field,
  );

  const earned = COMPLETENESS_FIELDS.reduce(
    (sum, [field, weight]) => (isPresent(product[field]) ? sum + weight : sum),
    0,
  );

  return {
    score: Math.round((earned / TOTAL_WEIGHT) * 100),
    missing,
    /*
     * The first, which is the heaviest: `COMPLETENESS_FIELDS` is ordered by
     * weight and `filter` preserves that order. Ordered here rather than sorted
     * at the call site, so the "most important" a seller is shown and the
     * "most important" the score uses cannot drift apart.
     */
    topSuggestion: missing[0],
  };
};

/**
 * The bands P1-13 colours, and the plan's own language for them.
 *
 * Three rather than five: a seller is being told whether to act, not given a
 * grade. The boundaries are where the *retrieval* changes rather than round
 * numbers — below 40 a wine has neither of the two heavy fields and is
 * effectively name-only; above 75 it has both plus most of the catalogue
 * detail, and the remaining fields move the answer very little.
 */
export const COMPLETENESS_BANDS = ['sparse', 'partial', 'rich'] as const;
export type CompletenessBand = (typeof COMPLETENESS_BANDS)[number];

/**
 * The lowest score in each band.
 *
 * **Exported as data because two things need it, and they must not disagree.**
 * The UI colours a band; the catalogue filters by one, which the database does
 * as a numeric range (P1-09). A boundary written twice is a filter that shows a
 * seller a wine the indicator beside it calls something else — and both would
 * look right in isolation.
 */
export const BAND_FLOOR: Readonly<Record<CompletenessBand, number>> = {
  sparse: 0,
  partial: 40,
  rich: 75,
};

export const bandOf = (score: number): CompletenessBand =>
  score >= BAND_FLOOR.rich ? 'rich' : score >= BAND_FLOOR.partial ? 'partial' : 'sparse';

/**
 * The score range a band covers, inclusive at both ends.
 *
 * Derived from the same floors `bandOf` reads, so the filter and the label
 * cannot drift. `rangeOfBand(b)` round-tripping through `bandOf` is asserted —
 * which is what makes "derived" mean something rather than "written next to".
 */
export const rangeOfBand = (band: CompletenessBand): { min: number; max: number } => {
  const floors = COMPLETENESS_BANDS.map((name) => BAND_FLOOR[name]).sort((a, b) => a - b);
  const min = BAND_FLOOR[band];
  const next = floors.find((floor) => floor > min);

  return { min, max: next === undefined ? 100 : next - 1 };
};
