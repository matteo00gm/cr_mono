import type { ProductRequest, ProductsImportedResponse } from '@catalogorosso/api-client';
import { describe, expect, it } from 'vitest';

import {
  appliedCount,
  mergeAnswers,
  remainderOf,
  wholeImport,
} from '../src/features/catalog/import-continuation.js';

/**
 * The bookkeeping behind an import sent as several requests (review fix, P1-25).
 *
 * Every number the seller reads at the end comes out of these two functions, so
 * the cases are the ways a sum or a renumbering goes quietly wrong: a repeated
 * SKU sent on its own, a second remainder numbered against the part instead of
 * the import, a stop reported by the wrong line.
 */

/** Rows only need to be told apart here; nothing reads their fields. */
const ROWS = ['A', 'B', 'C', 'D', 'E'].map((sku) => ({ sku }) as unknown as ProductRequest);

const NO_COUNTS: ProductsImportedResponse['counts'] = {
  created: 0,
  updated: 0,
  unchanged: 0,
  duplicateSku: 0,
  archived: 0,
};

const answer = (over: Partial<ProductsImportedResponse> = {}): ProductsImportedResponse => ({
  outcomes: [],
  counts: NO_COUNTS,
  stoppedAt: null,
  ...over,
});

const outOfTimeAt = (fromRow: number, toRow = fromRow) =>
  ({ batch: 2, fromRow, toRow, reason: 'time-budget' }) as const;

describe('remainderOf', () => {
  it('leaves nothing when the part finished', () => {
    expect(remainderOf(wholeImport(ROWS), answer())).toBeNull();
  });

  it('leaves a failed batch to the seller rather than retrying it', () => {
    const failed = answer({ stoppedAt: { ...outOfTimeAt(3), reason: 'failed' } });

    expect(remainderOf(wholeImport(ROWS), failed)).toBeNull();
  });

  it('carries the rows from the stop on, remembering where each sits in the import', () => {
    expect(remainderOf(wholeImport(ROWS), answer({ stoppedAt: outOfTimeAt(4, 5) }))).toEqual({
      rows: ROWS.slice(3),
      indexes: [3, 4],
    });
  });

  it('leaves out every row refused as a repeated SKU, including one whose twin applied', () => {
    const rest = remainderOf(
      wholeImport(ROWS),
      answer({
        outcomes: [
          { index: 0, outcome: 'duplicate-sku', sku: 'A' },
          { index: 3, outcome: 'duplicate-sku', sku: 'A' },
        ],
        stoppedAt: outOfTimeAt(2),
      }),
    );

    expect(rest?.indexes).toEqual([1, 2, 4]);
  });

  it('leaves nothing when every row after the stop was refused', () => {
    const refused = answer({
      outcomes: [
        { index: 3, outcome: 'duplicate-sku', sku: 'D' },
        { index: 4, outcome: 'duplicate-sku', sku: 'D' },
      ],
      stoppedAt: outOfTimeAt(4),
    });

    expect(remainderOf(wholeImport(ROWS), refused)).toBeNull();
  });

  it('numbers a second remainder against the whole import, not against its part', () => {
    const first = remainderOf(wholeImport(ROWS), answer({ stoppedAt: outOfTimeAt(3) }));
    if (first === null) throw new Error('expected a remainder');

    expect(remainderOf(first, answer({ stoppedAt: outOfTimeAt(2) }))).toEqual({
      rows: ROWS.slice(3),
      indexes: [3, 4],
    });
  });
});

describe('mergeAnswers', () => {
  it('passes the first part through unchanged', () => {
    const only = answer({
      outcomes: [{ index: 0, outcome: 'created', productId: 'p-0' }],
      counts: { ...NO_COUNTS, created: 1 },
    });

    expect(mergeAnswers(undefined, wholeImport(ROWS), only)).toEqual(only);
  });

  it('adds every count and numbers a later part’s outcomes against the import', () => {
    const first = answer({
      outcomes: [
        { index: 0, outcome: 'created', productId: 'p-0' },
        { index: 1, outcome: 'duplicate-sku', sku: 'X' },
        { index: 4, outcome: 'duplicate-sku', sku: 'X' },
      ],
      counts: { ...NO_COUNTS, created: 1, duplicateSku: 2 },
      stoppedAt: outOfTimeAt(3),
    });
    const second = answer({
      outcomes: [
        { index: 0, outcome: 'updated', productId: 'p-2', reindexed: true, archived: true },
        { index: 1, outcome: 'unchanged', productId: 'p-3', reindexed: false, archived: false },
      ],
      counts: { created: 0, updated: 1, unchanged: 1, duplicateSku: 0, archived: 1 },
    });

    const merged = mergeAnswers(
      mergeAnswers(undefined, wholeImport(ROWS), first),
      { rows: ROWS.slice(2, 4), indexes: [2, 3] },
      second,
    );

    expect(merged.counts).toEqual({
      created: 1,
      updated: 1,
      unchanged: 1,
      duplicateSku: 2,
      archived: 1,
    });
    expect(merged.outcomes.map((outcome) => [outcome.index, outcome.outcome])).toEqual([
      [0, 'created'],
      [1, 'duplicate-sku'],
      [2, 'updated'],
      [3, 'unchanged'],
      [4, 'duplicate-sku'],
    ]);
    expect(merged.stoppedAt).toBeNull();
    expect(appliedCount(merged)).toBe(3);
  });

  it('reports a later part’s stop by the lines of the whole import', () => {
    const merged = mergeAnswers(
      answer(),
      { rows: ROWS.slice(3), indexes: [3, 4] },
      answer({ stoppedAt: { batch: 1, fromRow: 2, toRow: 2, reason: 'failed' } }),
    );

    expect(merged.stoppedAt).toEqual({ batch: 1, fromRow: 5, toRow: 5, reason: 'failed' });
  });
});
