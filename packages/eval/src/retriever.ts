import { embeddingText } from '@catalogorosso/core';

import type { EvalQuery } from './dataset.js';
import { toCandidate, type SeededCatalog, type SeededProduct } from './seed.js';

/**
 * Ranked retrieval for one query, best first (P1-46).
 *
 * **A seam, not a call to the real retrieval function**, because P2-18 to P2-20
 * are not built yet. The harness scores whatever ranking it is handed; the
 * hybrid retrieval plugs in here when it lands, and recall@8 means something
 * from then on.
 */
export type Retriever = (
  catalog: SeededCatalog,
  query: EvalQuery,
) => Promise<readonly SeededProduct[]>;

/**
 * Words that match nearly every wine and so rank nothing: function words, and
 * the vocabulary every embedding text carries — `euro` is in every price band.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'con',
  'che',
  'del',
  'dei',
  'della',
  'delle',
  'degli',
  'per',
  'tra',
  'fra',
  'una',
  'uno',
  'non',
  'piu',
  'sotto',
  'euro',
  'vino',
  'vini',
  'qualcosa',
  'the',
  'and',
  'for',
  'with',
  'wine',
  'under',
]);

/** Lowercase words with accents removed, dropping words of two letters or fewer and stopwords. */
export const terms = (text: string): string[] =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));

/**
 * A deterministic keyword retriever over each wine's embedding text (P1-46).
 *
 * **A stand-in, so CI runs the harness end to end with no model and no
 * database, and its recall is not a finding about anything that will ship.**
 * It ranks wines by how many of the query's words their embedding text
 * contains, ties in catalogue order, and returns only wines sharing at least
 * one word — so a question the catalogue cannot answer can reach the model
 * with no candidates, which is what the honesty score exists to exercise.
 */
export const lexicalRetriever: Retriever = (catalog, query) => {
  const wanted = [...new Set(terms(query.query))];

  const ranked = catalog.products
    .map((seeded, order) => {
      const words = new Set(terms(embeddingText(toCandidate(seeded))));
      return { seeded, order, score: wanted.filter((word) => words.has(word)).length };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ seeded }) => seeded);

  return Promise.resolve(ranked);
};
