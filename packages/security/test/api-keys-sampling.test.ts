import { beforeEach, describe, expect, it, vi } from 'vitest';

import { publishableKeyFixture, secretKeyFixture } from '@catalogorosso/testing';

import { newPublicKey, newSecretKey } from '../src/api-keys.js';

/**
 * The rejection sampling inside the key generator (P4-09), driven with bytes
 * this file chooses.
 *
 * **The statistical cases in `api-keys.test.ts` cannot see this bias.** Folding
 * the bytes 248–255 in with `% 62` makes eight characters one part in 248
 * likelier than the rest — lost entropy in a secret, and far too small for any
 * sample of real keys to show. So the CSPRNG is replaced here with bytes this
 * file lays out, and the key is read back character by character: which bytes
 * are kept, which are thrown away, and that a batch is used up in order before
 * another is asked for.
 *
 * **The expected keys are assembled by the shared fixtures**, never written
 * out: a whole key is a key-shaped literal whatever bytes produced it, and the
 * P0-08 scan cannot tell a test's from a real one (P0-56).
 */

const queue = vi.hoisted(() => ({ bytes: [] as number[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();

  return {
    ...actual,
    /* Hands out the next `size` bytes, and refuses to invent more: a generator
     * that asked for bytes this file did not lay out is a failure, not a hang. */
    randomBytes: (size: number) => {
      if (queue.bytes.length === 0) throw new Error('the test ran out of bytes');

      return Buffer.from(queue.bytes.splice(0, size));
    },
  };
});

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, index) => from + index);

beforeEach(() => {
  queue.bytes = [];
});

describe('the bytes a key is drawn from', () => {
  it('throws away every byte from 248 up, and keeps every byte below', () => {
    /*
     * 248 is the largest multiple of 62 a byte can hold. Each of 248–255 is
     * refused; 61, 62 and 247 are kept and land on `z`, `0` and `z` — the two
     * ends of the alphabet, reached from both sides of a multiple of 62.
     */
    queue.bytes = [...range(248, 256), 61, 62, 247, ...range(0, 21), ...range(0, 16)];

    expect(newPublicKey()).toBe(publishableKeyFixture('z0z0123456789ABCDEFGHIJK'));
  });

  it('reads a batch in order, one character per usable byte', () => {
    queue.bytes = range(0, 86);

    expect(newSecretKey()).toBe(secretKeyFixture('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg'));
  });

  it('asks for another batch when one holds too few usable bytes', () => {
    queue.bytes = [...Array.from({ length: 48 }, () => 255), ...range(0, 48)];

    expect(newPublicKey()).toBe(publishableKeyFixture('0123456789ABCDEFGHIJKLMN'));
  });
});
