import { describe, expect, it } from 'vitest';

import {
  parseAlcohol,
  parseLocaleNumber,
  parseWholeNumber,
} from '../src/features/catalog/number.js';
import { parsePriceToCents } from '../src/features/catalog/price.js';

/**
 * Locale-tolerant numbers (P1-20).
 *
 * **The ambiguous case is the important assertion**, as the row says: every
 * other row here is a number read correctly, and that one is a number *not*
 * read, because either reading would be a plausible wrong answer by a factor
 * of a thousand.
 */

describe('the row’s price table', () => {
  it.each([
    ['12,50', 1250],
    ['12.50', 1250],
    ['1.234,56', 123_456],
    ['1,234.56', 123_456],
    ['1000', 100_000],
    ['€ 12,50', 1250],
  ])('reads %s as %i cents', (input, cents) => {
    expect(parsePriceToCents(input)).toEqual({ ok: true, cents });
  });

  it('refuses 12,345 as ambiguous rather than guessing', () => {
    expect(parsePriceToCents('12,345')).toEqual({ ok: false, reason: 'ambiguous' });
  });
});

describe('parseLocaleNumber', () => {
  it.each([
    ['1.234.567', 0, 1_234_567],
    ['1,234,567', 0, 1_234_567],
    ['1.234.567,5', 2, 123_456_750],
    ['0,5', 2, 50],
    [',5', 2, 50],
    ['7', 2, 700],
    [' 1 234,50 ', 2, 123_450],
  ])('reads %j at %i decimals as %i units', (input, digits, units) => {
    expect(parseLocaleNumber(input, digits)).toEqual({ ok: true, units });
  });

  it.each([
    ['1.000', 0, 'ambiguous'],
    ['12,345', 2, 'ambiguous'],
    ['12,5', 0, 'too-precise'],
    ['12,505', 2, 'ambiguous'],
    ['1.234,567', 2, 'too-precise'],
    ['1.23.456', 0, 'not-a-number'],
    ['1,234.567.8', 2, 'not-a-number'],
    ['12.34,5.6', 2, 'not-a-number'],
    ['1.2345,6', 2, 'not-a-number'],
    ['12,', 2, 'not-a-number'],
    ['.', 2, 'not-a-number'],
    ['-3', 0, 'negative'],
    ['dodici', 0, 'not-a-number'],
    ['', 0, 'empty'],
    ['9'.repeat(20), 0, 'not-a-number'],
  ])('refuses %j at %i decimals as %s', (input, digits, reason) => {
    expect(parseLocaleNumber(input, digits)).toEqual({ ok: false, reason });
  });
});

describe('parseWholeNumber', () => {
  it.each([
    ['24', 24],
    ['2019', 2019],
    ['1.000.000', 1_000_000],
    ['0', 0],
  ])('reads %s', (input, value) => {
    expect(parseWholeNumber(input)).toEqual({ ok: true, value });
  });

  it('refuses 1.000 bottles, which Number() reads as one', () => {
    // The bug this replaces in the form: `Number('1.000')` is 1.
    expect(Number('1.000')).toBe(1);
    expect(parseWholeNumber('1.000')).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('refuses a count with decimals', () => {
    expect(parseWholeNumber('12,5')).toEqual({ ok: false, reason: 'too-precise' });
  });
});

describe('parseAlcohol', () => {
  it.each([
    ['13,5', '13.50'],
    ['13.5 %', '13.50'],
    ['14% vol', '14.00'],
    ['14,5% Vol.', '14.50'],
    ['0', '0.00'],
    ['99,99', '99.99'],
  ])('reads %j as %s', (input, value) => {
    expect(parseAlcohol(input)).toEqual({ ok: true, value });
  });

  it.each([
    ['100', 'out-of-range'],
    ['13,555', 'ambiguous'],
    ['13,5555', 'too-precise'],
    ['forte', 'not-a-number'],
  ])('refuses %j as %s', (input, reason) => {
    expect(parseAlcohol(input)).toEqual({ ok: false, reason });
  });
});
