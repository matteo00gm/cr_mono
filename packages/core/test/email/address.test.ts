import { describe, expect, it } from 'vitest';

import { looksLikeAddress, normaliseAddress } from '../../src/email/address.js';

/**
 * Address normalisation and the sanity check in front of every send (P0-64).
 *
 * Both were exercised only through `sendEmail`, by one address each way, so
 * every individual refusal in `looksLikeAddress` could be deleted with the suite
 * still green. Each one stands between a bug on our side and a guaranteed
 * bounce counted against the sending domain, which is why each is named here.
 */

describe('normaliseAddress', () => {
  it('lowercases the whole address, local part included, and trims it', () => {
    /*
     * The local part is formally case-sensitive and lowercased anyway: a
     * suppression row for `Bob@` that does not match mail to `bob@` is half a
     * suppression, which is none.
     */
    expect(normaliseAddress('  Bob.Rossi@Cantina.EXAMPLE\n')).toBe('bob.rossi@cantina.example');
  });

  it('is idempotent, so a stored address normalises to itself', () => {
    const once = normaliseAddress(' Anna@Example.com ');

    expect(normaliseAddress(once)).toBe(once);
  });
});

describe('looksLikeAddress', () => {
  it.each(['anna@cantina.example', 'anna+ordini@cantina.example', 'a@b'])(
    'accepts %s',
    (address) => {
      expect(looksLikeAddress(address)).toBe(true);
    },
  );

  it.each([
    ['', 'an empty string'],
    ['undefined', 'a template that interpolated undefined'],
    ['Cantina Rossi', 'a display name where an address belongs'],
    ['@cantina.example', 'nothing before the @'],
    ['anna@', 'nothing after the @'],
    ['anna@cantina@example', 'a second @'],
    ['anna rossi@cantina.example', 'a space'],
    ['anna\t@cantina.example', 'a tab'],
    ['anna@cantina.example\n', 'a trailing newline, which normalising would have removed'],
    ['anna@cantina.example,bob@cantina.example', 'a comma-separated list'],
    ['anna@cantina.example;bob@cantina.example', 'a semicolon-separated list'],
    ['Anna <anna@cantina.example>', 'a display name wrapped around an address'],

    /*
     * One broken rule per case, and the three above are why. A list of two
     * addresses also carries a second `@`, and a display name also carries a
     * space — so those realistic shapes kept failing with the punctuation
     * check deleted outright, which a mutation run showed. These isolate it,
     * one character each.
     */
    ['anna,rossi@cantina.example', 'a lone comma'],
    ['anna;rossi@cantina.example', 'a lone semicolon'],
    ['<anna@cantina.example', 'a lone opening angle bracket'],
    ['anna@cantina.example>', 'a lone closing angle bracket'],
  ])('refuses %j — %s', (address) => {
    expect(looksLikeAddress(address)).toBe(false);
  });
});
