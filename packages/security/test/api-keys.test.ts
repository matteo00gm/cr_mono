import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  hashSecretKey,
  KEY_BODY_LENGTH,
  looksLikeSecretKey,
  newPublicKey,
  newSecretKey,
  PUBLIC_KEY_PREFIX,
  SECRET_KEY_PREFIX,
  secretKeyHint,
} from '../src/api-keys.js';
import { scrubString } from '../src/redact.js';

/**
 * The keys a seller integrates with (P4-09, ADR 0025).
 *
 * **The generator is the whole of the security argument**, and that is why
 * most of this file is about it. ADR 0025 hashes a secret key with SHA-256
 * rather than a slow KDF on the grounds that the key has 256 bits nobody
 * chose. The moment it had fewer, that decision would quietly become wrong —
 * and nothing about the hash would tell anybody. These cases are what would.
 */

describe('a secret key', () => {
  it('carries our prefix, so a scanner and a person can both recognise it', () => {
    expect(newSecretKey().startsWith(SECRET_KEY_PREFIX)).toBe(true);
  });

  it('has a body long enough to carry 256 bits', () => {
    /*
     * 43 characters from a 62-character alphabet is 43 × log₂62 ≈ 256.03
     * bits. Asserted as arithmetic rather than as a length, so a shorter body
     * fails for the reason it matters rather than because a number changed.
     */
    const body = newSecretKey().slice(SECRET_KEY_PREFIX.length);

    expect(body.length).toBe(KEY_BODY_LENGTH);
    expect(body.length * Math.log2(62)).toBeGreaterThanOrEqual(256);
  });

  it('uses only base62, so nothing about pasting it needs quoting', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(newSecretKey().slice(SECRET_KEY_PREFIX.length)).toMatch(/^[0-9A-Za-z]+$/u);
    }
  });

  it('draws on the whole alphabet, so no character is missing from the space', () => {
    /*
     * A generator that could only emit, say, lowercase would still pass the
     * alphabet check above while carrying 43 × log₂26 ≈ 202 bits. Across a few
     * thousand characters every one of the 62 turns up.
     */
    const seen = new Set(
      Array.from({ length: 100 }, () => newSecretKey().slice(SECRET_KEY_PREFIX.length))
        .join('')
        .split(''),
    );

    expect(seen.size).toBe(62);
  });

  it('draws evenly, rather than favouring the first few characters', () => {
    /*
     * `% 62` on a raw byte makes `0`–`7` about 25% likelier than the rest —
     * 256 is four 62s and eight over — and a bias in a secret is lost entropy.
     *
     * **Summed over those eight characters, because one character is noise.**
     * The first version compared the count of `0` alone against a threshold,
     * and at that sample size the bias sat about half a standard deviation
     * above it: the mutation that removed rejection sampling survived about a
     * third of the time. The eight together sit roughly ten deviations apart.
     */
    const counts = new Map<string, number>();
    const keys = 1000;

    for (let index = 0; index < keys; index += 1) {
      for (const character of newSecretKey().slice(SECRET_KEY_PREFIX.length)) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }

    const expected = (keys * KEY_BODY_LENGTH) / 62;
    const favoured = ['0', '1', '2', '3', '4', '5', '6', '7'].reduce(
      (sum, character) => sum + (counts.get(character) ?? 0),
      0,
    );

    /* Unbiased: ~5,548 ± 74. Biased: ~6,719. The line sits between with room. */
    expect(favoured).toBeLessThan(8 * expected * 1.08);
    expect(favoured).toBeGreaterThan(8 * expected * 0.92);
  });

  it('is different every time', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newSecretKey()));

    expect(keys.size).toBe(200);
  });

  it('is scrubbed whole by the log redaction', () => {
    /*
     * **The test that ties the generator to the logger.** The redaction matches
     * `[A-Za-z0-9]{8,}` after the prefix. A key with a character outside that
     * — a `-`, a `_` — would end the match there and log everything after it
     * in the clear, and the redaction's own tests would still pass.
     */
    const key = newSecretKey();
    const scrubbed = scrubString(`calling the api with ${key} failed`);

    expect(scrubbed).not.toContain(
      key.slice(SECRET_KEY_PREFIX.length, SECRET_KEY_PREFIX.length + 8),
    );
    expect(scrubbed).not.toContain(key.slice(-8));
  });
});

