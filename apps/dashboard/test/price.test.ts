import { describe, expect, it } from 'vitest';

import { formatCents, parsePriceToCents } from '../src/features/catalog/price.js';

/**
 * What a typed price means (P1-01).
 *
 * **The failures here all end up in a customer's cart**, which is why a third
 * decimal is refused rather than rounded and why a thousands separator is not
 * read as a decimal point: both mistakes produce a number that looks like a
 * price and is not the one anybody chose.
 */

describe('parsePriceToCents', () => {
  it.each([
    ['12,50', 1250],
    ['12.50', 1250],
    ['12', 1200],
    ['0,99', 99],
    ['0', 0],
    ['12,5', 1250],
    [' 12,50 ', 1250],
    ['€12,50', 1250],
  ])('reads %s as %d cents', (input, cents) => {
    expect(parsePriceToCents(input)).toEqual({ ok: true, cents });
  });

  it('accepts both separators, because Italian keyboards produce the comma', () => {
    /*
     * A form that accepted only `12.50` would reject the number the seller
     * typed and show them a validation error about a format they have never
     * used.
     */
    expect(parsePriceToCents('12,50')).toEqual(parsePriceToCents('12.50'));
  });

  it.each([
    ['1.234,56', 123_456],
    ['1,234.56', 123_456],
  ])('reads %s, where two separators say which is which', (input, cents) => {
    expect(parsePriceToCents(input)).toEqual({ ok: true, cents });
  });

  it.each([['1.234'], ['1,234'], ['12,505']])('refuses %s as ambiguous', (input) => {
    /*
     * **The decision worth arguing with.** `1.234` is one thousand two hundred
     * and thirty-four euro to an Italian and a shade over one euro to a parser
     * that assumed decimals; `12,505` is either a twelve-thousand-euro bottle or
     * a third decimal somebody typed by accident. Every rule that picks a side
     * is silently wrong for the other by a factor of a hundred or a thousand —
     * in the direction that still looks plausible on a receipt.
     *
     * So it asks. A seller pricing a rare bottle writes `1234` or `1.234,00`;
     * the alternative is a price nobody chose reaching a customer's cart.
     */
    expect(parsePriceToCents(input)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('refuses a fourth decimal rather than rounding it', () => {
    /*
     * Rounding turns a typo into a price, and a price that is silently not what
     * somebody typed reaches a customer's cart.
     */
    expect(parsePriceToCents('12,5051')).toEqual({ ok: false, reason: 'too-precise' });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['gratis', 'not-a-number'],
    ['12,50 euro', 'not-a-number'],
    ['-5', 'negative'],
  ])('refuses %s as %s', (input, reason) => {
    expect(parsePriceToCents(input)).toEqual({ ok: false, reason });
  });

  it('refuses a number too large to be an exact integer', () => {
    expect(parsePriceToCents('999999999999999999').ok).toBe(false);
  });
});

describe('formatCents', () => {
  it.each([
    [1250, '12,50'],
    [99, '0,99'],
    [0, '0,00'],
    [123_456, '1234,56'],
  ])('shows %d cents as %s', (cents, shown) => {
    expect(formatCents(cents)).toBe(shown);
  });

  it('round-trips, so a field does not drift on every save', () => {
    /*
     * A price shown in one convention and typed back in another is how a value
     * changes each time somebody opens the form and saves it unedited.
     */
    for (const cents of [0, 99, 1250, 123_456]) {
      expect(parsePriceToCents(formatCents(cents))).toEqual({ ok: true, cents });
    }
  });
});
