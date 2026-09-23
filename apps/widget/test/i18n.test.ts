import { describe, expect, it } from 'vitest';

import { en } from '../src/i18n/en.js';
import { it as italian } from '../src/i18n/it.js';
import { catalogues, format, localeFor, localeIn, LOCALES } from '../src/i18n/index.js';

/**
 * Two locales, sixty strings, no library (P3-14).
 *
 * **The test the row asks for is the boring one**, and it is the one that
 * matters: every key exists in both catalogues. A missing translation is a
 * typecheck failure today, and a typecheck failure is one `as` away from being
 * a widget that renders `undefined` at a shopper on a seller's storefront.
 *
 * The second is §1.3's prohibition, checked against the catalogue rather than
 * against a rendering: no plan, no price, no count. It is easier to write that
 * into a sentence than to notice it in a screenshot.
 */

describe('both catalogues say the same things', () => {
  it('has every Italian key in English', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(italian).sort());
  });

  it('leaves nothing untranslated', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en.${key}`).not.toBe('');
      expect(typeof value, `en.${key}`).toBe('string');
    }
  });

  it('keeps the same placeholders in both', () => {
    /*
     * A translation that drops `{seconds}` renders a countdown that never
     * counts, and one that invents `{minutes}` renders the placeholder itself.
     */
    const placeholders = (message: string): string[] =>
      [...message.matchAll(/\{(\w+)\}/gu)].map((match) => match[1] ?? '').sort();

    for (const key of Object.keys(italian) as (keyof typeof italian)[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(italian[key]));
    }
  });

  it('names no plan, price or message count in either language', () => {
    // §1.3. A shopper is not our customer; what a winery pays is not their business.
    const forbidden = /piano|abbonament|plan|subscription|\$|€|credit|messagg|message[sd]?\b/iu;

    for (const catalogue of Object.values(catalogues)) {
      for (const [key, value] of Object.entries(catalogue)) {
        expect(value, `${key}: ${value}`).not.toMatch(forbidden);
      }
    }
  });

  it('has a catalogue for every locale it claims', () => {
    expect(Object.keys(catalogues).sort()).toEqual([...LOCALES].sort());
  });
});

describe('reading a language tag', () => {
  it('reads a bare tag', () => {
    expect(localeIn('it')).toBe('it');
  });

  it('reads a region-tagged one, which is what a browser actually sends', () => {
    expect(localeIn('en-GB')).toBe('en');
    expect(localeIn('it-CH')).toBe('it');
  });

  it('is not case-sensitive, because a tenant setting is typed by a person', () => {
    expect(localeIn('IT')).toBe('it');
  });

  it('has nothing to say about a language we do not speak', () => {
    expect(localeIn('de-DE')).toBeUndefined();
    expect(localeIn('')).toBeUndefined();
    expect(localeIn(undefined)).toBeUndefined();
  });
});

describe('which language the widget speaks', () => {
  it('prefers the visitor over the winery', () => {
    /*
     * A winery in Piemonte sets `it` and serves German tourists all summer. The
     * shop's own preference is a reasonable fallback and a poor answer for
     * somebody whose browser has been asking for English all day.
     */
    expect(localeFor('it', 'en-US')).toBe('en');
  });

  it('falls back to the winery for a language we do not have', () => {
    expect(localeFor('it', 'de-DE')).toBe('it');
  });

  it('falls back to the winery when the browser says nothing', () => {
    expect(localeFor('en', undefined)).toBe('en');
  });

  it('falls back to Italian when neither is one we speak', () => {
    // The source language, and the one the copy is reviewed in.
    expect(localeFor('de', 'fr')).toBe('it');
  });
});

describe('filling in a value', () => {
  it('replaces a placeholder', () => {
    expect(format('Riprova tra {seconds} s.', { seconds: 12 })).toBe('Riprova tra 12 s.');
  });

  it('replaces every occurrence', () => {
    expect(format('{a} e {a}', { a: 'x' })).toBe('x e x');
  });

  it('leaves a placeholder nobody filled rather than writing undefined', () => {
    /* A visible `{seconds}` is a bug somebody reports; `undefined` is one they
     * screenshot. */
    expect(format('tra {seconds} s.', {})).toBe('tra {seconds} s.');
  });

  it('does not escape, because the caller renders a text node', () => {
    /*
     * Escaping here would mean every caller trusting that it happened, and one
     * that did not would be an `innerHTML` away from what §3.7 exists to stop.
     * `notice.test.tsx` proves the rendering side.
     */
    expect(format('{x}', { x: '<b>ciao</b>' })).toBe('<b>ciao</b>');
  });
});