describe('a public key', () => {
  it('carries its own prefix, never the secret one', () => {
    const key = newPublicKey();

    expect(key.startsWith(PUBLIC_KEY_PREFIX)).toBe(true);
    expect(key.startsWith(SECRET_KEY_PREFIX)).toBe(false);
  });

  it('is long enough that nobody scans for live ones', () => {
    /* Public, but unique across every tenant, and a key that could be guessed
     * could be targeted. 24 base62 characters is ~143 bits. */
    expect(newPublicKey().slice(PUBLIC_KEY_PREFIX.length).length * Math.log2(62)).toBeGreaterThan(
      128,
    );
  });

  it('is never mistaken for a secret key', () => {
    expect(looksLikeSecretKey(newPublicKey())).toBe(false);
  });
});

describe('what is stored in place of a secret key', () => {
  it('is the SHA-256 of the whole key, in hex', () => {
    const key = newSecretKey();

    expect(hashSecretKey(key)).toBe(createHash('sha256').update(key).digest('hex'));
    expect(hashSecretKey(key)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is the same every time for the same key, so it can be looked up', () => {
    /* Deterministic on purpose (ADR 0025): P4-10 finds a presented key with one
     * indexed equality read, and a salted hash cannot be found by value. */
    const key = newSecretKey();

    expect(hashSecretKey(key)).toBe(hashSecretKey(key));
  });

  it('shares nothing visible with the key', () => {
    const key = newSecretKey();
    const hash = hashSecretKey(key);

    expect(hash).not.toContain(key.slice(SECRET_KEY_PREFIX.length, SECRET_KEY_PREFIX.length + 6));
    expect(hash.includes(SECRET_KEY_PREFIX)).toBe(false);
  });

  it('differs for keys that differ in one character', () => {
    const key = newSecretKey();
    const other = `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`;

    expect(hashSecretKey(other)).not.toBe(hashSecretKey(key));
  });
});

describe('the hint shown on the dashboard', () => {
  it('is the prefix, four characters, and the last four', () => {
    const key = `${SECRET_KEY_PREFIX}${'A'.repeat(4)}${'x'.repeat(35)}WXYZ`;

    expect(secretKeyHint(key)).toEqual({ prefix: 'sk_live_AAAA', last4: 'WXYZ' });
  });

  it('discloses far less than the key carries', () => {
    /* Eight characters of forty-three: 48 bits shown, 208 left. What "which of
     * my keys is this?" costs, and no more. */
    const key = newSecretKey();
    const { prefix, last4 } = secretKeyHint(key);
    const shown = prefix.length - SECRET_KEY_PREFIX.length + last4.length;

    expect((KEY_BODY_LENGTH - shown) * Math.log2(62)).toBeGreaterThan(200);
  });
});

describe('recognising the shape of a secret key', () => {
  it('accepts what the generator makes', () => {
    expect(looksLikeSecretKey(newSecretKey())).toBe(true);
  });

  it.each([
    ['a public key', () => newPublicKey()],
    ['a short one', () => `${SECRET_KEY_PREFIX}abc`],
    ['one a character long', () => `${newSecretKey()}a`],
    ['one with a hyphen', () => `${newSecretKey().slice(0, -1)}-`],
    ['a test key', () => newSecretKey().replace('_live_', '_test_')],
    ['nothing at all', () => ''],
    ['one with whitespace around it', () => ` ${newSecretKey()} `],
  ])('refuses %s', (_name, make) => {
    expect(looksLikeSecretKey(make())).toBe(false);
  });
});
