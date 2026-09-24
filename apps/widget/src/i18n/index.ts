import { en } from './en.js';
import { it, type Messages } from './it.js';

/**
 * Two locales, sixty strings, no library (P3-14).
 *
 * **A flat catalogue per locale with typed keys.** An i18n library buys plural
 * rules, date formats and lazy catalogue loading; none of those are needed for
 * two languages and a handful of sentences, and all of them are paid for in a
 * bundle that runs on somebody else's storefront (§1.1).
 *
 * **Italian is the source.** `Messages` is derived from `it.ts`, so a key added
 * there and forgotten in `en.ts` fails the build.
 */

export type { Messages } from './it.js';

export const LOCALES = ['it', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'it';

export const catalogues: Readonly<Record<Locale, Messages>> = { it, en };

/** True for a locale we actually have a catalogue for. */
export const isLocale = (value: string): value is Locale =>
  (LOCALES as readonly string[]).includes(value);

/**
 * Reads a locale out of a language tag.
 *
 * `it-IT`, `en-GB` and `EN` are all things a browser and a tenant setting
 * legitimately contain, and none of them is a key in the catalogue.
 */
export const localeIn = (tag: string | undefined): Locale | undefined => {
  const primary = (tag ?? '').split('-')[0]?.toLowerCase() ?? '';

  return isLocale(primary) ? primary : undefined;
};

/**
 * Which language the widget speaks.
 *
 * **The visitor's browser wins over the tenant's default**, when we have a
 * catalogue for it. A winery in Piemonte sets `it` and serves German tourists
 * all summer; the shop's own preference is a reasonable fallback and a poor
 * answer for somebody whose browser has been asking for English all day.
 *
 * *(Deviation from P3-14, which says "overridable by detected message
 * language".)* That detection is P2-34's and it runs on the server, on a
 * message that does not exist until the visitor has already read the composer
 * — so it cannot label the button they are about to press. The browser's own
 * preference is known at mount and costs nothing. The answer still comes back
 * in the language of the question, which is the part that was ever in doubt.
 */
export const localeFor = (tenant: string, preferred?: string): Locale =>
  localeIn(preferred) ?? localeIn(tenant) ?? DEFAULT_LOCALE;

/**
 * Fills `{name}` placeholders.
 *
 * **The result is a string, and the caller renders it as a text node.** Preact
 * escapes it there, which is where escaping belongs: doing it here would mean
 * every caller trusting that it happened, and one that did not would be an
 * `innerHTML` away from the thing §3.7 exists to prevent.
 *
 * A placeholder with no value is left as written rather than replaced with
 * `undefined`, because a visible `{seconds}` is a bug somebody reports and
 * `undefined` is a bug somebody screenshots.
 */
export const format = (
  message: string,
  values: Readonly<Record<string, string | number>>,
): string =>
  message.replaceAll(/\{(\w+)\}/gu, (whole, name: string) => {
    const value = values[name];

    return value === undefined ? whole : String(value);
  });
