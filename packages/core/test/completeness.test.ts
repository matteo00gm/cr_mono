import { describe, expect, it } from 'vitest';

import {
  bandOf,
  completenessOf,
  COMPLETENESS_FIELDS,
  FIELD_LABELS,
  type ScorableProduct,
} from '../src/completeness.js';

/**
 * The completeness score (P1-12).
 *
 * **What this is really testing is that the score rewards the right work.** A
 * number that goes up when a seller fills in `alcohol_pct` as fast as when they
 * write food pairings is a number that sends them to the wrong field — and
 * their wines stay unfindable while the dashboard says they are doing well.
 * That failure is invisible from the score itself, which is why the weighting
 * is asserted rather than assumed.
 */

const FULL: ScorableProduct = {
  producer: 'Poderi Colla',
  vintage: 2019,
  grapeVarieties: ['Nebbiolo'],
  region: 'Piemonte',
  denomination: 'Barolo DOCG',
  styleTags: ['strutturato'],
  tastingNotes: 'Rosa appassita, catrame e ciliegia sotto spirito.',
  foodPairings: ['brasato', 'formaggi stagionati'],
  alcoholPct: '14.50',
};

describe('the ends of the scale', () => {
  it('scores an empty product at zero', () => {
    expect(completenessOf({}).score).toBe(0);
  });

  it('scores a fully described product at a hundred', () => {
    expect(completenessOf(FULL).score).toBe(100);
  });

  it('does not credit a wine for the columns it cannot be missing', () => {
    /*
     * `name`, `wine_type` and `price_cents` are NOT NULL, so every product has
     * them. Scoring them would put a constant under every wine — and a score
     * whose floor is 30 tells a seller their empty product is a third of the
     * way there, which is the opposite of the message.
     */
    const scored: readonly string[] = COMPLETENESS_FIELDS.map(([field]) => field);

    expect(scored).not.toContain('name');
    expect(scored).not.toContain('wineType');
    expect(scored).not.toContain('priceCents');
  });
});

describe('the weighting, which is the whole design', () => {
  it('rewards food pairings far more than alcohol content', () => {
    /*
     * **The assertion the row asks for, and the one that keeps the score
     * honest.** Weighting by field count would make these equal: a seller
     * filling in the cheap fields would watch the number climb while their
     * wines stayed unfindable, because neither of the two fields a visitor
     * actually asks in had been written.
     */
    const withPairings = completenessOf({ foodPairings: ['brasato'] }).score;
    const withAlcohol = completenessOf({ alcoholPct: '14.5' }).score;

    expect(withPairings).toBeGreaterThan(withAlcohol * 5);
  });

  it('puts the two fields a visitor asks in above everything else', () => {
    // "What does it taste like" and "what do I eat with it". Everything else is
    // how a wine is catalogued rather than how it is wanted.
    const weights = new Map(COMPLETENESS_FIELDS.map(([field, weight]) => [field, weight]));
    const heaviest = [...weights.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([field]) => field);

    expect(new Set(heaviest)).toEqual(new Set(['foodPairings', 'tastingNotes']));
  });

  it('keeps the three tiers the plan describes, in order', () => {
    /*
     * The row's own ordering: pairings and notes carry the pairing signal, then
     * grapes and region, then the rest. Asserted as tiers rather than as exact
     * numbers, so re-balancing stays possible and inverting the design does not.
     */
    const weight = new Map(COMPLETENESS_FIELDS.map(([field, value]) => [field, value]));
    const of = (field: string) => weight.get(field as never) ?? 0;

    expect(Math.min(of('foodPairings'), of('tastingNotes'))).toBeGreaterThan(
      Math.max(of('grapeVarieties'), of('region')),
    );
    expect(Math.min(of('grapeVarieties'), of('region'))).toBeGreaterThan(
      Math.max(of('vintage'), of('alcoholPct')),
    );
  });

  it('makes the two heavy fields close to half the score, and not more', () => {
    /*
     * **Deliberately just under half, and the first draft of this file claimed
     * "more than everything else" — which the numbers did not support.** They
     * are 47 of 100.
     *
     * More than half would say a wine with pairings and notes and nothing else
     * is better described than one with grape, region, denomination, producer,
     * style, vintage and alcohol. It is not: a visitor asking for "un rosso
     * piemontese" needs the second one. Under half keeps both halves of the
     * catalogue worth filling in, while still making the pairing fields the
     * ones that move the number most.
     */
    const heavy = completenessOf({
      foodPairings: ['brasato'],
      tastingNotes: 'Rosa appassita.',
    }).score;

    expect(heavy).toBeGreaterThan(40);
    expect(heavy).toBeLessThan(50);
  });
});

