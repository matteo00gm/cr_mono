/**
 * Money in, money out (P1-01, reused by P1-20).
 *
 * **Written once here because the import parser needs exactly this**, and two
 * implementations of "what does 12,50 mean" is how a catalogue ends up with
 * some wines priced in euros and some in cents.
 */

import { parseLocaleNumber, type NumberError } from './number.js';

/** What a price field can be wrong about. */
export type PriceError = NumberError;

/**
 * What to tell a seller about each way a price can be wrong, in Italian.
 *
 * Shared by the form (P1-01) and the grid's inline editor (P1-11), so a price
 * refused in one place is refused in the same words in the other.
 */
export const PRICE_MESSAGES: Readonly<Record<PriceError, string>> = {
  empty: 'Indica un prezzo.',
  'not-a-number': 'Scrivi solo cifre, ad esempio 12,50.',
  negative: 'Il prezzo non può essere negativo.',
  'too-precise': 'Al massimo due decimali.',
  /*
   * The ambiguous case, and the message has to *say what to write* rather than
   * report a rule. "1.234 può voler dire due cose" is a fact about parsing;
   * telling somebody to type `1234` or `1.234,00` is an instruction they can
   * follow without knowing why.
   */
  ambiguous: 'Non è chiaro se sia un separatore di migliaia: scrivi 1234 oppure 1.234,00.',
};

export type PriceResult =
  | { readonly ok: true; readonly cents: number }
  | { readonly ok: false; readonly reason: PriceError };

/**
 * Parses a typed price into integer minor units.
 *
 * **Both separators, because Italian keyboards produce the comma** and every
 * pasted spreadsheet produces whichever the exporting locale used. A form that
 * accepted only `12.50` would reject the number the seller typed and show them
 * a validation error about a format they have never used.
 *
 * **A single separator followed by exactly three digits is refused as
 * ambiguous, and that is the decision in this file worth arguing with.**
 * `1.234` is one thousand two hundred and thirty-four euro to an Italian and a
 * shade over one euro to a parser that assumed decimals — and `12,505` is
 * either a twelve-thousand-euro bottle or somebody who typed a third decimal.
 * Every rule that picks a side is silently wrong for the other, by a factor of
 * a hundred or a thousand, in the direction that still looks plausible on a
 * receipt.
 *
 * So it asks. The cost is a seller pricing a rare bottle having to write
 * `1234` or `1.234,00`; the alternative is a price that is not the one anybody
 * chose reaching a customer's cart. `1.234,56` and `1,234.56` are *not*
 * ambiguous — two different separators say which is which — and are read
 * normally.
 *
 * **A third decimal is refused rather than rounded**, for the same reason:
 * rounding turns a typo into a price.
 */
export const parsePriceToCents = (input: string): PriceResult => {
  /*
   * The rules live in `number.ts` (P1-20), shared with every other numeric
   * field; what is a price's own is the euro sign and the two decimals.
   */
  const parsed = parseLocaleNumber(input.replace(/€/g, ''), 2);
  return parsed.ok ? { ok: true, cents: parsed.units } : { ok: false, reason: parsed.reason };
};

/**
 * Minor units back into what a seller sees.
 *
 * A comma, because the form is Italian and the value has to round-trip: a price
 * shown as `12.50` and re-parsed is fine, but a price shown in one convention
 * and typed back in another is how a field drifts on every save.
 */
export const formatCents = (cents: number): string =>
  `${String(Math.trunc(cents / 100))},${String(Math.abs(cents % 100)).padStart(2, '0')}`;
