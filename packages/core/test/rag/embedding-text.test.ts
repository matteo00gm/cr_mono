import { describe, expect, it } from 'vitest';

import {
  contentHashOf,
  embeddingText,
  EMBEDDING_TEXT_VERSION,
  priceBand,
  shouldEmbed,
  type EmbeddableProduct,
} from '../../src/rag/index.js';

/**
 * The document a wine becomes, and what an edit costs (P1-33, P1-34).
 *
 * **These are money tests before they are correctness tests**, and the two
 * halves pull against each other: text that moves too easily bills for every
 * stock correction, and text that moves too rarely leaves a wine described by
 * an embedding of its previous description — findable under the wrong words,
 * with nothing failing.
 *
 * So both directions are asserted for every field, rather than only the
 * cheerful one.
 */

const BAROLO: EmbeddableProduct = {
  name: 'Barolo Bussia',
  producer: 'Poderi Colla',
  vintage: 2019,
  wineType: 'red',
  grapeVarieties: ['Nebbiolo'],
  region: 'Piemonte',
  denomination: 'Barolo DOCG',
  styleTags: ['strutturato', 'tannico'],
  tastingNotes: 'Rosa appassita, catrame e ciliegia sotto spirito.',
  foodPairings: ['brasato al Barolo', 'formaggi stagionati'],
  alcoholPct: '14.50',
  priceCents: 4500,
};

const textOf = (overrides: Partial<EmbeddableProduct> = {}) =>
  embeddingText({ ...BAROLO, ...overrides });

const hashOf = (overrides: Partial<EmbeddableProduct> = {}) =>
  contentHashOf({ ...BAROLO, ...overrides });

describe('determinism', () => {
  it('produces the identical string every time', () => {
    /*
     * The row asks for a hundred runs. The number is not the point — what is
     * ruled out is anything seeded per call or per process, which would leak
     * money silently rather than fail.
     */
    const once = textOf();

    for (let run = 0; run < 100; run += 1) expect(textOf()).toBe(once);
  });

  it('does not depend on the order the object was written in', () => {
    const reversed: EmbeddableProduct = {
      priceCents: BAROLO.priceCents,
      alcoholPct: BAROLO.alcoholPct,
      foodPairings: BAROLO.foodPairings,
      tastingNotes: BAROLO.tastingNotes,
      styleTags: BAROLO.styleTags,
      denomination: BAROLO.denomination,
      region: BAROLO.region,
      grapeVarieties: BAROLO.grapeVarieties,
      wineType: BAROLO.wineType,
      vintage: BAROLO.vintage,
      producer: BAROLO.producer,
      name: BAROLO.name,
    };

    expect(embeddingText(reversed)).toBe(textOf());
  });

  it('labels every line, so a region called Barolo is not a wine called Barolo', () => {
    /*
     * The labels are most of what a wine query turns on. A bare concatenation
     * would also let a producer typed into a name field produce the same
     * document as the two filled in properly.
     */
    expect(textOf()).toContain('Nome: Barolo Bussia');
    expect(textOf()).toContain('Denominazione: Barolo DOCG');
    expect(textOf({ name: BAROLO.producer, producer: BAROLO.name })).not.toBe(textOf());
  });
});

describe('what does not change the text', () => {
  it('reordering an array', () => {
    /*
     * **A correction to P1-02, which preserved the author's order.** That
     * decision argued a reorder is not free because the text is built in that
     * order — and once the text *sorts*, the two orders produce the same
     * document and the same vector, so charging for one was charging for
     * nothing.
     */
    expect(textOf({ foodPairings: ['formaggi stagionati', 'brasato al Barolo'] })).toBe(textOf());
    expect(textOf({ grapeVarieties: ['Barbera', 'Nebbiolo'] })).toBe(
      textOf({ grapeVarieties: ['Nebbiolo', 'Barbera'] }),
    );
  });

  it.each([
    ['stock status', { stockStatus: 'OUT_OF_STOCK' }],
    ['stock quantity', { stockQty: 0 }],
    ['product URL', { productUrl: 'https://example.com/new' }],
    ['image URL', { imageUrl: 'https://example.com/new.jpg' }],
    ['SKU', { sku: 'BAR-2019-B' }],
    ['external variant id', { externalVariantId: '99999' }],
    ['currency', { currency: 'CHF' }],
  ])('%s, which is displayed and never embedded', (_field, extra) => {
    /*
     * This exclusion is what makes P1-11's inline edits free. A seller
     * adjusting stock daily is the normal case, not the exception.
     */
    expect(embeddingText({ ...BAROLO, ...extra })).toBe(textOf());
  });

  it('a price change inside its band', () => {
    /*
     * The ordinary edit: 18,50 to 19,00 is the same answer to the same
     * question, so it must cost nothing.
     */
    expect(textOf({ priceCents: 4400 })).toBe(textOf({ priceCents: 4900 }));
  });

  it.each([
    ['absent', {}],
    ['null', { producer: null }],
    ['empty', { producer: '' }],
    ['whitespace', { producer: '   ' }],
  ])('a %s producer', (_case, change) => {
    const without = { ...BAROLO, producer: undefined };

    expect(embeddingText({ ...without, ...change })).toBe(embeddingText(without));
  });

  it('an empty entry a trailing comma left in an array', () => {
    expect(textOf({ styleTags: ['strutturato', '', 'tannico'] })).toBe(textOf());
  });

  it('surrounding whitespace, which a spreadsheet supplies constantly', () => {
    expect(textOf({ name: '  Barolo Bussia  ' })).toBe(textOf());
  });
});