describe('what counts as filled in', () => {
  it.each([
    ['an empty string', { tastingNotes: '' }],
    ['whitespace only', { tastingNotes: '   ' }],
    ['an empty array', { foodPairings: [] }],
    ['null', { tastingNotes: null }],
    ['undefined', { tastingNotes: undefined }],
  ])('treats %s as absent', (_label, product) => {
    /*
     * A field cleared to `''` and a field never filled in describe the same
     * wine. Treating them differently would score two identical catalogues
     * differently — and whitespace especially, because a tasting note of three
     * spaces describes nothing and rewarding it makes the score gameable by
     * accident.
     */
    expect(completenessOf(product as ScorableProduct).score).toBe(0);
  });

  it('counts a zero as present, because zero is a value', () => {
    // Not reachable through today's fields, and the rule is worth stating
    // before one arrives: `0` is falsy and is not absent.
    expect(completenessOf({ vintage: 0 }).score).toBeGreaterThan(0);
  });
});

describe('what it tells the seller to do next', () => {
  it('names the heaviest missing field', () => {
    const { topSuggestion } = completenessOf({ ...FULL, foodPairings: [] });

    expect(topSuggestion).toBe('foodPairings');
  });

  it('moves to the next heaviest once that one is filled', () => {
    const { topSuggestion } = completenessOf({ ...FULL, tastingNotes: '' });

    expect(topSuggestion).toBe('tastingNotes');
  });

  it('names nothing when nothing is missing', () => {
    expect(completenessOf(FULL).topSuggestion).toBeUndefined();
  });

  it('lists every missing field, heaviest first', () => {
    /*
     * Ordered here rather than sorted at the call site, so the "most important"
     * a seller is shown and the "most important" the score uses cannot drift
     * apart — the kind of divergence nobody notices because both look right.
     */
    const { missing } = completenessOf({});

    expect(missing).toEqual(COMPLETENESS_FIELDS.map(([field]) => field));
  });
});

describe('the labels', () => {
  it('exist for every scored field', () => {
    /*
     * P1-13 names the top suggestion in its copy. A field with no label would
     * render as "Aggiungi undefined", which is a sentence a seller would see.
     */
    for (const [field] of COMPLETENESS_FIELDS) {
      expect(FIELD_LABELS[field], field).toBeTruthy();
    }
  });

  it('are Italian, because the seller is', () => {
    expect(FIELD_LABELS.foodPairings).toBe('abbinamenti');
    expect(FIELD_LABELS.tastingNotes).toBe('note di degustazione');
  });
});

describe('the bands', () => {
  it('calls a name-only wine sparse', () => {
    expect(bandOf(completenessOf({}).score)).toBe('sparse');
  });

  it('calls a fully described wine rich', () => {
    expect(bandOf(completenessOf(FULL).score)).toBe('rich');
  });

  it('puts the boundaries where retrieval changes', () => {
    /*
     * Below 40 a wine has neither heavy field and is effectively name-only.
     * Above 75 it has both plus most of the catalogue detail, and the rest
     * moves the answer very little. Three bands rather than five because the
     * seller is being told whether to act, not given a grade.
     */
    expect(bandOf(39)).toBe('sparse');
    expect(bandOf(40)).toBe('partial');
    expect(bandOf(74)).toBe('partial');
    expect(bandOf(75)).toBe('rich');
  });

  it('leaves a wine with only its heaviest field short of rich', () => {
    // One field, however heavy, is not a described wine.
    expect(bandOf(completenessOf({ foodPairings: ['brasato'] }).score)).not.toBe('rich');
  });
});
