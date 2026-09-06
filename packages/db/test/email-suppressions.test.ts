import { describe, expect, it, vi } from 'vitest';

import {
  isSuppressed,
  suppressAddress,
  unsuppressAddress,
  type Connection,
} from '../src/email-suppressions.js';

/**
 * The suppression queries, without a database (P0-64).
 *
 * What is asserted here is the *shape*: which parameters the statement carries,
 * and how an absent detail is bound. Whether the redelivered-webhook conflict
 * actually leaves `suppressed_at` alone is a property of Postgres and is
 * asserted against a real one in `email-suppressions.integration.test.ts`.
 */

/** Captures the statement and answers with whatever rows the test wants. */
const capturing = (rows: unknown[] = []) => {
  // Held as its own reference rather than reached for as `db.execute`, which
  // `unbound-method` flags.
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve(rows);
  });
  const statements: unknown[] = [];
  const db = { execute } as unknown as Connection;

  return { statements, execute, db };
};

/**
 * The values Drizzle will bind, in order.
 *
 * A `sql` template's `queryChunks` interleaves the literal fragments with the
 * interpolated values themselves. The fragments are `StringChunk` instances,
 * which the package does not export — so they are identified by the shape that
 * distinguishes them, an object whose `value` is an array of strings. Everything
 * else in the list is a bound parameter, including `null`.
 */
const params = (statement: unknown): unknown[] =>
  ((statement as { queryChunks?: unknown[] }).queryChunks ?? []).filter(
    (chunk) =>
      !(
        typeof chunk === 'object' &&
        chunk !== null &&
        Array.isArray((chunk as { value?: unknown }).value)
      ),
  );

describe('isSuppressed', () => {
  it('is true when the address has a row', async () => {
    const { db } = capturing([{ '?column?': 1 }]);
    expect(await isSuppressed(db, 'dead@example.invalid')).toBe(true);
  });

  it('is false when it does not', async () => {
    const { db } = capturing([]);
    expect(await isSuppressed(db, 'alive@example.invalid')).toBe(false);
  });

  it('binds the address rather than interpolating it', async () => {
    // The address reaches us from a webhook payload, so it is attacker-shaped
    // text. Binding is what makes that uninteresting.
    const { db, statements } = capturing([]);
    await isSuppressed(db, "bob'--@example.invalid");

    expect(params(statements[0])).toContain("bob'--@example.invalid");
  });
});

describe('suppressAddress', () => {
  it('binds a null detail, not the string "null"', async () => {
    /*
     * `detail ?? null` is one careless edit away from `String(detail)`, and the
     * result is a column full of the word "null" for whoever is reading this
     * table to work out why a customer stopped receiving mail.
     */
    const { db, statements } = capturing();
    await suppressAddress(db, { address: 'a@example.invalid', reason: 'hard_bounce' });

    const bound = params(statements[0]);
    expect(bound).toEqual(['a@example.invalid', 'hard_bounce', null]);
  });

  it('carries the provider detail through when there is one', async () => {
    const { db, statements } = capturing();
    await suppressAddress(db, {
      address: 'a@example.invalid',
      reason: 'hard_bounce',
      detail: '550 5.1.1 user unknown',
    });

    // Kept verbatim: the person debugging a suppression needs the provider's
    // own words, not our summary of them.
    expect(params(statements[0])).toContain('550 5.1.1 user unknown');
  });
});

describe('unsuppressAddress', () => {
  it('deletes exactly one address', async () => {
    const { db, statements, execute } = capturing();
    await unsuppressAddress(db, 'recovered@example.invalid');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(params(statements[0])).toEqual(['recovered@example.invalid']);
  });
});
