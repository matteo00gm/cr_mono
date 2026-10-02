import { describe, expect, it } from 'vitest';

import {
  THEMES,
  themesOf,
  ZERO_RESULT_KINDS,
  ZERO_RESULTS_LIMIT,
  zeroResultOf,
} from '../../src/analytics/zero-results.js';

/**
 * Why an answer showed no wine, and the patterns across the questions
 * (P6-04). Which answers those are is counted against Postgres in
 * `zero-results.integration.test.ts`.
 */

const ids = (question: string) => themesOf(question).map((theme) => theme.id);

describe('zeroResultOf', () => {
  it('is nothing for an answer that showed a wine', () => {
    expect(zeroResultOf({ outcome: 'ok', cards: 1, wordMatches: 0 })).toBeNull();
  });

  it('is no match when no candidate used the question’s words', () => {
    expect(zeroResultOf({ outcome: 'ok', cards: 0, wordMatches: 0 })).toBe('no_match');
  });

  it('is not recommended when some did, and none was chosen', () => {
    expect(zeroResultOf({ outcome: 'ok', cards: 0, wordMatches: 3 })).toBe('not_recommended');
  });

  it('counts a repaired answer as an answer', () => {
    expect(zeroResultOf({ outcome: 'repaired', cards: 0, wordMatches: 0 })).toBe('no_match');
  });

  it.each(['provider_error', 'schema_failed', 'refusal'] as const)(
    'is nothing for an answer that failed (%s): that is not a gap in the catalogue',
    (outcome) => {
      expect(zeroResultOf({ outcome, cards: 0, wordMatches: 0 })).toBeNull();
    },
  );

  it('classifies into the column’s own kinds', () => {
    expect([...ZERO_RESULT_KINDS]).toEqual(['no_match', 'not_recommended']);
  });
});

describe('themesOf', () => {
  it('finds a theme by its words, in Italian and in English', () => {
    expect(ids('Avete un passito?')).toEqual(['sweet']);
    expect(ids('something sweet for dessert')).toEqual(['sweet']);
  });

  it('matches whole words only: bio is not biondo', () => {
    expect(ids('un vino biondo')).toEqual([]);
    expect(ids('un vino bio')).toEqual(['organic']);
  });

  it('matches a phrase, across punctuation and capitals', () => {
    expect(ids('Un VIN SANTO, per favore')).toEqual(['sweet']);
    expect(ids('vino Alcohol-Free')).toEqual(['alcohol-free']);
  });

  it('reads an apostrophe as a space, as Italian writes it', () => {
    expect(ids("un po' di rosé")).toEqual(['rose']);
  });

  it('puts a question in every theme it uses, in the themes’ order', () => {
    expect(ids('un rosso dolce e frizzante')).toEqual(['sweet', 'sparkling', 'red']);
  });

  it('puts a question in none when it uses none of their words', () => {
    expect(ids('quanto costa la spedizione?')).toEqual([]);
  });

  it('has one id per theme', () => {
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(THEMES.length);
  });

  it('writes every word lowercased, as questions are compared', () => {
    for (const theme of THEMES) {
      for (const word of theme.words) expect(word, theme.id).toBe(word.toLowerCase());
    }
  });
});

describe('the list', () => {
  it('is a hundred questions at most', () => {
    expect(ZERO_RESULTS_LIMIT).toBe(100);
  });
});
