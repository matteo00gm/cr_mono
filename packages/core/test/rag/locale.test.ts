import { describe, expect, it } from 'vitest';

import { MIN_SIGNALS, replyLocale, tenantLocale } from '../../src/rag/locale.js';

/**
 * Which language the reply is written in (P2-34).
 *
 * **The interesting case is the short message, not the long one.** A paragraph
 * is easy and rare; a visitor types four words. So what this suite is really
 * about is when *not* to believe the detector — because answering a Milanese
 * shop's customer in English is worse than not detecting at all.
 */

describe('a message that says which language it is', () => {
  it('answers an Italian question in Italian', () => {
    expect(replyLocale('Cosa mi consigliate per una bistecca?', 'it')).toEqual({
      locale: 'it',
      detected: true,
    });
  });

  it('answers an English question in English, in an Italian shop', () => {
    // The case that has to work for the fallback to be safe: a real signal
    // overrides the shop, or every English visitor is answered in Italian.
    expect(replyLocale('What would you recommend with steak?', 'it')).toEqual({
      locale: 'en',
      detected: true,
    });
  });

  it('answers an Italian question in Italian, in an English shop', () => {
    expect(replyLocale('Vorrei un rosso per la carne, cosa avete?', 'en').locale).toBe('it');
  });

  it('reads a question whatever case and punctuation it was typed in', () => {
    expect(replyLocale('COSA MI CONSIGLIATE?!', 'en').locale).toBe('it');
  });
});

describe('a message that does not', () => {
  it('falls back to the shop for two words', () => {
    /*
     * A three-word message is not reliably detectable, and defaulting to the
     * shop's locale is right far more often than guessing. This message has one
     * marker; one is a coin toss, because "Barolo" is Italian and is also what
     * an English speaker types.
     */
    expect(replyLocale('un Barolo', 'it')).toEqual({ locale: 'it', detected: false });
    expect(replyLocale('un Barolo', 'en')).toEqual({ locale: 'en', detected: false });
  });

  it('falls back when a message is balanced between the two', () => {
    /*
     * **Two markers each, so the signal count is satisfied and the tie is what
     * decides.** A fixture with one each would fall back for the other reason
     * and prove nothing about ties — which is what the first one did, and what
     * the mutation run caught.
     */
    expect(replyLocale('un the a per', 'it')).toEqual({ locale: 'it', detected: false });
    expect(replyLocale('un the a per', 'en')).toEqual({ locale: 'en', detected: false });
  });

  it('does not throw on an emoji-only message', () => {
    expect(replyLocale('🍷🍷🍷', 'it')).toEqual({ locale: 'it', detected: false });
  });

  it('does not throw on an empty message', () => {
    expect(replyLocale('', 'it').locale).toBe('it');
  });

  it('does not throw on punctuation alone', () => {
    expect(replyLocale('???', 'en').locale).toBe('en');
  });

  it('needs more than one signal before it is believed', () => {
    expect(MIN_SIGNALS).toBeGreaterThan(1);
  });
});

describe('the shop locale it falls back to', () => {
  it('takes the language out of a regional tag', () => {
    expect(tenantLocale('it-IT')).toBe('it');
    expect(tenantLocale('en-GB')).toBe('en');
  });

  it('answers in Italian for a language nothing supports', () => {
    /*
     * Italian rather than English: every tenant at launch is an Italian winery
     * (§1.1), so a locale nobody configured is far more likely to be a mistake
     * in an Italian shop than a real French one.
     */
    expect(tenantLocale('fr')).toBe('it');
    expect(tenantLocale('')).toBe('it');
  });

  it('is not fooled by case', () => {
    expect(tenantLocale('EN-gb')).toBe('en');
  });
});

describe('what it reports', () => {
  it('says whether the message decided it or the shop did', () => {
    // Two different facts. A run of fallbacks on a shop whose visitors write
    // English is a signal, and a boolean is the whole of what it takes to see.
    expect(replyLocale('What would you recommend?', 'it').detected).toBe(true);
    expect(replyLocale('Barolo', 'it').detected).toBe(false);
  });
});
