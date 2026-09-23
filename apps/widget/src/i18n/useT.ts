import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

import { catalogues, DEFAULT_LOCALE, format, type Locale, type Messages } from './index.js';

/**
 * Reaching the catalogue from a component (P3-14).
 *
 * **A context, because the locale is decided once and read everywhere.** The
 * panel picks it at mount from the tenant's setting and the visitor's browser;
 * threading it through every component below would be the same value written
 * out four times, and the fourth is the one somebody forgets.
 *
 * **The default is Italian rather than a throw.** A component rendered outside
 * the provider is a wiring mistake, and a widget that renders the shop's own
 * language on a seller's storefront is a better failure than one that renders
 * an exception.
 */
export const MessagesContext = createContext<Messages>(catalogues[DEFAULT_LOCALE]);

/**
 * The locale tag itself, for the things a catalogue cannot hold.
 *
 * `Intl.NumberFormat` needs a language tag rather than a sentence, and a price
 * is the one string on a card that is formatted rather than translated (P3-08).
 */
export const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export const useLocale = (): Locale => useContext(LocaleContext);

export type Translate = (
  key: keyof Messages,
  values?: Readonly<Record<string, string | number>>,
) => string;

/** The translator for the locale in scope. Keys are checked; a typo is a type error. */
export const useT = (): Translate => {
  const messages = useContext(MessagesContext);

  return (key, values) => (values === undefined ? messages[key] : format(messages[key], values));
};
