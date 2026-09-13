import { describe, expect, it } from 'vitest';

import { INLINE_EDIT_FIELDS, type InlineEditField } from '../src/inline-edit.js';
import { contentHashOf } from '../src/rag/content-hash.js';
import { embeddingText, priceBand } from '../src/rag/embedding-text.js';

/**
 * Inline edits and the embedding bill (P1-11).
 *
 * **This is the test that makes the grid's editable cells cheap**, and it is
 * written against the real embedding text and the real hash rather than a
 * stand-in: the claim is that editing these cells does not move
 * `content_hash`, and only the function that computes it can confirm that.
 */

const WINE = {
  name: 'Barolo Bussia',
  producer: 'Poderi Colla',
  vintage: 2019,
  wineType: 'red',
  grapeVarieties: ['Nebbiolo'],
  region: 'Piemonte',
  tastingNotes: 'Rosa appassita, catrame, tannino fitto.',
  foodPairings: ['brasato', 'tartufo'],
  alcoholPct: '14.50',
  priceCents: 2450,
  stockStatus: 'IN_STOCK',
  stockQty: 24,
} as const;

/**
 * How to vary each inline field without leaving its price band.
 *
 * **A field missing here fails the suite**, and that is the point: widening
 * `INLINE_EDIT_FIELDS` must come with a decision about whether the new field
 * reaches the model — written down here, where the reasoning is.
 */
const VARIATIONS: Readonly<Record<InlineEditField, readonly unknown[]>> = {
  // All inside 20–35 euro, the band 24,50 sits in.
  priceCents: [2000, 2999, 3499],
  stockStatus: ['OUT_OF_STOCK', 'PREORDER'],
  stockQty: [0, 1, 500, null],
};

describe('INLINE_EDIT_FIELDS', () => {
  it('has a declared variation for every field, so none is added without a decision', () => {
    for (const field of INLINE_EDIT_FIELDS) {
      expect(VARIATIONS[field], `${field} has no variation`).toBeDefined();
    }
    expect(Object.keys(VARIATIONS).sort()).toEqual([...INLINE_EDIT_FIELDS].sort());
  });

  it('never moves the hash for an edit a seller makes every week', () => {
    const before = contentHashOf(WINE);

    for (const field of INLINE_EDIT_FIELDS) {
      for (const value of VARIATIONS[field]) {
        const after = contentHashOf({ ...WINE, [field]: value });
        expect(after, `${field} = ${String(value)} moved the hash`).toBe(before);
      }
    }
  });

  it('keeps the stock fields out of the text altogether', () => {
    const text = embeddingText(WINE);

    expect(text).not.toContain('24');
    expect(text).not.toMatch(/IN_STOCK|Disponibil/);
  });

  it('does re-embed a price that crosses a band, on purpose', () => {
    /*
     * The exception to the row's premise, pinned so it stays a decision. A
     * wine moving from 24,50 to 45,00 is a different answer to "sotto i trenta
     * euro", and a vector that still said otherwise would recommend it there.
     */
    expect(priceBand(4500)).not.toBe(priceBand(WINE.priceCents));
    expect(contentHashOf({ ...WINE, priceCents: 4500 })).not.toBe(contentHashOf(WINE));
  });
});
