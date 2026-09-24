/**
 * What a visitor volunteers, removed before it goes anywhere (P2-33, §1.4).
 *
 * **Visitors hand over contact details unprompted.** "Send the list to
 * mario@example.com" is a perfectly natural thing to type at a shop's chat box,
 * and none of it should reach a model, a provider's logs, or a transcript that
 * lives ninety days.
 *
 * **Redacted once, at the entry point.** The same string is embedded, put in
 * the prompt and stored as the visitor's message (P2-30), so redacting at each
 * of those is three chances for one of them to be added later without it.
 *
 * **Replaced, not deleted.** "Chiama il [omesso]" still reads as a sentence and
 * still says what the visitor wanted; deleting leaves "Chiama il" and a model
 * that will do its best with it.
 *
 * **Over-redaction is the failure that breaks the product**, and it is the one
 * nobody reports: a vintage is four digits, a price has digits, and half the
 * wines in Italy have a number in the name. Every pattern here is anchored so
 * those survive, and the suite says so case by case.
 */

/** What stands in for something removed. Italian, because the visitor's message is. */
export const OMITTED = '[omesso]';

/**
 * An email address.
 *
 * Deliberately not RFC 5322 — that grammar matches things nobody types and
 * misses things everybody does. What is wanted is "looks like somebody's
 * address", and a local part, an `@`, a dotted domain and a two-letter-plus
 * suffix is that.
 */
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/giu;

/**
 * Italian codice fiscale: six letters, two digits, a letter, two digits, a
 * letter, three digits and a check letter.
 *
 * Specific enough to need no guard: nothing else in a wine question has that
 * shape, and a partial match is not one.
 */
const CODICE_FISCALE = /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/giu;

/**
 * A phone number, Italian or international.
 *
 * **Requires either a `+` or at least nine digits with separators**, which is
 * what keeps a vintage and a price out of it. `2019` is four digits; `€ 24,50`
 * is four; a Milan landline written any way a person writes it is nine or more.
 */
const PHONE = /(?:\+\d[\d\s.-]{7,}\d)|(?:\b\d{2,4}[\s.-]\d{3,4}[\s.-]\d{3,4}\b)/gu;

/**
 * A long run of digits — a card number, an IBAN tail, an order reference.
 *
 * **Twelve, not sixteen.** A visitor typing a card number groups it, mistypes
 * it, or leaves off the last block, and none of those are sixteen contiguous
 * digits. Twelve is comfortably above every number a wine question legitimately
 * contains: the longest is a four-digit vintage, and a price with no separator
 * tops out at six.
 */
const LONG_DIGITS = /\b\d{12,}\b/gu;

/**
 * The order matters, and it is not arbitrary.
 *
 * An email is matched before a phone number, because an address can contain a
 * run of digits that the phone pattern would otherwise claim half of — leaving
 * the rest of the address in the message. Codice fiscale before long digits for
 * the same reason.
 */
const PATTERNS: readonly RegExp[] = [EMAIL, CODICE_FISCALE, PHONE, LONG_DIGITS];

export interface Redaction {
  /** The message with every match replaced. Safe to embed, prompt and store. */
  readonly text: string;
  /**
   * How many things were removed.
   *
   * **A count, never the values.** Reporting what was redacted would put it in
   * a log, which is the place it was being kept out of. The count is enough to
   * alert on a spike and enough to tell a suspicious support ticket from a
   * quiet one.
   */
  readonly removed: number;
}

/**
 * Removes contact details and identifiers from a visitor's message.
 *
 * Idempotent: running it twice removes nothing the second time, which matters
 * because the entry point is the only caller that *should* run it and a second
 * caller appearing is more likely than not.
 */
export const redactPii = (message: string): Redaction => {
  let removed = 0;

  const text = PATTERNS.reduce(
    (carried, pattern) =>
      carried.replace(pattern, () => {
        removed += 1;

        return OMITTED;
      }),
    message,
  );

  return { text, removed };
};
