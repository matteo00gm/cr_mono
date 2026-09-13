/**
 * Numbers as sellers type them (P1-20).
 *
 * **Italian writes `12,50`, and a spreadsheet exported elsewhere writes
 * `12.50`**, so every numeric field accepts both. Getting it wrong is not an
 * error anybody sees: `12,50` misread is €1.250, a hundred times the price, and
 * it reaches a visitor's cart looking entirely plausible.
 *
 * **What cannot be read with certainty is refused, never guessed.** `1.000` is
 * a thousand bottles to an Italian and one bottle to a parser that assumes a
 * decimal point; any rule that picks a side is silently wrong for the other, by
 * a factor of a thousand, in the direction that still looks like a number.
 *
 * Kept in the dashboard beside `price.ts` rather than in `packages/core` as the
 * row suggests *(deviation)*: only the browser parses what a person typed. The
 * API receives JSON numbers, so a server-side copy would be a second parser
 * with no caller.
 */

export type NumberError = 'empty' | 'not-a-number' | 'negative' | 'too-precise' | 'ambiguous';

export type LocaleNumber =
  | { readonly ok: true; readonly units: number }
  | { readonly ok: false; readonly reason: NumberError };

const count = (text: string, char: string): number => text.split(char).length - 1;

/**
 * Parses a number into integer units of `10^-fractionDigits` — cents for a
 * price, hundredths for a gradazione, whole bottles for a count.
 *
 * The rules, in order:
 *
 * 1. **Both `.` and `,` present:** the last one is the decimal separator, the
 *    other groups thousands. `1.234,56` and `1,234.56` are the same number.
 * 2. **One separator, repeated:** it can only group thousands — `1.234.567` —
 *    so every group after the first must be three digits.
 * 3. **One separator, once, followed by exactly three digits: ambiguous.**
 *    `1.000` and `12,345` are refused.
 * 4. **One separator, once, otherwise:** a decimal separator. `12,5` is 12.50.
 *
 * More decimals than the field holds are refused rather than rounded: rounding
 * turns a typo into a value.
 */
export const parseLocaleNumber = (input: string, fractionDigits: number): LocaleNumber => {
  const text = input.replace(/\s/g, '');
  if (text === '') return { ok: false, reason: 'empty' };
  if (!/^-?[\d.,]+$/.test(text)) return { ok: false, reason: 'not-a-number' };
  if (text.startsWith('-')) return { ok: false, reason: 'negative' };

  const scale = 10 ** fractionDigits;
  const finish = (whole: string, fraction: string): LocaleNumber => {
    if (whole === '' && fraction === '') return { ok: false, reason: 'not-a-number' };
    const units =
      Number(whole === '' ? '0' : whole) * scale +
      Number(fraction.padEnd(fractionDigits, '0') || '0');
    return Number.isSafeInteger(units)
      ? { ok: true, units }
      : { ok: false, reason: 'not-a-number' };
  };

  const commas = count(text, ',');
  const dots = count(text, '.');

  if (commas === 0 && dots === 0) return finish(text, '');

  if (commas > 0 && dots > 0) {
    const decimalAt = Math.max(text.lastIndexOf(','), text.lastIndexOf('.'));
    const fraction = text.slice(decimalAt + 1);
    const whole = text.slice(0, decimalAt);
    const grouping = text.charAt(decimalAt) === ',' ? '.' : ',';

    if (count(whole, text.charAt(decimalAt)) > 0) return { ok: false, reason: 'not-a-number' };
    if (!new RegExp(`^\\d{1,3}(\\${grouping}\\d{3})*$`).test(whole)) {
      return { ok: false, reason: 'not-a-number' };
    }
    if (fraction.length > fractionDigits) return { ok: false, reason: 'too-precise' };
    return finish(whole.split(grouping).join(''), fraction);
  }

  const separator = commas > 0 ? ',' : '.';

  if (commas + dots > 1) {
    // Repeated: only thousands grouping makes sense of it.
    return new RegExp(`^\\d{1,3}(\\${separator}\\d{3})+$`).test(text)
      ? finish(text.split(separator).join(''), '')
      : { ok: false, reason: 'not-a-number' };
  }

  const [whole = '', fraction = ''] = text.split(separator);

  if (fraction.length === 3) return { ok: false, reason: 'ambiguous' };
  if (fraction === '' || !/^\d*$/.test(whole)) return { ok: false, reason: 'not-a-number' };
  if (fraction.length > fractionDigits) return { ok: false, reason: 'too-precise' };

  return finish(whole, fraction);
};

export type WholeNumber =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: NumberError };

/**
 * A count or a year.
 *
 * `1.000` is refused as ambiguous and `12,5` as having decimals — where
 * `Number()`, which the form used before, reads the first as 1 and the second
 * as nothing at all.
 */
export const parseWholeNumber = (input: string): WholeNumber => {
  const parsed = parseLocaleNumber(input, 0);
  return parsed.ok ? { ok: true, value: parsed.units } : parsed;
};

export type AlcoholError = NumberError | 'out-of-range';

export type Alcohol =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: AlcoholError };

/**
 * A gradazione, as the `numeric(4,2)` string the API stores.
 *
 * Accepts what is printed on labels and in spreadsheets — `13,5`, `13.5 %`,
 * `14% vol` — and returns `13.50`. Above 99,99 is out of range for the column,
 * and a value that high is a typo, not a spirit this catalogue sells.
 */
export const parseAlcohol = (input: string): Alcohol => {
  const parsed = parseLocaleNumber(input.replace(/%|vol\.?/gi, ''), 2);
  if (!parsed.ok) return parsed;
  if (parsed.units > 9999) return { ok: false, reason: 'out-of-range' };

  const whole = Math.trunc(parsed.units / 100);
  const hundredths = String(parsed.units % 100).padStart(2, '0');

  return { ok: true, value: `${String(whole)}.${hundredths}` };
};
