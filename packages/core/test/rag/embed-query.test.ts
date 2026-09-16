import { describe, expect, it } from 'vitest';

import { isDomainError } from '../../src/errors.js';
import {
  assertQueryProviderMatchesIndex,
  embedQuery,
  MAX_QUERY_CHARACTERS,
  normaliseQuery,
  QueryDimensionMismatchError,
  QueryModelMismatchError,
} from '../../src/rag/embed-query.js';
import type { EmbeddingProvider } from '../../src/rag/embedding-provider.js';

/**
 * Embedding a visitor's question (P2-17).
 *
 * The two failures worth testing are silent ones: a query embedded by a model
 * the catalogue was not indexed with, which makes every similarity meaningless
 * without erroring, and a normalisation that throws away the signal the model
 * was trained on.
 */

const INDEXED = { model: 'amazon.titan-embed-text-v2:0', dim: 1024 };

/** A provider that answers with vectors of its declared size, recording what it was asked. */
const provider = (
  over: Partial<EmbeddingProvider> = {},
): EmbeddingProvider & {
  readonly asked: string[][];
} => {
  const asked: string[][] = [];

  return {
    model: INDEXED.model,
    dim: INDEXED.dim,
    embed: (texts) => {
      asked.push([...texts]);
      return Promise.resolve(texts.map(() => Array.from({ length: INDEXED.dim }, () => 0.1)));
    },
    asked,
    ...over,
  };
};

describe('normalising a question', () => {
  it("caps a question at the row's five hundred characters", () => {
    // As a number: every boundary case below moves with the constant, so a cap
    // quietly raised to five thousand would pass all of them.
    expect(MAX_QUERY_CHARACTERS).toBe(500);
  });

  it('trims and collapses whitespace', () => {
    expect(normaliseQuery('  un rosso   corposo\n per   brasato ')).toBe(
      'un rosso corposo per brasato',
    );
  });

  it('keeps accents, case and morphology, which the model reads better than we could', () => {
    // Stripping the accent from `perché` or folding `più` throws away signal
    // the model was trained on; stemming `rossi` to `ross` invents a word.
    const asked = 'Perché i rossi più strutturati? DOCG, Nebbiolo';

    expect(normaliseQuery(asked)).toBe(asked);
  });

  it('truncates an over-long question rather than refusing it', () => {
    const long = 'a'.repeat(MAX_QUERY_CHARACTERS + 200);

    expect(normaliseQuery(long)).toHaveLength(MAX_QUERY_CHARACTERS);
  });

  it('gives a question that begins with whitespace the whole budget', () => {
    /*
     * The trim *before* the cut is what makes this true. Without it the leading
     * space costs one of the five hundred characters and the trim afterwards
     * hides the loss, so the visitor pays for a space and loses a word.
     */
    const padded = ` ${'a'.repeat(MAX_QUERY_CHARACTERS + 50)}`;

    expect(normaliseQuery(padded)).toHaveLength(MAX_QUERY_CHARACTERS);
  });

  it('leaves no trailing space where the cut landed', () => {
    const cut = `${'a'.repeat(MAX_QUERY_CHARACTERS - 1)} rosso`;

    expect(normaliseQuery(cut)).toBe('a'.repeat(MAX_QUERY_CHARACTERS - 1));
  });
});

describe('embedding a question', () => {
  it('embeds the normalised text and reports what produced the vector', async () => {
    const titan = provider();

    const embedded = await embedQuery(titan, '  un rosso   corposo ');

    expect(titan.asked).toEqual([['un rosso corposo']]);
    expect(embedded).toMatchObject({ text: 'un rosso corposo', model: INDEXED.model });
    expect(embedded.vector).toHaveLength(INDEXED.dim);
  });

  it('sends the provider at most the capped length, so a paste is not paid for in full', async () => {
    const titan = provider();

    await embedQuery(titan, 'a'.repeat(MAX_QUERY_CHARACTERS * 3));

    expect(titan.asked[0]?.[0]).toHaveLength(MAX_QUERY_CHARACTERS);
  });

  it('refuses a message with nothing in it, without paying to embed whitespace', async () => {
    const titan = provider();

    const failure = await embedQuery(titan, '   \n  ').catch((error: unknown) => error);

    expect(isDomainError(failure)).toBe(true);
    expect(titan.asked).toEqual([]);
  });

  it('refuses a vector that is not the size the provider promised', async () => {
    // A provider that quietly changed dimension: the comparison would be
    // rejected by Postgres, or compare the wrong thing.
    const shrunk = provider({ embed: () => Promise.resolve([[0.1, 0.2]]) });

    await expect(embedQuery(shrunk, 'un rosso')).rejects.toThrow(QueryDimensionMismatchError);
  });

  it('refuses an answer with no vector in it at all', async () => {
    const empty = provider({ embed: () => Promise.resolve([]) });

    await expect(embedQuery(empty, 'un rosso')).rejects.toThrow(/returned 0 vectors for 1/);
  });
});

describe('the model the catalogue was indexed with', () => {
  it('accepts the provider that matches it', () => {
    expect(() => assertQueryProviderMatchesIndex(provider(), INDEXED)).not.toThrow();
  });

  it('refuses another model, because the similarity would be meaningless and quiet', () => {
    const other = provider({ model: 'cohere.embed-multilingual-v3' });

    expect(() => assertQueryProviderMatchesIndex(other, INDEXED)).toThrow(QueryModelMismatchError);
  });

  it('refuses another dimension', () => {
    const wider = provider({ dim: 1536 });

    expect(() => assertQueryProviderMatchesIndex(wider, INDEXED)).toThrow(
      QueryDimensionMismatchError,
    );
  });
});
