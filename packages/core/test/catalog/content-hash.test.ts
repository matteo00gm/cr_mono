import { describe, expect, it } from 'vitest';

import {
  contentHashOf,
  embeddingFields,
  EMBEDDING_TEXT_VERSION,
  type EmbeddableProduct,
} from '../../src/catalog/content-hash.js';

/**
 * What re-embedding costs, decided (P1-02, ahead of P1-34).
 *
 * **These are money tests, not correctness tests**, and the two halves pull
 * against each other: a hash that moves too easily bills for every stock
 * correction, and one that moves too rarely leaves a wine described by an
 * embedding of its previous description — findable under the wrong words, with
 * nothing failing.
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
};

const hashOf = (overrides: Partial<EmbeddableProduct> = {}) =>
  contentHashOf({ ...BAROLO, ...overrides });

describe('what changes the hash', () => {
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
  ])('%s reaches the model, so editing it must re-embed', (_field, change) => {
    expect(hashOf(change)).not.toBe(hashOf());
  });

  it('reordering an array counts as a change, deliberately', () => {
    /*
     * Sorting first would make a reorder free — and it is not free. The text
     * handed to the model is built in this order, so the vector really does
     * differ. A hash that disagreed with that would leave the stored embedding
     * subtly stale with nothing to notice it.
     */
    expect(hashOf({ foodPairings: ['formaggi stagionati', 'brasato al Barolo'] })).not.toBe(
      hashOf(),
    );
  });

  it('cannot be fooled by moving text between fields', () => {
    /*
     * The collision a flat joined string would allow: `name` and `producer`
     * swapped describes a different wine, and a `"${name}\n${producer}"` hash
     * would be identical for both. That edit would never re-embed.
     */
    expect(hashOf({ name: BAROLO.producer, producer: BAROLO.name })).not.toBe(hashOf());
  });
});

describe('what does not change the hash', () => {
  it.each([
    ['price', { priceCents: 9900 }],
    ['stock quantity', { stockQty: 0 }],
    ['stock status', { stockStatus: 'OUT_OF_STOCK' }],
    ['product URL', { productUrl: 'https://example.com/new' }],
    ['image URL', { imageUrl: 'https://example.com/new.jpg' }],
    ['SKU', { sku: 'BAR-2019-B' }],
    ['external variant id', { externalVariantId: '99999' }],
    ['currency', { currency: 'CHF' }],
  ])('%s is displayed and not embedded, so editing it must cost nothing', (_field, extra) => {
    /*
     * The cost control, asserted rather than described. Without it every save
     * enqueues an embedding job and the bill tracks how often sellers edit
     * rather than what they sell — and a seller adjusting stock daily is the
     * normal case, not the exception.
     */
    expect(contentHashOf({ ...BAROLO, ...extra })).toBe(hashOf());
  });

  it.each([
    ['absent', {}],
    ['null', { producer: null }],
    ['empty', { producer: '' }],
    ['whitespace', { producer: '   ' }],
  ])('treats a %s producer the same way', (_case, change) => {
    const withoutProducer = { ...BAROLO, producer: undefined };

    expect(contentHashOf({ ...withoutProducer, ...change })).toBe(contentHashOf(withoutProducer));
  });

  it('ignores an empty entry left in an array by a paste', () => {
    expect(hashOf({ styleTags: ['strutturato', '', 'tannico'] })).toBe(hashOf());
  });

  it('ignores surrounding whitespace, which a spreadsheet supplies constantly', () => {
    expect(hashOf({ name: '  Barolo Bussia  ' })).toBe(hashOf());
  });

  it('drops an emptied array entirely rather than hashing it as present', () => {
    const withoutTags = { ...BAROLO, styleTags: undefined };

    expect(hashOf({ styleTags: [] })).toBe(contentHashOf(withoutTags));
  });
});

describe('stability', () => {
  it('is the same value across calls, which is what makes a re-import free', () => {
    /*
     * Rules out anything seeded per process. A `Map` keyed on object identity,
     * or a hash over `JSON.stringify(product)` with its key order, would both
     * pass a naive test and re-embed the whole catalogue on every deploy.
     */
    expect(hashOf()).toBe(hashOf());
  });

  it('does not depend on the order the object was written in', () => {
    const reversed: EmbeddableProduct = {
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

    /*
     * The field order is fixed by a literal in the module rather than taken
     * from the object, so reformatting a caller cannot trigger a full re-index.
     */
    expect(contentHashOf(reversed)).toBe(hashOf());
  });

  it('is a hex sha-256, so the column can be sized and compared as one', () => {
    expect(hashOf()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries the version, so a rendering change re-indexes on purpose', () => {
    /*
     * The escape hatch P1-33 and P1-49 need. A new embedding text that left old
     * hashes intact would leave a catalogue half-embedded under two schemes —
     * retrieval would still work and still return plausible results, while
     * comparing vectors built from different text.
     */
    expect(EMBEDDING_TEXT_VERSION).toBe('v1');

    const fields = JSON.stringify(embeddingFields(BAROLO));
    expect(fields).not.toContain(EMBEDDING_TEXT_VERSION);
  });
});

describe('embeddingFields', () => {
  it('omits absent fields rather than emitting empty labels', () => {
    const fields = embeddingFields({ name: 'Solo', producer: null, region: '' });

    expect(fields).toEqual([['name', 'Solo']]);
  });

  it('keeps the declared field order whatever the caller did', () => {
    const fields = embeddingFields({ region: 'Piemonte', name: 'Barolo' });

    expect(fields.map(([field]) => field)).toEqual(['name', 'region']);
  });
});
