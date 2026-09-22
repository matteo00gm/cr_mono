/**
 * Which language the reply is written in (P2-34, §1.4).
 *
 * **A heuristic, not a library, and the reason is the input.** `franc` and its
 * kin want a paragraph; a visitor types four words. On "un rosso per la carne"
 * a general detector is guessing, and on "steak" it is guessing about a word
 * that is spelled the same in the wine trade everywhere. Two languages and a
 * known domain make a word list better than a model of every language on earth.
 *
 * **The shop's own locale is the tie-breaker, not English.** A three-word
 * message is not reliably detectable, and a winery in Piemonte whose visitor
 * typed something ambiguous is answered in Italian far more often than not.
 * Defaulting to the tenant is right by a wide margin; defaulting to the
 * detector's best guess is right about as often as a coin.
 */

/** What a reply may be written in. Two, because two is what §1.4 scopes. */
export const SUPPORTED_LOCALES = ['it', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * How many recognised words a message needs before the detector is believed.
 *
 * **Two.** One word is a coin toss — "Barolo" is Italian and is also what an
 * English speaker types — and a detector believed on one word answers a
 * Milanese shop's customer in English because they wrote "red".
 */
export const MIN_SIGNALS = 2;

/**
 * Words that appear constantly in one language and never in the other.
 *
 * **Function words, not wine words.** Every wine word worth typing is a
 * loanword somewhere: a Londoner asks for a *rosso*, a Roman for a *blend*.
 * Articles, prepositions and pronouns are the part of a sentence a visitor
 * cannot borrow, and a short question has several.
 */
const MARKERS: Readonly<Record<SupportedLocale, ReadonlySet<string>>> = {
  it: new Set([
    'un',
    'una',
    'uno',
    'il',
    'lo',
    'la',
    'le',
    'gli',
    'per',
    'con',
    'che',
    'cosa',
    'quale',
    'mi',
    'vorrei',
    'consigli',
    'consigliate',
    'avete',
    'del',
    'della',
    'dei',
    'da',
    'di',
    'sotto',
    'senza',
    'buon',
    'buona',
    'grazie',
    'abbinare',
    'abbinamento',
  ]),
  en: new Set([
    'a',
    'an',
    'the',
    'for',
    'with',
    'what',
    'which',
    'would',
    'recommend',
    'suggest',
    'looking',
    'do',
    'you',
    'have',
    'goes',
    'pair',
    'pairing',
    'under',
    'without',
    'good',
    'please',
    'thanks',
    'something',
    'my',
    'i',
  ]),
};

/** Words, lowercased, with punctuation and everything that is not a letter dropped. */
const wordsIn = (message: string): readonly string[] =>
  message
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .filter((word) => word !== '');

export interface LocaleChoice {
  readonly locale: SupportedLocale;
  /**
   * Whether the message decided it, or the shop's locale did.
   *
   * Reported because the two are different facts: a run of `fallback` on a
   * shop whose visitors write English is a signal, and a boolean is the whole
   * of what it takes to see it.
   */
  readonly detected: boolean;
}

/** The shop's locale, narrowed to what a reply can be written in. Anything else is Italian. */
export const tenantLocale = (locale: string): SupportedLocale => {
  const base = locale.toLowerCase().split('-')[0] ?? '';

  return SUPPORTED_LOCALES.find((supported) => supported === base) ?? 'it';
};

/**
 * Which language to answer in.
 *
 * **Ties go to the shop, and so does anything short.** A message with the same
 * number of markers in both languages has told us nothing; a message with fewer
 * than `MIN_SIGNALS` has told us less. Both are the tenant's.
 */
export const replyLocale = (message: string, tenant: string): LocaleChoice => {
  const fallback = tenantLocale(tenant);
  const words = wordsIn(message);

  const italian = words.filter((word) => MARKERS.it.has(word)).length;
  const english = words.filter((word) => MARKERS.en.has(word)).length;
  const winner = Math.max(italian, english);

  if (winner < MIN_SIGNALS || italian === english) return { locale: fallback, detected: false };

  return { locale: italian > english ? 'it' : 'en', detected: true };
};