describe('what does change it', () => {
  it.each([
    ['name', { name: 'Barolo Cannubi' }],
    ['producer', { producer: 'Vietti' }],
    ['vintage', { vintage: 2020 }],
    ['wineType', { wineType: 'white' }],
    ['grapeVarieties', { grapeVarieties: ['Nebbiolo', 'Barbera'] }],
    ['region', { region: 'Toscana' }],
    ['denomination', { denomination: 'Barbaresco DOCG' }],
    ['styleTags', { styleTags: ['fresco'] }],
    ['tastingNotes', { tastingNotes: 'Frutta rossa croccante.' }],
    ['foodPairings', { foodPairings: ['pesce'] }],
    ['alcoholPct', { alcoholPct: '13.00' }],
  ])('%s, which the model reads', (_field, change) => {
    expect(textOf(change)).not.toBe(textOf());
  });

  it('a price change that crosses a band', () => {
    /*
     * Rare and correct: the wine has moved into a different answer. "Qualcosa
     * sotto i venti euro" is one of the commonest things a visitor says, and a
     * retrieval layer that cannot see price answers it by accident or not at
     * all.
     */
    expect(textOf({ priceCents: 1900 })).not.toBe(textOf({ priceCents: 2100 }));
  });

  it('an omitted field, rather than rendering it as null', () => {
    const sparse = embeddingText({ name: 'Solo', producer: null, region: '' });

    expect(sparse).toBe('Nome: Solo');
    expect(sparse).not.toContain('null');
  });
});

describe('priceBand', () => {
  it.each([
    [500, 'fino a 10 euro'],
    [999, 'fino a 10 euro'],
    [1000, 'tra 10 e 20 euro'],
    [1999, 'tra 10 e 20 euro'],
    [2000, 'tra 20 e 35 euro'],
    [3500, 'tra 35 e 60 euro'],
    [6000, 'tra 60 e 100 euro'],
    [9999, 'tra 60 e 100 euro'],
    [10_000, 'oltre 100 euro'],
    [250_000, 'oltre 100 euro'],
  ])('puts %d cents in %s', (cents, band) => {
    expect(priceBand(cents)).toBe(band);
  });

  it('names bands a person would say out loud', () => {
    /*
     * Round numbers rather than quantiles, because a band nobody would name is
     * a band the model cannot be asked about.
     */
    expect(priceBand(1500)).toMatch(/10 e 20 euro/);
  });
});

describe('contentHashOf', () => {
  it('is a hex sha-256, so the column can be sized and compared as one', () => {
    expect(hashOf()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same value across calls, which is what makes a re-import free', () => {
    expect(hashOf()).toBe(hashOf());
  });

  it('moves exactly when the text moves', () => {
    /*
     * **The property that makes the hash meaningful rather than merely
     * stable.** A hash over some other projection of the row would usually
     * agree with the text and occasionally not — and the failure would be a
     * wine described by an embedding of its previous description.
     */
    expect(contentHashOf({ ...BAROLO, stockQty: 0 } as EmbeddableProduct)).toBe(hashOf());
    expect(hashOf({ tastingNotes: 'Diverso.' })).not.toBe(hashOf());
  });

  it('carries the version, so a rendering change re-indexes on purpose', () => {
    expect(EMBEDDING_TEXT_VERSION).toBe('v1');
    expect(textOf()).not.toContain(EMBEDDING_TEXT_VERSION);
  });
});

describe('shouldEmbed', () => {
  it('embeds a product that has never been embedded', () => {
    expect(shouldEmbed(hashOf(), null)).toBe(true);
    expect(shouldEmbed(hashOf(), undefined)).toBe(true);
  });

  it('skips one whose stored hash still matches', () => {
    /*
     * **The call count is the money.** This is the second half of the guard —
     * P1-03 stops ordinary edits enqueueing, and this stops a redelivered
     * message, a manual reindex of an unchanged wine, and any future path that
     * enqueues without thinking.
     */
    expect(shouldEmbed(hashOf(), hashOf())).toBe(false);
  });

  it('embeds when the stored hash is stale', () => {
    expect(shouldEmbed(hashOf({ tastingNotes: 'Nuove note.' }), hashOf())).toBe(true);
  });
});
